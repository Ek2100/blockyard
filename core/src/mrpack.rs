//! Modpacks in Modrinth's .mrpack format: a zip with modrinth.index.json (which files to download,
//! with hashes) plus "overrides" folders (configs etc.). Client-only mods are skipped for servers.
use crate::java::Log;
use crate::{archive, net, Result};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Hosts the .mrpack spec allows launchers to download from.
pub const ALLOWED_HOSTS: &[&str] = &["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

#[derive(Debug, Clone)]
pub struct PackFile { pub path: String, pub url: String, pub sha512: Option<String>, pub sha1: Option<String>, pub size: u64 }

#[derive(Debug, Clone)]
pub struct Pack {
    pub name: String,
    pub version: String,
    pub summary: String,
    pub mc_version: String,
    pub software: String,
    pub loader: Option<String>,
    pub files: Vec<PackFile>,
    pub skipped_client_only: usize,
}

/// A path inside the server folder that a pack may write to (no absolute paths, no "..").
pub fn safe_rel(p: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    if p.is_empty() || p.starts_with('/') || p.contains(':') || p.split('/').any(|s| s == ".." || s.is_empty() && false) { return None; }
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if parts.is_empty() || parts.contains(&"..") { return None; }
    Some(parts.join("/"))
}

pub fn allowed_url(u: &str) -> bool {
    url::Url::parse(u).ok().is_some_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| ALLOWED_HOSTS.contains(&h)))
}

pub fn parse_index(v: &Value) -> Result<Pack> {
    if v["game"].as_str().unwrap_or("minecraft") != "minecraft" { crate::bail!("This modpack isn't for Minecraft: Java Edition."); }
    let deps = &v["dependencies"];
    let mc = deps["minecraft"].as_str().ok_or_else(|| anyhow::anyhow!("This modpack doesn't say which Minecraft version it needs."))?.to_string();
    let (software, loader) = if let Some(l) = deps["neoforge"].as_str() { ("neoforge", Some(l)) }
        else if let Some(l) = deps["forge"].as_str() { ("forge", Some(l)) }
        else if let Some(l) = deps["fabric-loader"].as_str() { ("fabric", Some(l)) }
        else if deps["quilt-loader"].is_string() { crate::bail!("Quilt modpacks can't run on a Blockyard server yet. Fabric, Forge and NeoForge packs work.") }
        else { ("vanilla", None) };
    let mut files = vec![];
    let mut skipped = 0;
    for f in v["files"].as_array().cloned().unwrap_or_default() {
        if f["env"]["server"] == "unsupported" { skipped += 1; continue; }
        let path = f["path"].as_str().and_then(safe_rel).ok_or_else(|| anyhow::anyhow!("This modpack contains an unsafe file path ({}), so it wasn't installed.", f["path"]))?;
        let url = f["downloads"].as_array().and_then(|d| d.iter().filter_map(|u| u.as_str()).find(|u| allowed_url(u)).map(String::from))
            .ok_or_else(|| anyhow::anyhow!("{path} would be downloaded from a site modpacks aren't allowed to use, so the pack wasn't installed."))?;
        let sha512 = f["hashes"]["sha512"].as_str().map(|s| s.to_lowercase());
        let sha1 = f["hashes"]["sha1"].as_str().map(|s| s.to_lowercase());
        if sha512.is_none() && sha1.is_none() { crate::bail!("{path} has no checksum in the modpack, so it wasn't installed."); }
        files.push(PackFile { path, url, sha512, sha1, size: f["fileSize"].as_u64().unwrap_or(0) });
    }
    Ok(Pack {
        name: v["name"].as_str().unwrap_or("Modpack").to_string(), version: v["versionId"].as_str().unwrap_or("").to_string(),
        summary: v["summary"].as_str().unwrap_or("").to_string(), mc_version: mc, software: software.into(), loader: loader.map(String::from),
        files, skipped_client_only: skipped,
    })
}

/// Read a .mrpack's index.
pub fn read(mrpack: &Path) -> Result<Pack> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(mrpack)?).map_err(|_| anyhow::anyhow!("That file isn't a valid .mrpack modpack."))?;
    let mut text = String::new();
    z.by_name("modrinth.index.json").map_err(|_| anyhow::anyhow!("That file isn't a Modrinth modpack (no modrinth.index.json)."))?.read_to_string(&mut text)?;
    parse_index(&serde_json::from_str(&text)?)
}

/// Download the pack's server files (verified) and copy its overrides into `dir`.
pub async fn install(pack: &Pack, mrpack: &Path, dir: &Path, log: &Log) -> Result<()> {
    let total = pack.files.len();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut set = tokio::task::JoinSet::new();
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(6));
    for f in pack.files.clone() {
        let (dir, sem, done, log) = (dir.to_path_buf(), sem.clone(), done.clone(), log.clone());
        set.spawn(async move {
            let _p = sem.acquire().await;
            let dest = dir.join(&f.path);
            let tmp = dest.with_file_name(format!(".{}.download", dest.file_name().unwrap_or_default().to_string_lossy()));
            let r: Result<()> = async {
                net::download(&f.url, &tmp, |_, _| {}).await?;
                let ok = match (&f.sha512, &f.sha1) {
                    (Some(h), _) => net::sha512_file(&tmp)? == *h,
                    (None, Some(h)) => net::sha1_file(&tmp)? == *h,
                    _ => false,
                };
                if !ok { crate::bail!("{} failed its checksum check, so the modpack wasn't installed.", f.path); }
                std::fs::rename(&tmp, &dest)?;
                Ok(())
            }.await;
            if r.is_err() { let _ = std::fs::remove_file(&tmp); }
            let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            log(format!("Downloaded {n} of {total} files ({})", f.path.rsplit('/').next().unwrap_or("")), Some(n as f64 / total.max(1) as f64));
            r
        });
    }
    while let Some(r) = set.join_next().await {
        if let Err(e) = r? { set.abort_all(); return Err(e); }
    }
    log("Copying the modpack's settings…".into(), None);
    let (zip, d) = (mrpack.to_path_buf(), dir.to_path_buf());
    tokio::task::spawn_blocking(move || copy_overrides(&zip, &d)).await??;
    Ok(())
}

