//! Server software catalogue: listing versions and installing each kind of server.
use crate::java::Log;
use crate::versions::{compare, is_release, sort_desc};
use crate::{net, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub struct Software { pub id: &'static str, pub label: &'static str, pub kind: &'static str, pub blurb: &'static str }

pub const SOFTWARE: &[Software] = &[
    Software { id: "paper", label: "Paper", kind: "plugins", blurb: "Fast and stable, runs Bukkit/Spigot plugins. Best pick for most servers." },
    Software { id: "purpur", label: "Purpur", kind: "plugins", blurb: "Paper with extra gameplay and config options. Runs plugins." },
    Software { id: "vanilla", label: "Vanilla", kind: "none", blurb: "The official Mojang server. No plugins or mods." },
    Software { id: "fabric", label: "Fabric", kind: "mods", blurb: "Lightweight mod loader. Great for performance and modern mods." },
    Software { id: "forge", label: "Forge", kind: "mods", blurb: "The classic mod loader. Needed for many older modpacks." },
    Software { id: "neoforge", label: "NeoForge", kind: "mods", blurb: "Modern fork of Forge. Most new big modpacks use it." },
];

pub fn get(id: &str) -> Result<&'static Software> {
    SOFTWARE.iter().find(|s| s.id == id).ok_or_else(|| anyhow::anyhow!("Unknown server software: {id}"))
}

pub fn catalogue() -> Value {
    Value::Array(SOFTWARE.iter().map(|s| json!({ "id": s.id, "label": s.label, "kind": s.kind, "blurb": s.blurb })).collect())
}

// ---------- Mojang ----------
const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
static MANIFEST_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

pub async fn mojang_manifest() -> Result<Value> {
    if let Some((at, v)) = MANIFEST_CACHE.lock().unwrap().as_ref() { if at.elapsed() < Duration::from_secs(600) { return Ok(v.clone()); } }
    let v: Value = net::get_json(MANIFEST).await?;
    *MANIFEST_CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    Ok(v)
}

pub async fn mojang_version(mc: &str) -> Result<Value> {
    let m = mojang_manifest().await?;
    let url = m["versions"].as_array().and_then(|l| l.iter().find(|v| v["id"] == mc)).and_then(|v| v["url"].as_str())
        .ok_or_else(|| anyhow::anyhow!("Minecraft {mc} isn't in Mojang's version list."))?;
    net::get_json(url).await
}

/// The Java version Mojang says a Minecraft version needs (falls back to a guess offline).
pub async fn java_major_for(mc: &str) -> u32 {
    match mojang_version(mc).await {
        Ok(info) => info["javaVersion"]["majorVersion"].as_u64().map(|n| n as u32).unwrap_or(8),
        Err(_) => crate::versions::guess_java_major(mc),
    }
}

pub fn reset_caches() {
    *MANIFEST_CACHE.lock().unwrap() = None;
    *NEO_CACHE.lock().unwrap() = None;
    *FORGE_CACHE.lock().unwrap() = None;
}

// ---------- installer helpers ----------
fn progress(log: &Log, label: &str) -> impl FnMut(u64, u64) + Send {
    let (log, label) = (log.clone(), label.to_string());
    move |got, total| {
        let mb = got as f64 / 1048576.0;
        if total > 0 { log(format!("Downloading {label}… {mb:.1} / {:.1} MB", total as f64 / 1048576.0), Some(got as f64 / total as f64)); }
        else { log(format!("Downloading {label}… {mb:.1} MB"), None); }
    }
}

async fn simple_jar(url: &str, dir: &Path, log: &Log, name: &str) -> Result<Vec<String>> {
    net::download(url, &dir.join(name), progress(log, name)).await?;
    Ok(vec!["-jar".into(), name.into()])
}

