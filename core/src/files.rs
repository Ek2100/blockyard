//! The file browser, plugins/mods folder and player list files. Every path stays inside the server folder.
use crate::paths::{absolute, is_within};
use crate::Result;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Resolve `rel` inside `root`, refusing anything that escapes it (`..`, absolute paths, symlinks out).
pub fn safe(root: &Path, rel: &str) -> Result<PathBuf> {
    let r = absolute(root);
    let rel = rel.replace('\\', "/");
    let rel_path = Path::new(rel.trim_start_matches('/'));
    if Path::new(&rel).is_absolute() || rel.starts_with('/') || rel_path.has_root() {
        crate::bail!("That path is outside the server folder.");
    }
    let p = absolute(&r.join(rel_path));
    if !is_within(&p, &r) { crate::bail!("That path is outside the server folder."); }
    // Follow symlinks for anything that already exists, so a link can't point outside.
    if let (Ok(real_root), Ok(real)) = (std::fs::canonicalize(&r), std::fs::canonicalize(&p)) {
        if !is_within(&real, &real_root) { crate::bail!("That path is outside the server folder."); }
    }
    Ok(p)
}

const TEXT_EXT: &[&str] = &["txt", "properties", "yml", "yaml", "json", "json5", "toml", "cfg", "conf", "ini", "log", "md", "sh", "bat", "cmd", "mcmeta", "csv", "xml", "js", "lang", "snbt", "secret"];

pub fn is_text(name: &str) -> bool {
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some(ext) => TEXT_EXT.contains(&ext.to_ascii_lowercase().as_str()),
        None => !name.starts_with('.'),
    }
}

fn mtime_ms(m: &std::fs::Metadata) -> Option<i64> {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

fn natural_key(s: &str) -> Vec<(u8, u64, String)> {
    // Case-insensitive, numbers compared by value ("world 10" after "world 9").
    let mut out = Vec::new();
    let mut num = String::new();
    let mut txt = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !txt.is_empty() { out.push((1, 0, std::mem::take(&mut txt).to_lowercase())); }
            num.push(c);
        } else {
            if !num.is_empty() { out.push((0, num.parse().unwrap_or(u64::MAX), String::new())); num.clear(); }
            txt.push(c);
        }
    }
    if !num.is_empty() { out.push((0, num.parse().unwrap_or(u64::MAX), String::new())); }
    if !txt.is_empty() { out.push((1, 0, txt.to_lowercase())); }
    out
}

pub fn list(root: &Path, rel: &str) -> Result<Value> {
    let dir = safe(root, rel)?;
    let mut items: Vec<(bool, String, Value)> = Vec::new();
    for e in std::fs::read_dir(&dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" || name == "desktop.ini" || name == "Thumbs.db" { continue; }
        let st = std::fs::metadata(e.path()).ok();
        let is_dir = st.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        items.push((is_dir, name.clone(), json!({
            "name": name, "dir": is_dir,
            "size": if is_dir { Value::Null } else { st.as_ref().map(|m| json!(m.len())).unwrap_or(Value::Null) },
            "mtime": st.as_ref().and_then(mtime_ms),
            "text": !is_dir && is_text(&name),
        })));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| natural_key(&a.1).cmp(&natural_key(&b.1))));
    Ok(Value::Array(items.into_iter().map(|x| x.2).collect()))
}

pub fn read_text(root: &Path, rel: &str) -> Result<String> {
    let p = safe(root, rel)?;
    if std::fs::metadata(&p)?.len() > 4 * 1024 * 1024 {
        crate::bail!("That file is over 4 MB, too big to edit here. Open it in your file manager instead.");
    }
    Ok(String::from_utf8_lossy(&std::fs::read(p)?).into_owned())
}

pub fn write_text(root: &Path, rel: &str, content: &str) -> Result<()> { Ok(std::fs::write(safe(root, rel)?, content)?) }
pub fn mkdir(root: &Path, rel: &str) -> Result<()> { Ok(std::fs::create_dir_all(safe(root, rel)?)?) }

pub fn rename(root: &Path, rel: &str, new_name: &str) -> Result<()> {
    if new_name.trim().is_empty() || new_name.contains(['/', '\\']) { crate::bail!("Names can’t contain slashes."); }
    let from = safe(root, rel)?;
    let parent = Path::new(rel).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let to = safe(root, &if parent.is_empty() { new_name.to_string() } else { format!("{parent}/{new_name}") })?;
    if to.exists() { crate::bail!("\"{new_name}\" already exists."); }
    std::fs::rename(from, to)?;
    Ok(())
}

