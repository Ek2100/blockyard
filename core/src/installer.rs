//! Creating new servers and recognising existing server folders for import.
use crate::java::Log;
use crate::{props, providers, versions, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// A folder-safe server name (no characters Windows or macOS refuse).
pub fn safe_name(n: &str) -> String {
    let s: String = n.trim().chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = s.chars().take(64).collect();
    let s = s.trim_end_matches(['.', ' ']).to_string(); // Windows can't have a folder ending in "."
    const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    if s.is_empty() || RESERVED.contains(&s.to_uppercase().as_str()) { "Minecraft Server".into() } else { s }
}

pub struct CreateOpts {
    pub name: String,
    pub software: String,
    pub mc_version: String,
    pub parent_dir: PathBuf,
    pub port: u16,
    pub memory_mb: u64,
    pub eula: bool,
    pub loader: Option<String>,
}

/// Create a server folder, install Java + the server software, accept the EULA and write properties.
/// Returns the new server record (without id; the store adds it). The folder is removed again on failure.
pub async fn create(o: &CreateOpts, log: Log) -> Result<Value> {
    let sw = providers::get(&o.software)?;
    if o.mc_version.is_empty() { crate::bail!("Pick a Minecraft version."); }
    if !o.eula { crate::bail!("You need to accept the Minecraft EULA to run a server."); }
    let name = safe_name(&o.name);
    let dir = o.parent_dir.join(&name);
    let existed = dir.exists();
    if existed && std::fs::read_dir(&dir)?.flatten().any(|e| e.file_name() != ".DS_Store") {
        crate::bail!("\"{}\" already exists and has files in it. Pick a different name, or use Import for an existing server.", dir.display());
    }
    std::fs::create_dir_all(&dir)?;
    let result: Result<Value> = async {
        log(format!("Creating {} {} server in {}", sw.label, o.mc_version, dir.display()), Some(0.02));
        let java_major = providers::java_major_for(&o.mc_version).await;
        log(format!("Minecraft {} needs Java {java_major}.", o.mc_version), None);
        let java = crate::java::ensure(java_major, log.clone()).await?; // ready now, so the first Start just works
        let launch = providers::install(&o.software, &o.mc_version, &dir, o.loader.as_deref(), &log, &java).await?;
        std::fs::write(dir.join("eula.txt"), format!("# Accepted in Blockyard on {}\n# https://aka.ms/MinecraftEULA\neula=true\n", chrono::Utc::now().to_rfc3339()))?;
        props::set(&dir, &[("server-port", &o.port.to_string()), ("motd", &format!("{name} (Blockyard)"))])?;
        log("All done! Press Start to launch your server.".into(), Some(1.0));
        Ok(json!({
            "name": name, "dir": dir.to_string_lossy(), "software": o.software, "kind": sw.kind, "mcVersion": o.mc_version,
            "javaMajor": java_major, "memoryMB": o.memory_mb, "launchArgs": launch, "jvmArgs": "", "javaPath": "",
        }))
    }.await;
    if result.is_err() && !existed { let _ = std::fs::remove_dir_all(&dir); }
    result
}

fn lib_version(dir: &Path, base: &str) -> Option<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir.join(base)).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort_by(|a, b| versions::compare(a, b));
    v.pop()
}

