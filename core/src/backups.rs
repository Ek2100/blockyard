//! Zip backups of a server: "world" scope (worlds + configs + plugin data) or "full" (everything except
//! logs, libraries and caches). Stored in <server>/backups. Live servers are paused with save-off /
//! save-all flush so the files on disk are consistent, and always resumed with save-on.
use crate::instance::Instance;
use crate::{props, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(world|full)-(\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d)-(manual|auto|pre-restore)(?:-\d+)?\.zip$").unwrap());
const ALWAYS_EXCLUDE: &[&str] = &["*/session.lock", "session.lock", "*.part", "*.tmp", ".DS_Store", "*/.DS_Store", "backups", "backups/*"];
const FULL_EXCLUDE: &[&str] = &["logs", "logs/*", "libraries/*", "cache/*", "versions/*", "crash-reports/*", ".fabric/*", "bundler/*", "debug/*"];
const WORLD_EXCLUDE: &[&str] = &["plugins/*.jar", "plugins/*.jar.disabled", "plugins/.paper-remapped/*", "plugins/.paper-remapped"];

pub fn label(reason: &str) -> &'static str {
    match reason { "auto" => "Scheduled", "pre-restore" => "Before restore", _ => "Manual" }
}

pub fn backup_dir(dir: &Path) -> PathBuf { dir.join("backups") }

/// zip-style wildcard: `*` matches anything, including `/`.
pub fn glob(pat: &str, s: &str) -> bool {
    let (p, t) = (pat.as_bytes(), s.as_bytes());
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' { star = Some(pi); mark = ti; pi += 1; }
        else if pi < p.len() && p[pi] == t[ti] { pi += 1; ti += 1; }
        else if let Some(sp) = star { pi = sp + 1; mark += 1; ti = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}

/// Top-level folders that are worlds: level-name (+ _nether/_the_end) and anything holding a level.dat.
pub fn world_folders(dir: &Path) -> Vec<String> {
    let level = props::level_name(dir);
    let mut out: Vec<String> = Vec::new();
    for n in [level.clone(), format!("{level}_nether"), format!("{level}_the_end")] {
        if dir.join(&n).exists() && !out.contains(&n) { out.push(n); }
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        let mut names: Vec<String> = rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for n in names {
            if n != "backups" && dir.join(&n).join("level.dat").exists() && !out.contains(&n) { out.push(n); }
        }
    }
    out
}

fn world_scope_items(dir: &Path) -> Result<Vec<String>> {
    let worlds = world_folders(dir);
    if worlds.is_empty() { crate::bail!("There’s no world folder to back up yet. Start the server once so Minecraft creates the world."); }
    let mut items = worlds;
    for e in std::fs::read_dir(dir)?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let l = n.to_lowercase();
        if e.path().is_file() && ![".jar", ".log", ".part", ".tmp"].iter().any(|x| l.ends_with(x)) && n != ".DS_Store" { items.push(n); }
    }
    for d in ["config", "plugins", "defaultconfigs", "serverconfig"] { if dir.join(d).exists() { items.push(d.into()); } }
    Ok(items)
}

pub fn list(dir: &Path) -> Vec<Value> {
    let bdir = backup_dir(dir);
    let mut out: Vec<Value> = std::fs::read_dir(&bdir).map(|rd| rd.flatten().filter_map(|e| {
        let file = e.file_name().to_string_lossy().into_owned();
        let c = NAME_RE.captures(&file)?;
        let m = e.metadata().ok()?;
        let time = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
        Some(json!({ "file": file, "scope": &c[1], "reason": &c[3], "label": label(&c[3]), "size": m.len(), "time": time }))
    }).collect()).unwrap_or_default();
    out.sort_by(|a, b| b["time"].as_i64().cmp(&a["time"].as_i64()).then_with(|| b["file"].as_str().cmp(&a["file"].as_str())));
    out
}

fn stamp() -> String { chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string() }

