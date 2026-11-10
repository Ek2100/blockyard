//! Bedrock crossplay: installs Geyser + Floodgate for the server's platform and keeps their config sane.
//! Paper/Purpur: Geyser from Modrinth (version-matched), Floodgate-Spigot from GeyserMC's download API.
//! Fabric/NeoForge: both from Modrinth (Floodgate-Modded), dependencies such as Fabric API included.
use crate::java::Log;
use crate::{modrinth, net, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const GEYSER_API: &str = "https://download.geysermc.org/v2/projects";
pub const DEFAULT_PORT: u16 = 19132;

pub fn supported(software: &str) -> bool { matches!(software, "paper" | "purpur" | "fabric" | "neoforge") }
fn is_plugin_server(sw: &str) -> bool { sw == "paper" || sw == "purpur" }
fn dir(cfg: &Value) -> PathBuf { PathBuf::from(cfg["dir"].as_str().unwrap_or("")) }
fn addon_folder(cfg: &Value) -> PathBuf { dir(cfg).join(if is_plugin_server(cfg["software"].as_str().unwrap_or("")) { "plugins" } else { "mods" }) }

pub fn config_path(cfg: &Value) -> PathBuf {
    let sw = cfg["software"].as_str().unwrap_or("");
    if is_plugin_server(sw) { return dir(cfg).join("plugins/Geyser-Spigot/config.yml"); }
    dir(cfg).join("config").join(if sw == "fabric" { "Geyser-Fabric" } else { "Geyser-NeoForge" }).join("config.yml")
}

/// Which Geyser/Floodgate jars are present (enabled) in plugins/ or mods/.
pub fn detect(cfg: &Value) -> Value {
    let files: Vec<String> = std::fs::read_dir(addon_folder(cfg)).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let find = |p: &str| files.iter().find(|f| { let l = f.to_lowercase(); l.starts_with(p) && l.ends_with(".jar") }).cloned();
    json!({ "geyser": find("geyser"), "floodgate": find("floodgate") })
}

async fn install_floodgate_spigot(cfg: &Value, log: &Log) -> Result<String> {
    let meta: Value = net::get_json(&format!("{GEYSER_API}/floodgate/versions/latest/builds/latest")).await?;
    let d = &meta["downloads"]["spigot"];
    if d.is_null() { crate::bail!("GeyserMC’s download service has no Floodgate build for Spigot/Paper right now."); }
    let folder = addon_folder(cfg);
    std::fs::create_dir_all(&folder)?;
    for e in std::fs::read_dir(&folder)?.flatten() {
        let l = e.file_name().to_string_lossy().to_lowercase();
        if l.starts_with("floodgate") && l.ends_with(".jar") { let _ = std::fs::remove_file(e.path()); }
    }
    let name = Path::new(d["name"].as_str().unwrap_or("floodgate-spigot.jar")).file_name().unwrap_or_default().to_string_lossy().into_owned();
    log(format!("Downloading {name}…"), None);
    let tmp = folder.join(format!(".{name}.download"));
    let r: Result<()> = async {
        net::download(&format!("{GEYSER_API}/floodgate/versions/latest/builds/latest/downloads/spigot"), &tmp, |_, _| {}).await?;
        if let Some(want) = d["sha256"].as_str() {
            if net::sha256_file(&tmp)? != want.to_lowercase() { crate::bail!("Floodgate failed its checksum check, so it wasn’t installed."); }
        }
        std::fs::rename(&tmp, folder.join(&name))?;
        Ok(())
    }.await;
    let _ = std::fs::remove_file(&tmp);
    r.map(|_| name)
}

/// Install Geyser + Floodgate. `installed` is the Modrinth install map (for update tracking).
pub async fn install(cfg: &Value, installed: &mut serde_json::Map<String, Value>, port: u16, log: &Log) -> Result<Value> {
    let sw = cfg["software"].as_str().unwrap_or("");
    if !supported(sw) { crate::bail!("Bedrock crossplay needs Paper, Purpur, Fabric or NeoForge. Vanilla and Forge servers can’t load Geyser."); }
    let mut files: Vec<String> = vec![];
    log("Installing Geyser (lets Bedrock players connect)…".into(), None);
    match modrinth::install(cfg, "geyser", installed, log, 0, &mut vec![]).await {
        Ok(r) => files.extend(r.iter().filter_map(|x| x["file"].as_str().map(String::from))),
        Err(e) if e.to_string().contains("No version") => crate::bail!("Geyser doesn’t support {sw} {} (it follows recent Minecraft versions). Update the server's Minecraft version, then try again.", cfg["mcVersion"].as_str().unwrap_or("")),
        Err(e) => return Err(e),
    }
    log("Installing Floodgate (Bedrock players don’t need a Java account)…".into(), None);
    if is_plugin_server(sw) { files.push(install_floodgate_spigot(cfg, log).await?); }
    else { files.extend(modrinth::install(cfg, "floodgate", installed, log, 0, &mut vec![]).await?.iter().filter_map(|x| x["file"].as_str().map(String::from))); }
    apply_config(cfg, port)?;
    files.dedup();
    Ok(json!({ "files": files, "port": port }))
}

/// Disable by renaming jars to .disabled (keeps configs and linked accounts).
pub fn set_enabled(cfg: &Value, enabled: bool) {
    let folder = addon_folder(cfg);
    for e in std::fs::read_dir(&folder).map(|r| r.flatten().collect::<Vec<_>>()).unwrap_or_default() {
        let f = e.file_name().to_string_lossy().into_owned();
        let l = f.to_lowercase();
        if !(l.starts_with("geyser") || l.starts_with("floodgate")) { continue; }
        if enabled && l.ends_with(".jar.disabled") { let _ = std::fs::rename(e.path(), folder.join(&f[..f.len() - 9])); }
        if !enabled && l.ends_with(".jar") { let _ = std::fs::rename(e.path(), folder.join(format!("{f}.disabled"))); }
    }
}

/// Set `key` inside a top-level YAML section without a YAML library (keeps comments and layout).
pub fn set_yaml_key(text: &str, section: &str, key: &str, value: &str) -> (String, bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    let sec = Regex::new(&format!(r"^{}:\s*(#.*)?$", regex::escape(section))).unwrap();
    let Some(start) = lines.iter().position(|l| sec.is_match(l.trim_end_matches('\r'))) else { return (text.to_string(), false) };
    let kre = Regex::new(&format!(r"^(\s+){}:\s*([^#]*?)(\s*#.*)?$", regex::escape(key))).unwrap();
    for i in start + 1..lines.len() {
        let l = lines[i].trim_end_matches('\r');
        if l.starts_with(|c: char| !c.is_whitespace()) && !l.starts_with('#') { break; } // next top-level key
        if let Some(c) = kre.captures(l) {
            if c[2].trim() == value { return (text.to_string(), false); }
            let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            out[i] = format!("{}{}: {}{}", &c[1], key, value, c.get(3).map(|m| m.as_str()).unwrap_or(""));
            return (out.join("\n"), true);
        }
    }
    (text.to_string(), false)
}

/// Make Geyser listen on the chosen Bedrock port and authenticate through Floodgate.
/// Geyser only writes its config on first start; until then there's nothing to patch.
pub fn apply_config(cfg: &Value, port: u16) -> Result<(bool, bool)> {
    let file = config_path(cfg);
    let Ok(mut text) = std::fs::read_to_string(&file) else { return Ok((false, false)) };
    let mut changed = false;
    let (t, c) = set_yaml_key(&text, "bedrock", "port", &port.to_string()); text = t; changed |= c;
    // auth-type lives under `remote:` (older configs) or `java:` (newer configs).
    for sec in ["remote", "java"] { let (t, c) = set_yaml_key(&text, sec, "auth-type", "floodgate"); text = t; changed |= c; }
    if changed { std::fs::write(&file, &text)?; }
    Ok((true, changed))
}

pub fn read_port(cfg: &Value) -> Option<u16> {
    let text = std::fs::read_to_string(config_path(cfg)).ok()?;
    let start = text.find("\nbedrock:").map(|i| i + 1).or_else(|| text.starts_with("bedrock:").then_some(0))?;
    static P: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s+port:\s*(\d+)").unwrap());
    P.captures(&text[start..]).and_then(|c| c[1].parse().ok())
}

/// Console lines that tell us Geyser came up (or why it didn't).
pub static READY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Started Geyser on [^\s:]*:?(\d+)|Geyser.*listening on.*?:(\d+)").unwrap());
pub static FAIL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\[Geyser[^\]]*\].*(Unable to bind|Failed to start|address already in use)").unwrap());

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patches_old_and_new_layouts() {
        let old = "bedrock:\n  # The port\n  port: 19132\n  motd1: x\nremote:\n  address: auto\n  auth-type: online # how\nother: 1\n";
        let (t, c) = set_yaml_key(old, "bedrock", "port", "19133");
        assert!(c && t.contains("  port: 19133\n"));
        let (t, c) = set_yaml_key(&t, "remote", "auth-type", "floodgate");
        assert!(c && t.contains("  auth-type: floodgate # how\n"));
        let (_, c) = set_yaml_key(&t, "remote", "auth-type", "floodgate");
        assert!(!c);
        let new = "java:\n  auth-type: online\nbedrock:\n  port: 19132\n";
        let (t, _) = set_yaml_key(new, "java", "auth-type", "floodgate");
        assert!(t.starts_with("java:\n  auth-type: floodgate\n"));
        let (_, c) = set_yaml_key("bedrock:\n  motd: x\nport: 1\n", "bedrock", "port", "2");
        assert!(!c, "must not touch a top-level key outside the section");
        let d = tempfile::tempdir().unwrap();
        let cfg = json!({ "dir": d.path(), "software": "paper" });
        std::fs::create_dir_all(d.path().join("plugins/Geyser-Spigot")).unwrap();
        std::fs::write(config_path(&cfg), old).unwrap();
        assert_eq!(read_port(&cfg), Some(19132));
        assert_eq!(apply_config(&cfg, 19140).unwrap(), (true, true));
        assert_eq!(read_port(&cfg), Some(19140));
        std::fs::write(d.path().join("plugins/Geyser-Spigot.jar"), b"").unwrap();
        std::fs::write(d.path().join("plugins/floodgate-spigot.jar"), b"").unwrap();
        set_enabled(&cfg, false);
        assert_eq!(detect(&cfg)["geyser"], Value::Null);
        set_enabled(&cfg, true);
        assert_eq!(detect(&cfg)["floodgate"], "floodgate-spigot.jar");
    }
}