/// Look at a folder and guess what kind of server it is.
pub fn detect(dir: &Path) -> Result<Value> {
    if !dir.is_dir() { crate::bail!("That folder does not exist."); }
    let entries: Vec<String> = std::fs::read_dir(dir)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let has = |p: &str| dir.join(p).exists();
    let jars: Vec<String> = entries.iter().filter(|f| f.to_lowercase().ends_with(".jar") && !f.to_lowercase().contains("installer")).cloned().collect();
    let any_jar = |pat: &str| jars.iter().any(|j| j.to_lowercase().contains(pat));
    let mut software = "vanilla";
    let mut mc = String::new();
    let mut warnings: Vec<String> = vec![];
    let port = props::port(dir);

    if has("libraries/net/neoforged/neoforge") {
        software = "neoforge";
        if let Some(v) = lib_version(dir, "libraries/net/neoforged/neoforge") { mc = versions::neo_to_mc(&v); }
    } else if has("libraries/net/minecraftforge/forge") || jars.iter().any(|j| j.to_lowercase().starts_with("forge-")) {
        software = "forge";
        let v = lib_version(dir, "libraries/net/minecraftforge/forge").or_else(|| jars.iter().find(|j| j.to_lowercase().starts_with("forge-")).map(|j| j[6..j.len() - 4].to_string()));
        if let Some(v) = v { mc = v.split('-').next().unwrap_or("").to_string(); }
    } else if has(".fabric") || any_jar("fabric") {
        software = "fabric";
    } else if has("purpur.yml") || any_jar("purpur") {
        software = "purpur";
    } else if has("config/paper-global.yml") || has("paper.yml") || any_jar("paper") || has("spigot.yml") || has("bukkit.yml") || has("plugins") {
        software = "paper"; // Spigot/Bukkit: treat as a plugin server
    }

    let mut launch: Option<Vec<String>> = None;
    if software == "forge" || software == "neoforge" {
        match providers::forge_launch_args(dir) { Ok(a) => launch = Some(a), Err(e) => warnings.push(e.to_string()) }
    }
    if launch.is_none() {
        let preferred = ["server.jar", "fabric-server.jar", "fabric-server-launch.jar", "paper.jar", "purpur.jar", "spigot.jar", "minecraft_server.jar"];
        let jar = preferred.iter().find(|p| jars.iter().any(|j| j == *p)).map(|s| s.to_string())
            .or_else(|| jars.iter().find(|j| { let l = j.to_lowercase(); ["paper", "purpur", "spigot", "fabric", "server", "minecraft"].iter().any(|k| l.contains(k)) }).cloned())
            .or_else(|| jars.iter().max_by_key(|j| std::fs::metadata(dir.join(j)).map(|m| m.len()).unwrap_or(0)).cloned());
        match jar {
            Some(j) => launch = Some(vec!["-jar".into(), j]),
            None => warnings.push("No server .jar found in this folder. You can set the launch command in Settings after importing.".into()),
        }
    }
    if mc.is_empty() {
        if let Ok(t) = std::fs::read_to_string(dir.join("version_history.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                let cur = v["currentVersion"].as_str().unwrap_or("");
                if let Some(i) = cur.find("MC: ") { mc = cur[i + 4..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect(); }
            }
        }
    }
    let ver_re = regex::Regex::new(r"(\d+\.\d+(?:\.\d+)?)").unwrap();
    if mc.is_empty() {
        if let Some(j) = launch.as_ref().and_then(|l| l.get(1)) { if let Some(c) = ver_re.captures(j) { mc = c[1].to_string(); } }
    }
    if mc.is_empty() {
        for d in ["versions", "cache"] {
            if let Ok(rd) = std::fs::read_dir(dir.join(d)) {
                if let Some(c) = rd.flatten().filter_map(|e| ver_re.captures(&e.file_name().to_string_lossy()).map(|c| c[1].to_string())).next() { mc = c; break; }
            }
        }
    }
    if !has("server.properties") && !has("world") && jars.is_empty() { warnings.push("This doesn't look like a Minecraft server folder.".into()); }
    Ok(json!({
        "dir": dir.to_string_lossy(), "name": dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "jars": jars, "software": software, "kind": providers::get(software)?.kind, "mcVersion": mc,
        "launchArgs": launch, "port": port, "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_detection() {
        assert_eq!(safe_name("  My: Server?? "), "My Server");
        assert_eq!(safe_name("con"), "Minecraft Server");
        assert_eq!(safe_name("trailing dot."), "trailing dot");
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        std::fs::write(p.join("paper-1.21.4-232.jar"), b"").unwrap();
        std::fs::create_dir(p.join("plugins")).unwrap();
        std::fs::write(p.join("server.properties"), "server-port=25570\n").unwrap();
        let r = detect(p).unwrap();
        assert_eq!(r["software"], "paper");
        assert_eq!(r["mcVersion"], "1.21.4");
        assert_eq!(r["port"], 25570);
        assert_eq!(r["launchArgs"][1], "paper-1.21.4-232.jar");
        let f = tempfile::tempdir().unwrap();
        std::fs::write(f.path().join("fabric-server.jar"), b"").unwrap();
        std::fs::create_dir_all(f.path().join("versions/1.21.1")).unwrap();
        let r = detect(f.path()).unwrap();
        assert_eq!((r["software"].as_str(), r["mcVersion"].as_str()), (Some("fabric"), Some("1.21.1")));
        let v = tempfile::tempdir().unwrap();
        std::fs::write(v.path().join("minecraft_server.1.20.4.jar"), b"").unwrap();
        let r = detect(v.path()).unwrap();
        assert_eq!((r["software"].as_str(), r["mcVersion"].as_str()), (Some("vanilla"), Some("1.20.4")));
        let e = tempfile::tempdir().unwrap();
        assert_eq!(detect(e.path()).unwrap()["warnings"].as_array().unwrap().len(), 2);
    }
}