/// overrides/ first, then server-overrides/ (which win).
fn copy_overrides(mrpack: &Path, dir: &Path) -> Result<usize> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(mrpack)?)?;
    let mut n = 0;
    for prefix in ["overrides/", "server-overrides/"] {
        for i in 0..z.len() {
            let mut f = z.by_index(i)?;
            let name = f.name().to_string();
            let Some(rel) = name.strip_prefix(prefix) else { continue };
            if rel.is_empty() || f.is_dir() { continue; }
            let Some(out) = safe_rel(rel).and_then(|r| archive::entry_path(dir, &r)) else { continue };
            if let Some(p) = out.parent() { std::fs::create_dir_all(p)?; }
            std::io::copy(&mut f, &mut std::fs::File::create(&out)?)?;
            n += 1;
        }
    }
    Ok(n)
}

/// The .mrpack of a modpack's newest release on Modrinth (downloaded to `into`).
pub async fn download_from_modrinth(project: &str, into: &Path, log: &Log) -> Result<PathBuf> {
    let enc: String = url::form_urlencoded::byte_serialize(project.as_bytes()).collect();
    let versions: Vec<Value> = net::get_json(&format!("{}/project/{enc}/version", crate::modrinth::API)).await?;
    let pick = versions.iter().find(|v| v["version_type"] == "release").or(versions.first())
        .ok_or_else(|| anyhow::anyhow!("That modpack has no versions to download."))?;
    let files = pick["files"].as_array().cloned().unwrap_or_default();
    let file = files.iter().find(|f| f["primary"] == true && f["filename"].as_str().is_some_and(|n| n.ends_with(".mrpack")))
        .or_else(|| files.iter().find(|f| f["filename"].as_str().is_some_and(|n| n.ends_with(".mrpack"))))
        .ok_or_else(|| anyhow::anyhow!("That modpack version has no .mrpack file."))?;
    let url = file["url"].as_str().unwrap_or("");
    if !allowed_url(url) { crate::bail!("That modpack is hosted somewhere Blockyard doesn't download from."); }
    log(format!("Downloading {} {}…", pick["name"].as_str().unwrap_or("modpack"), pick["version_number"].as_str().unwrap_or("")), None);
    std::fs::create_dir_all(into)?;
    let dest = into.join("pack.mrpack");
    net::download(url, &dest, |_, _| {}).await?;
    if let Some(h) = file["hashes"]["sha512"].as_str() {
        if net::sha512_file(&dest)? != h.to_lowercase() { crate::bail!("The modpack download failed its checksum check."); }
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn index_rules() {
        let v = json!({ "game": "minecraft", "name": "Cozy", "versionId": "1.2", "dependencies": { "minecraft": "1.20.1", "forge": "47.3.0" },
            "files": [
                { "path": "mods/a.jar", "hashes": { "sha512": "AB", "sha1": "cd" }, "env": { "client": "required", "server": "required" }, "downloads": ["https://evil.example/a.jar", "https://cdn.modrinth.com/a.jar"] },
                { "path": "mods/shader.jar", "hashes": { "sha1": "x" }, "env": { "client": "required", "server": "unsupported" }, "downloads": ["https://cdn.modrinth.com/s.jar"] },
                { "path": "config/b.toml", "hashes": { "sha1": "ef" }, "downloads": ["https://github.com/x/b.toml"] },
            ] });
        let p = parse_index(&v).unwrap();
        assert_eq!((p.software.as_str(), p.loader.as_deref(), p.mc_version.as_str()), ("forge", Some("47.3.0"), "1.20.1"));
        assert_eq!(p.files.len(), 2);
        assert_eq!(p.skipped_client_only, 1);
        assert_eq!(p.files[0].url, "https://cdn.modrinth.com/a.jar");
        assert_eq!(p.files[0].sha512.as_deref(), Some("ab"));
        let bad_path = json!({ "dependencies": { "minecraft": "1.20.1" }, "files": [{ "path": "../../.bashrc", "hashes": { "sha1": "x" }, "downloads": ["https://cdn.modrinth.com/x"] }] });
        assert!(parse_index(&bad_path).is_err());
        let bad_host = json!({ "dependencies": { "minecraft": "1.20.1" }, "files": [{ "path": "mods/x.jar", "hashes": { "sha1": "x" }, "downloads": ["http://cdn.modrinth.com/x", "https://evil.example/x"] }] });
        assert!(parse_index(&bad_host).is_err());
        assert!(parse_index(&json!({ "dependencies": { "minecraft": "1.20.1", "quilt-loader": "0.1" } })).is_err());
        assert_eq!(parse_index(&json!({ "dependencies": { "minecraft": "1.21.1", "neoforge": "21.1.77" } })).unwrap().software, "neoforge");
        assert_eq!(parse_index(&json!({ "dependencies": { "minecraft": "1.21.1", "fabric-loader": "0.16.5" } })).unwrap().loader.as_deref(), Some("0.16.5"));
        assert_eq!(safe_rel("mods/./x.jar").as_deref(), Some("mods/x.jar"));
        assert!(safe_rel("/etc/x").is_none() && safe_rel("C:/x").is_none() && safe_rel("a/../../b").is_none());
    }
}