/// Run `java -jar installer --installServer`, streaming its output as verbose log lines.
async fn run_installer(url: &str, file: &str, dir: &Path, log: &Log, java: &str) -> Result<Vec<String>> {
    log(format!("Downloading {file}…"), None);
    net::download(url, &dir.join(file), progress(log, file)).await?;
    log("Running the installer (this can take a few minutes)…".into(), None);
    use tokio::io::AsyncBufReadExt;
    let mut child = crate::proc::command(java).args(["-jar", file, "--installServer"]).current_dir(dir)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()
        .map_err(|e| anyhow::anyhow!("Couldn't run Java: {e}"))?;
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let l1 = log.clone();
    let t1 = tokio::spawn(async move { let mut r = tokio::io::BufReader::new(out).lines(); while let Ok(Some(l)) = r.next_line().await { l1(format!("\u{1}{l}"), None); } });
    let l2 = log.clone();
    let t2 = tokio::spawn(async move { let mut r = tokio::io::BufReader::new(err).lines(); while let Ok(Some(l)) = r.next_line().await { l2(format!("\u{1}{l}"), None); } });
    let status = child.wait().await?;
    let _ = (t1.await, t2.await);
    if !status.success() { crate::bail!("The installer exited with code {}. See the log above.", status.code().unwrap_or(-1)); }
    for e in std::fs::read_dir(dir)?.flatten() {
        let n = e.file_name().to_string_lossy().to_lowercase();
        if n.ends_with("installer.jar") || n.ends_with("installer.jar.log") || n == "installer.log" { let _ = std::fs::remove_file(e.path()); }
    }
    forge_launch_args(dir)
}

/// How to launch a Forge/NeoForge server after its installer ran: read run.bat (Windows) or run.sh.
pub fn forge_launch_args(dir: &Path) -> Result<Vec<String>> {
    let script = if cfg!(windows) { ["run.bat", "run.sh"] } else { ["run.sh", "run.bat"] };
    static JAVA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)^(java|.*[/\\]java(\.exe)?|"?%?\$?\{?JAVA.*)$"#).unwrap());
    for s in script {
        let Ok(text) = std::fs::read_to_string(dir.join(s)) else { continue };
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || line.to_lowercase().starts_with("rem ") || line.starts_with("::") || line.starts_with('@') && !line.contains("java") { continue; }
            let tokens: Vec<String> = line.split_whitespace().map(|t| t.trim_matches(|c| c == '"' || c == '\'').to_string()).collect();
            let Some(j) = tokens.iter().position(|t| JAVA.is_match(t)) else { continue };
            let rest: Vec<String> = tokens[j + 1..].iter()
                .filter(|t| !matches!(t.as_str(), "$@" | "%*" | "@user_jvm_args.txt" | "nogui" | "pause"))
                .map(|t| t.replace('\\', "/")).collect();
            if !rest.is_empty() { return Ok(rest); }
        }
    }
    // Fallbacks: an args file for this OS, or a forge jar.
    let args_file = if cfg!(windows) { "win_args.txt" } else { "unix_args.txt" };
    for base in ["libraries/net/neoforged/neoforge", "libraries/net/minecraftforge/forge"] {
        if let Ok(rd) = std::fs::read_dir(dir.join(base)) {
            let mut vs: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            vs.sort_by(|a, b| compare(b, a));
            for v in vs {
                let f = format!("{base}/{v}/{args_file}");
                if dir.join(&f).exists() { return Ok(vec![format!("@{f}")]); }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let l = n.to_lowercase();
            if (l.starts_with("forge-") || l.starts_with("neoforge-")) && l.ends_with(".jar") && !l.contains("installer") { return Ok(vec!["-jar".into(), n]); }
        }
    }
    crate::bail!("The installer finished but I couldn't find how to launch the server (no run script).")
}

// ---------- NeoForge / Forge version lists ----------
static NEO_CACHE: Mutex<Option<HashMap<String, (String, bool)>>> = Mutex::new(None);
static FORGE_CACHE: Mutex<Option<Value>> = Mutex::new(None);