/// Write the zip (blocking). `items` are top-level names relative to `dir`, "." for everything.
fn write_zip(dir: &Path, items: &[String], exclude: &[&str], out: &Path) -> Result<()> {
    let f = std::fs::File::create(out)?;
    let mut z = zip::ZipWriter::new(std::io::BufWriter::new(f));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(false);
    let excluded = |rel: &str| exclude.iter().any(|p| glob(p, rel));
    for item in items {
        let start = if item == "." { dir.to_path_buf() } else { dir.join(item) };
        if !start.exists() { continue; }
        for e in walkdir::WalkDir::new(&start).follow_links(false).sort_by_file_name() {
            let e = e?;
            if e.file_type().is_symlink() { continue; }
            let rel = e.path().strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
            if rel.is_empty() || excluded(&rel) { continue; }
            if e.file_type().is_dir() {
                z.add_directory(format!("{rel}/"), opts)?;
            } else {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                z.start_file(rel, opts.large_file(size > 0xFFFF_0000))?;
                let mut r = std::fs::File::open(e.path())?;
                std::io::copy(&mut r, &mut z)?;
            }
        }
    }
    z.finish()?.flush()?;
    Ok(())
}

/// Make a backup. `inst` is the running server, if any (paused for a consistent copy).
pub async fn create(dir: &Path, scope: &str, reason: &str, inst: Option<&Arc<Instance>>) -> Result<Value> {
    let (items, mut exclude): (Vec<String>, Vec<&str>) = if scope == "full" {
        (vec![".".into()], FULL_EXCLUDE.to_vec())
    } else {
        (world_scope_items(dir)?, WORLD_EXCLUDE.to_vec())
    };
    exclude.extend_from_slice(ALWAYS_EXCLUDE);
    let out = backup_dir(dir);
    std::fs::create_dir_all(&out)?;
    let mut file = format!("{scope}-{}-{reason}.zip", stamp());
    let mut n = 2;
    while out.join(&file).exists() { file = format!("{scope}-{}-{reason}-{n}.zip", stamp()); n += 1; }
    let tmp = out.join(format!(".{file}.tmp"));

    let live = inst.filter(|i| i.is_running() && i.state() == "online");
    if let Some(i) = live {
        static SAVED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Saved the game|Saved the world|All dimensions are saved|Saving complete").unwrap());
        let _ = i.send("save-off");
        let saved = i.wait_for_line(&SAVED, 60_000);
        let _ = i.send("save-all flush");
        if saved.await.is_err() { i.info("The server didn’t confirm the save in time; backing up anyway."); }
    }
    let (d, it, t) = (dir.to_path_buf(), items.clone(), tmp.clone());
    let ex: Vec<String> = exclude.iter().map(|s| s.to_string()).collect();
    let r = tokio::task::spawn_blocking(move || write_zip(&d, &it, &ex.iter().map(|s| s.as_str()).collect::<Vec<_>>(), &t)).await;
    if let Some(i) = live { if i.is_running() { let _ = i.send("save-on"); } }
    match r {
        Ok(Ok(())) => std::fs::rename(&tmp, out.join(&file))?,
        Ok(Err(e)) => { let _ = std::fs::remove_file(&tmp); return Err(e); }
        Err(e) => { let _ = std::fs::remove_file(&tmp); return Err(e.into()); }
    }
    let m = std::fs::metadata(out.join(&file))?;
    Ok(json!({ "file": file, "scope": scope, "reason": reason, "label": label(reason), "size": m.len(), "time": crate::now_ms() }))
}

/// Delete scheduled backups beyond the newest `keep`. Manual and pre-restore backups are never pruned.
pub fn prune(dir: &Path, keep: usize) -> Vec<String> {
    let mut removed = vec![];
    for b in list(dir).into_iter().filter(|b| b["reason"] == "auto").skip(keep.max(1)) {
        let f = b["file"].as_str().unwrap_or_default().to_string();
        if std::fs::remove_file(backup_dir(dir).join(&f)).is_ok() { removed.push(f); }
    }
    removed
}

