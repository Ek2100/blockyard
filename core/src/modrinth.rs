//! Search and install plugins/mods from Modrinth (docs.modrinth.com/api).
use crate::java::Log;
use crate::{net, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const API: &str = "https://api.modrinth.com/v2";

/// Modrinth loaders that run on each server software.
pub fn loaders_for(software: &str) -> Vec<&'static str> {
    match software {
        "paper" => vec!["paper", "spigot", "bukkit"],
        "purpur" => vec!["purpur", "paper", "spigot", "bukkit"],
        "fabric" => vec!["fabric"],
        "forge" => vec!["forge"],
        "neoforge" => vec!["neoforge"],
        _ => vec![],
    }
}

fn is_plugins(cfg: &Value) -> bool { cfg["kind"] == "plugins" }
fn noun(cfg: &Value) -> &'static str { if is_plugins(cfg) { "plugin" } else { "mod" } }
pub fn folder_of(cfg: &Value) -> PathBuf { Path::new(cfg["dir"].as_str().unwrap_or("")).join(if is_plugins(cfg) { "plugins" } else { "mods" }) }

pub fn facets(cfg: &Value) -> Value {
    let sw = cfg["software"].as_str().unwrap_or("");
    let mut f = vec![json!(loaders_for(sw).iter().map(|l| format!("categories:{l}")).collect::<Vec<_>>()), json!([format!("project_type:{}", noun(cfg))])];
    if let Some(v) = cfg["mcVersion"].as_str().filter(|s| !s.is_empty()) { f.push(json!([format!("versions:{v}")])); }
    if !is_plugins(cfg) { f.push(json!(["server_side:required", "server_side:optional"])); } // skip client-only mods
    Value::Array(f)
}

fn enc(s: &str) -> String { url::form_urlencoded::byte_serialize(s.as_bytes()).collect() }

pub async fn search_raw(query: &str, facets: &Value, sort: &str, offset: u64, limit: u64) -> Result<Value> {
    let index = if ["relevance", "downloads", "follows", "newest", "updated"].contains(&sort) { sort } else { "relevance" };
    let r: Value = net::get_json(&format!("{API}/search?query={}&facets={}&index={index}&offset={offset}&limit={limit}", enc(query), enc(&facets.to_string()))).await?;
    Ok(json!({
        "total": r["total_hits"].as_u64().unwrap_or(0),
        "hits": r["hits"].as_array().cloned().unwrap_or_default().iter().map(|h| json!({
            "id": h["project_id"], "slug": h["slug"], "title": h["title"], "description": h["description"], "icon": h["icon_url"],
            "downloads": h["downloads"].as_u64().unwrap_or(0), "author": h["author"],
            "categories": if h["display_categories"].is_array() { h["display_categories"].clone() } else { h["categories"].clone() },
        })).collect::<Vec<_>>(),
    }))
}

pub async fn search(cfg: &Value, opts: &Value) -> Result<Value> {
    search_raw(opts["query"].as_str().unwrap_or(""), &facets(cfg), opts["sort"].as_str().unwrap_or("relevance"), opts["offset"].as_u64().unwrap_or(0), opts["limit"].as_u64().unwrap_or(20)).await
}

/// Newest compatible version that has a file; releases beat betas beat alphas.
pub async fn best_version(cfg: &Value, project: &str) -> Result<Option<Value>> {
    let mut url = format!("{API}/project/{}/version?loaders={}", enc(project), enc(&json!(loaders_for(cfg["software"].as_str().unwrap_or(""))).to_string()));
    if let Some(v) = cfg["mcVersion"].as_str().filter(|s| !s.is_empty()) { url += &format!("&game_versions={}", enc(&json!([v]).to_string())); }
    let versions: Vec<Value> = net::get_json(&url).await.unwrap_or_default();
    let rank = |t: &Value| match t.as_str() { Some("release") => 0, Some("beta") => 1, Some("alpha") => 2, _ => 3 };
    let date = |v: &Value| chrono::DateTime::parse_from_rfc3339(v["date_published"].as_str().unwrap_or("")).map(|d| d.timestamp_millis()).unwrap_or(0);
    let mut usable: Vec<Value> = versions.into_iter().filter(|v| v["files"].as_array().is_some_and(|f| !f.is_empty())).collect();
    usable.sort_by(|a, b| rank(&a["version_type"]).cmp(&rank(&b["version_type"])).then(date(b).cmp(&date(a))));
    Ok(usable.into_iter().next())
}