async fn neo_versions() -> Result<HashMap<String, (String, bool)>> {
    if let Some(c) = NEO_CACHE.lock().unwrap().clone() { return Ok(c); }
    let xml = net::get_text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml").await?;
    static V: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<version>([^<]+)</version>").unwrap());
    let mut by_mc: HashMap<String, (String, bool)> = HashMap::new();
    for c in V.captures_iter(&xml) {
        let v = c[1].to_string();
        let l = v.to_lowercase();
        if l.contains("snapshot") || l.contains("alpha") || v.contains('+') { continue; }
        let mc = crate::versions::neo_to_mc(&v);
        let stable = !l.contains("beta");
        // Prefer the newest stable build; fall back to the newest beta if that's all there is.
        let better = match by_mc.get(&mc) {
            None => true,
            Some((cv, cs)) => (stable && !cs) || (stable == *cs && compare(&v, cv).is_gt()),
        };
        if better { by_mc.insert(mc, (v, stable)); }
    }
    *NEO_CACHE.lock().unwrap() = Some(by_mc.clone());
    Ok(by_mc)
}

async fn forge_promos() -> Result<Value> {
    if let Some(c) = FORGE_CACHE.lock().unwrap().clone() { return Ok(c); }
    let v: Value = net::get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json").await?;
    let p = v["promos"].clone();
    *FORGE_CACHE.lock().unwrap() = Some(p.clone());
    Ok(p)
}