pub fn copy_recursive(src: &Path, dst: &Path, skip: &dyn Fn(&Path) -> bool) -> Result<()> {
    if skip(src) { return Ok(()); }
    let meta = std::fs::metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dst.join(e.file_name()), skip)?;
        }
    } else {
        if let Some(p) = dst.parent() { std::fs::create_dir_all(p)?; }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Copy files/folders from anywhere (drag and drop) into a folder of the server. Never overwrites.
pub fn copy_in(root: &Path, dest_rel: &str, sources: &[String]) -> Result<Vec<String>> {
    let dest = safe(root, dest_rel)?;
    std::fs::create_dir_all(&dest)?;
    let mut copied = Vec::new();
    for src in sources {
        let src = PathBuf::from(src);
        let Some(name) = src.file_name() else { continue };
        let mut target = dest.join(name);
        if absolute(&src) == absolute(&target) { continue; }
        let stem = src.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let mut n = 2;
        while target.exists() { target = dest.join(format!("{stem} {n}{ext}")); n += 1; }
        copy_recursive(&src, &target, &|_| false)?;
        copied.push(target.file_name().unwrap().to_string_lossy().into_owned());
    }
    Ok(copied)
}

// ---------- plugins / mods ----------
pub fn addons_dir(kind: &str) -> &'static str { if kind == "plugins" { "plugins" } else { "mods" } }

fn is_jar(f: &str) -> bool { let l = f.to_ascii_lowercase(); l.ends_with(".jar") || l.ends_with(".jar.disabled") }

pub fn list_addons(dir: &Path, kind: &str) -> Result<Value> {
    let rel = addons_dir(kind);
    let folder = safe(dir, rel)?;
    let mut items = Vec::new();
    if folder.exists() {
        for e in std::fs::read_dir(&folder)? {
            let f = e?.file_name().to_string_lossy().into_owned();
            if !is_jar(&f) { continue; }
            let enabled = !f.to_ascii_lowercase().ends_with(".disabled");
            let base = if enabled { f.clone() } else { f[..f.len() - 9].to_string() };
            let name = base[..base.len() - 4].to_string();
            let size = std::fs::metadata(folder.join(&f)).map(|m| m.len()).unwrap_or(0);
            items.push(json!({ "file": f, "name": name, "enabled": enabled, "size": size }));
        }
    }
    items.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
    Ok(json!({ "folder": rel, "items": items }))
}

pub fn toggle_addon(dir: &Path, kind: &str, file: &str, enabled: bool) -> Result<()> {
    let rel = addons_dir(kind);
    let from = safe(dir, &format!("{rel}/{file}"))?;
    let base = file.strip_suffix(".disabled").unwrap_or(file);
    let to = safe(dir, &format!("{rel}/{}", if enabled { base.to_string() } else { format!("{base}.disabled") }))?;
    if from != to { std::fs::rename(from, to)?; }
    Ok(())
}

pub fn add_addons(dir: &Path, kind: &str, sources: &[String]) -> Result<Vec<String>> {
    let rel = addons_dir(kind);
    std::fs::create_dir_all(safe(dir, rel)?)?;
    let jars: Vec<String> = sources.iter().filter(|s| s.to_ascii_lowercase().ends_with(".jar")).cloned().collect();
    copy_in(dir, rel, &jars)
}

// ---------- ops / whitelist / bans ----------
pub fn read_json_list(dir: &Path, name: &str) -> Vec<Value> {
    std::fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).unwrap_or_default()
}

pub fn player_lists(dir: &Path) -> Value {
    let names = |f: &str| read_json_list(dir, f).iter().filter_map(|o| o["name"].as_str().map(String::from)).collect::<Vec<_>>();
    json!({ "ops": names("ops.json"), "whitelist": names("whitelist.json"), "banned": names("banned-players.json") })
}

/// Add someone to whitelist.json directly (used while the server is stopped).
pub fn whitelist_add(dir: &Path, uuid: &str, name: &str) -> Result<bool> {
    let mut list = read_json_list(dir, "whitelist.json");
    if list.iter().any(|o| o["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)) || o["uuid"].as_str() == Some(uuid)) {
        return Ok(false);
    }
    list.push(json!({ "uuid": uuid, "name": name }));
    std::fs::write(dir.join("whitelist.json"), serde_json::to_string_pretty(&list)?)?;
    Ok(true)
}

pub fn dir_size(p: &Path) -> u64 {
    walkdir::WalkDir::new(p).into_iter().filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confined_to_server_folder_and_addons_toggle() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        assert!(safe(root, "../x").is_err());
        assert!(safe(root, "/etc/passwd").is_err());
        assert!(safe(root, "a/../../x").is_err());
        assert!(safe(root, "").is_ok());
        assert!(safe(root, "a/../b").is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", root.join("escape")).unwrap();
            assert!(safe(root, "escape/etc").is_err());
            std::fs::remove_file(root.join("escape")).unwrap();
        }
        mkdir(root, "plugins").unwrap();
        std::fs::write(root.join("plugins/A.jar"), b"x").unwrap();
        std::fs::write(root.join("plugins/B.jar.disabled"), b"yy").unwrap();
        std::fs::write(root.join("plugins/readme.txt"), b"no").unwrap();
        let l = list_addons(root, "plugins").unwrap();
        assert_eq!(l["items"].as_array().unwrap().len(), 2);
        assert_eq!(l["items"][1]["enabled"], false);
        toggle_addon(root, "plugins", "A.jar", false).unwrap();
        assert!(root.join("plugins/A.jar.disabled").exists());
        toggle_addon(root, "plugins", "B.jar.disabled", true).unwrap();
        assert!(root.join("plugins/B.jar").exists());
        assert!(toggle_addon(root, "plugins", "../../x.jar", true).is_err());
        write_text(root, "notes.txt", "hi").unwrap();
        rename(root, "notes.txt", "n2.txt").unwrap();
        assert_eq!(read_text(root, "n2.txt").unwrap(), "hi");
        assert!(rename(root, "n2.txt", "../x").is_err());
        let names: Vec<String> = list(root, "").unwrap().as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names[0], "plugins");
        let copied = copy_in(root, "plugins", &[root.join("n2.txt").to_string_lossy().into_owned()]).unwrap();
        assert_eq!(copied, vec!["n2.txt"]);
        let again = copy_in(root, "plugins", &[root.join("n2.txt").to_string_lossy().into_owned()]).unwrap();
        assert_eq!(again, vec!["n2 2.txt"]);
        assert!(whitelist_add(root, "u1", "Steve").unwrap());
        assert!(!whitelist_add(root, "u1", "steve").unwrap());
        assert_eq!(player_lists(root)["whitelist"][0], "Steve");
    }
}