async fn project_title(project: &str, fallback: &str) -> String {
    net::get_json::<Value>(&format!("{API}/project/{}", enc(project))).await.ok().and_then(|v| v["title"].as_str().map(String::from)).unwrap_or_else(|| fallback.to_string())
}

/// Download one file into `folder`, checking its sha512, replacing `old` (a previous file name) if different.
pub async fn fetch_verified(url: &str, sha512: Option<&str>, folder: &Path, name: &str) -> Result<()> {
    std::fs::create_dir_all(folder)?;
    let tmp = folder.join(format!(".{name}.download"));
    let r: Result<()> = async {
        net::download(url, &tmp, |_, _| {}).await?;
        if let Some(want) = sha512 {
            if net::sha512_file(&tmp)? != want.to_lowercase() { crate::bail!("{name} failed its checksum check (the download was corrupted or tampered with), so it wasn’t installed."); }
        }
        std::fs::rename(&tmp, folder.join(name))?;
        Ok(())
    }.await;
    let _ = std::fs::remove_file(&tmp);
    r
}

/// Install a project plus its required dependencies into plugins/ or mods/.
/// `installed` (projectId → {file, versionId, version, title}) is updated in place.
pub fn install<'a>(cfg: &'a Value, project: &'a str, installed: &'a mut serde_json::Map<String, Value>, log: &'a Log, depth: u32, seen: &'a mut Vec<String>) -> futures_util::future::BoxFuture<'a, Result<Vec<Value>>> {
    Box::pin(async move {
        if seen.iter().any(|s| s == project) { return Ok(vec![]); }
        seen.push(project.to_string());
        let Some(v) = best_version(cfg, project).await? else {
            let msg = format!("No version of this {} supports {} {}.", noun(cfg), cfg["software"].as_str().unwrap_or(""), cfg["mcVersion"].as_str().unwrap_or("")).replace(" .", ".");
            if depth == 0 { crate::bail!("{msg}"); }
            log(format!("Skipped a dependency ({project}): {msg}"), None);
            return Ok(vec![]);
        };
        let title = project_title(project, if depth == 0 { v["name"].as_str().unwrap_or(project) } else { project }).await;
        if depth > 0 { log(format!("Installing required dependency {title}…"), None); }
        let files = v["files"].as_array().cloned().unwrap_or_default();
        let file = files.iter().find(|f| f["primary"] == true).unwrap_or(&files[0]).clone();
        let name = Path::new(file["filename"].as_str().unwrap_or("addon.jar")).file_name().unwrap_or_default().to_string_lossy().into_owned();
        let folder = folder_of(cfg);
        std::fs::create_dir_all(&folder)?;
        let prev = installed.get(project).cloned();
        let up_to_date = prev.as_ref().is_some_and(|p| p["versionId"] == v["id"]) && (folder.join(&name).exists() || folder.join(format!("{name}.disabled")).exists());
        if up_to_date {
            log(format!("{title} is already up to date."), None);
        } else {
            log(format!("Downloading {name}…"), None);
            fetch_verified(file["url"].as_str().unwrap_or(""), file["hashes"]["sha512"].as_str(), &folder, &name).await?;
            if let Some(old) = prev.as_ref().and_then(|p| p["file"].as_str()).filter(|f| *f != name) {
                let old = Path::new(old).file_name().unwrap_or_default().to_string_lossy().into_owned();
                for f in [old.clone(), format!("{old}.disabled")] { let _ = std::fs::remove_file(folder.join(f)); }
            }
        }
        installed.insert(project.to_string(), json!({ "file": name, "versionId": v["id"], "version": v["version_number"], "title": title }));
        let mut results = vec![json!({ "projectId": project, "file": name, "version": v["version_number"], "title": title })];
        if depth < 4 {
            for dep in v["dependencies"].as_array().cloned().unwrap_or_default() {
                let Some(pid) = dep["project_id"].as_str() else { continue };
                if dep["dependency_type"] != "required" { continue; }
                results.extend(install(cfg, pid, installed, log, depth + 1, seen).await?);
            }
        }
        Ok(results)
    })
}

/// Projects in `cfg.modrinth` whose file is still in the folder.
pub fn installed_map(cfg: &Value) -> serde_json::Map<String, Value> {
    let folder = folder_of(cfg);
    cfg["modrinth"].as_object().cloned().unwrap_or_default().into_iter().filter(|(_, v)| {
        let f = v["file"].as_str().unwrap_or("");
        !f.is_empty() && (folder.join(f).exists() || folder.join(format!("{f}.disabled")).exists())
    }).collect()
}