// ---------- the catalogue ----------
pub async fn versions(id: &str) -> Result<Vec<String>> {
    Ok(match id {
        "paper" => {
            let d: Value = net::get_json("https://fill.papermc.io/v3/projects/paper").await?;
            let all = d["versions"].as_object().map(|o| o.values().flat_map(|l| l.as_array().cloned().unwrap_or_default()).filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_else(Vec::new);
            sort_desc(all.into_iter().filter(|v| is_release(v)).collect())
        }
        "purpur" => {
            let d: Value = net::get_json("https://api.purpurmc.org/v2/purpur").await?;
            sort_desc(d["versions"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str()).filter(|v| is_release(v)).map(String::from).collect())
        }
        "vanilla" => mojang_manifest().await?["versions"].as_array().cloned().unwrap_or_default().iter()
            .filter(|v| v["type"] == "release").filter_map(|v| v["id"].as_str().map(String::from)).collect(),
        "fabric" => {
            let d: Value = net::get_json("https://meta.fabricmc.net/v2/versions/game").await?;
            d.as_array().cloned().unwrap_or_default().iter().filter(|v| v["stable"] == true).filter_map(|v| v["version"].as_str().map(String::from)).collect()
        }
        "forge" => {
            let p = forge_promos().await?;
            let keys: Vec<String> = p.as_object().map(|o| o.keys().map(|k| k.trim_end_matches("-latest").trim_end_matches("-recommended").to_string()).collect()).unwrap_or_default();
            sort_desc(keys).into_iter().filter(|v| is_release(v) && compare(v, "1.12").is_ge()).collect()
        }
        "neoforge" => sort_desc(neo_versions().await?.into_keys().collect()),
        _ => crate::bail!("Unknown server software: {id}"),
    })
}

/// Install server software into `dir`. `loader` pins a mod loader version (modpacks); otherwise the
/// newest stable one is used. `java` is called only when an installer needs to run.
/// Returns the launch arguments that go after the JVM memory flags.
pub async fn install(id: &str, mc: &str, dir: &Path, loader: Option<&str>, log: &Log, java: &str) -> Result<Vec<String>> {
    match id {
        "paper" => {
            let builds: Value = net::get_json(&format!("https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds")).await?;
            let mut b = builds.as_array().cloned().unwrap_or_default();
            b.sort_by_key(|x| std::cmp::Reverse(x["id"].as_i64().unwrap_or(0)));
            let build = b.iter().find(|x| x["channel"] == "STABLE" || x["channel"] == "RECOMMENDED").or(b.first())
                .ok_or_else(|| anyhow::anyhow!("Paper has no builds for {mc} yet."))?;
            log(format!("Using Paper build #{} ({})", build["id"], build["channel"].as_str().unwrap_or("").to_lowercase()), None);
            let url = build["downloads"]["server:default"]["url"].as_str().ok_or_else(|| anyhow::anyhow!("Paper's build list has no download."))?;
            simple_jar(url, dir, log, "server.jar").await
        }
        "purpur" => simple_jar(&format!("https://api.purpurmc.org/v2/purpur/{mc}/latest/download"), dir, log, "server.jar").await,
        "vanilla" => {
            let info = mojang_version(mc).await?;
            let url = info["downloads"]["server"]["url"].as_str().ok_or_else(|| anyhow::anyhow!("Mojang doesn't provide a server for {mc}."))?;
            simple_jar(url, dir, log, "server.jar").await
        }
        "fabric" => {
            let loader = match loader {
                Some(l) => l.to_string(),
                None => {
                    let loaders: Value = net::get_json(&format!("https://meta.fabricmc.net/v2/versions/loader/{mc}")).await?;
                    let l = loaders.as_array().cloned().unwrap_or_default();
                    l.iter().find(|x| x["loader"]["stable"] == true).or(l.first()).and_then(|x| x["loader"]["version"].as_str()).map(String::from)
                        .ok_or_else(|| anyhow::anyhow!("Fabric doesn't support {mc} yet."))?
                }
            };
            let installers: Value = net::get_json("https://meta.fabricmc.net/v2/versions/installer").await?;
            let i = installers.as_array().cloned().unwrap_or_default();
            let inst = i.iter().find(|x| x["stable"] == true).or(i.first()).and_then(|x| x["version"].as_str()).unwrap_or("1.0.1").to_string();
            log(format!("Using Fabric loader {loader}, installer {inst}"), None);
            simple_jar(&format!("https://meta.fabricmc.net/v2/versions/loader/{mc}/{loader}/{inst}/server/jar"), dir, log, "fabric-server.jar").await
        }
        "forge" => {
            let fv = match loader {
                Some(l) => l.to_string(),
                None => {
                    let p = forge_promos().await?;
                    p[format!("{mc}-recommended")].as_str().or(p[format!("{mc}-latest")].as_str()).map(String::from).ok_or_else(|| anyhow::anyhow!("No Forge build for {mc}."))?
                }
            };
            let full = format!("{mc}-{fv}");
            log(format!("Using Forge {full}"), None);
            run_installer(&format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{full}/forge-{full}-installer.jar"), &format!("forge-{full}-installer.jar"), dir, log, java).await
        }
        "neoforge" => {
            let (v, stable) = match loader {
                Some(l) => (l.to_string(), true),
                None => neo_versions().await?.get(mc).cloned().ok_or_else(|| anyhow::anyhow!("No NeoForge build for {mc}."))?,
            };
            log(format!("Using NeoForge {v}{}", if stable { "" } else { " (beta, no stable build exists yet)" }), None);
            run_installer(&format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{v}/neoforge-{v}-installer.jar"), &format!("neoforge-{v}-installer.jar"), dir, log, java).await
        }
        _ => crate::bail!("Unknown server software: {id}"),
    }
}

/// Software that needs Java just to install (runs an installer).
pub fn needs_java_to_install(id: &str) -> bool { id == "forge" || id == "neoforge" }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forge_scripts_and_fallbacks() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("run.sh"), "#!/usr/bin/env sh\n# Forge\n\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt \"$@\"\n").unwrap();
        std::fs::write(d.path().join("run.bat"), "@echo off\r\nREM Forge\r\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt %*\r\npause\r\n").unwrap();
        let a = forge_launch_args(d.path()).unwrap();
        let want = if cfg!(windows) { "win_args.txt" } else { "unix_args.txt" };
        assert_eq!(a.len(), 1);
        assert!(a[0].starts_with("@libraries/net/minecraftforge/forge/1.20.1-47.3.0/") && a[0].ends_with(want), "{a:?}");
        let d2 = tempfile::tempdir().unwrap();
        std::fs::write(d2.path().join("forge-1.12.2-14.23.5.2860.jar"), b"").unwrap();
        assert_eq!(forge_launch_args(d2.path()).unwrap(), vec!["-jar", "forge-1.12.2-14.23.5.2860.jar"]);
        let d3 = tempfile::tempdir().unwrap();
        let lib = d3.path().join("libraries/net/neoforged/neoforge/21.1.77");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("unix_args.txt"), "").unwrap();
        std::fs::write(lib.join("win_args.txt"), "").unwrap();
        assert_eq!(forge_launch_args(d3.path()).unwrap(), vec![format!("@libraries/net/neoforged/neoforge/21.1.77/{want}")]);
        assert!(forge_launch_args(tempfile::tempdir().unwrap().path()).is_err());
    }
}