/// Restore a backup (server must be stopped). Takes a "Before restore" safety copy, deletes the world
/// folders the backup contains so they're replaced rather than merged, then extracts it.
pub async fn restore(dir: &Path, file: &str, log: &(dyn Fn(String) + Send + Sync)) -> Result<Value> {
    let name = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let zip = backup_dir(dir).join(&name);
    if !zip.exists() { crate::bail!("That backup no longer exists."); }
    let scope = NAME_RE.captures(&name).map(|c| c[1].to_string()).unwrap_or_else(|| "world".into());
    log("Saving a safety copy of the current state…".into());
    if let Err(e) = create(dir, &scope, "pre-restore", None).await {
        if !e.to_string().to_lowercase().contains("no world folder") { return Err(e); }
    }
    let entries = crate::archive::zip_entries(&zip)?;
    let mut tops: Vec<String> = entries.iter().filter_map(|e| e.split('/').next().map(String::from)).filter(|s| !s.is_empty()).collect();
    tops.sort(); tops.dedup();
    let level = props::level_name(dir);
    let worlds: Vec<String> = tops.into_iter().filter(|t| entries.contains(&format!("{t}/level.dat")) || [level.clone(), format!("{level}_nether"), format!("{level}_the_end")].contains(t)).collect();
    for w in &worlds {
        if w == "backups" || w.contains(['/', '\\']) || w == ".." { continue; }
        let _ = std::fs::remove_dir_all(dir.join(w));
    }
    log(format!("Restoring {}…", if worlds.is_empty() { "files".to_string() } else { worlds.join(", ") }));
    let (z, d) = (zip.clone(), dir.to_path_buf());
    tokio::task::spawn_blocking(move || crate::archive::extract_zip(&z, &d)).await??;
    log("Restore complete.".into());
    Ok(json!({ "worlds": worlds }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wildcards() {
        assert!(glob("plugins/*.jar", "plugins/EssentialsX.jar"));
        assert!(glob("plugins/*.jar", "plugins/sub/x.jar"));
        assert!(!glob("plugins/*.jar", "plugins/config.yml"));
        assert!(glob("*/session.lock", "world/session.lock"));
        assert!(glob("backups/*", "backups/a.zip"));
        assert!(!glob("backups", "backupsx"));
        assert!(glob("logs", "logs") && !glob("logs/*", "logs"));
    }

    #[tokio::test]
    async fn create_prune_restore() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        std::fs::create_dir_all(p.join("world/region")).unwrap();
        std::fs::write(p.join("world/level.dat"), b"L1").unwrap();
        std::fs::write(p.join("world/session.lock"), b"x").unwrap();
        std::fs::write(p.join("world/region/r.0.0.mca"), vec![7u8; 5000]).unwrap();
        std::fs::create_dir_all(p.join("plugins/Ess")).unwrap();
        std::fs::write(p.join("plugins/Ess.jar"), b"jar").unwrap();
        std::fs::write(p.join("plugins/Ess/config.yml"), b"a: 1").unwrap();
        std::fs::write(p.join("server.properties"), b"level-name=world\n").unwrap();
        std::fs::write(p.join("server.jar"), b"big").unwrap();
        let b = create(p, "world", "manual", None).await.unwrap();
        let names = crate::archive::zip_entries(&backup_dir(p).join(b["file"].as_str().unwrap())).unwrap();
        assert!(names.contains(&"world/level.dat".to_string()));
        assert!(names.contains(&"plugins/Ess/config.yml".to_string()));
        assert!(names.contains(&"server.properties".to_string()));
        assert!(!names.iter().any(|n| n.ends_with(".jar") || n.ends_with("session.lock")));
        let full = create(p, "full", "auto", None).await.unwrap();
        let fnames = crate::archive::zip_entries(&backup_dir(p).join(full["file"].as_str().unwrap())).unwrap();
        assert!(fnames.contains(&"server.jar".to_string()) && !fnames.iter().any(|n| n.starts_with("backups")));
        for _ in 0..3 { create(p, "world", "auto", None).await.unwrap(); }
        assert_eq!(prune(p, 2).len(), 2);
        assert_eq!(list(p).iter().filter(|b| b["reason"] == "auto").count(), 2);
        // Change the world, add a stray region file, then restore: the world is replaced, not merged.
        std::fs::write(p.join("world/level.dat"), b"L2").unwrap();
        std::fs::write(p.join("world/region/r.9.9.mca"), b"new").unwrap();
        let r = restore(p, b["file"].as_str().unwrap(), &|_| {}).await.unwrap();
        assert_eq!(r["worlds"][0], "world");
        assert_eq!(std::fs::read(p.join("world/level.dat")).unwrap(), b"L1");
        assert!(!p.join("world/region/r.9.9.mca").exists());
        assert!(list(p).iter().any(|b| b["reason"] == "pre-restore"));
        assert!(restore(p, "../../etc/passwd", &|_| {}).await.is_err());
    }
}
