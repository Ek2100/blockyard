//! Finding installed Java runtimes and downloading Eclipse Temurin when the right one is missing.
use crate::{net, proc, Result};
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, RwLock};

#[derive(Debug, Clone, Serialize)]
pub struct Java {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub managed: bool,
}

static MANAGED: RwLock<Option<PathBuf>> = RwLock::new(None);
static CACHE: Mutex<Option<(std::time::Instant, Vec<Java>)>> = Mutex::new(None);

/// Where Blockyard keeps the Java runtimes it downloads (inside the app's data folder).
pub fn set_managed_root(p: PathBuf) { *MANAGED.write().unwrap() = Some(p); *CACHE.lock().unwrap() = None; }
pub fn managed_root() -> PathBuf { MANAGED.read().unwrap().clone().unwrap_or_else(|| crate::paths::home().join(".blockyard").join("java")) }

pub async fn version_of(bin: &Path) -> Option<(String, u32)> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"version "([^"]+)""#).unwrap());
    let out = proc::output(&bin.to_string_lossy(), &["-version"], 15).await;
    let v = RE.captures(&out)?[1].to_string();
    let major = if let Some(rest) = v.strip_prefix("1.") { rest.split('.').next()?.parse().ok()? } else { v.split(['.', '-', '+']).next()?.parse().ok()? };
    Some((v, major))
}

/// bin/java inside an unpacked JDK/JRE (macOS: */Contents/Home/bin/java).
pub fn find_java_bin(root: &Path, depth: u32) -> Option<PathBuf> {
    for d in [root.join("Contents/Home/bin").join(crate::paths::JAVA_EXE), root.join("bin").join(crate::paths::JAVA_EXE)] {
        if d.is_file() { return Some(d); }
    }
    if depth == 0 || !root.is_dir() { return None; }
    let mut entries: Vec<_> = std::fs::read_dir(root).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    entries.sort();
    entries.into_iter().find_map(|p| find_java_bin(&p, depth - 1))
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v
}

/// Look through PATH ourselves (no `which`/`where` subprocess).
fn on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(crate::paths::JAVA_EXE)).find(|p| {
        // On macOS /usr/bin/java is a stub that pops up an "install Java" dialog when no JDK exists.
        p.is_file() && !(cfg!(target_os = "macos") && p == Path::new("/usr/bin/java"))
    })
}

async fn candidates() -> Vec<(PathBuf, bool)> {
    let mut out: Vec<(PathBuf, bool)> = Vec::new();
    for d in children(&managed_root()) { if let Some(b) = find_java_bin(&d, 3) { out.push((b, true)); } }
    let mut add = |p: PathBuf| if p.is_file() { out.push((p, false)) };
    if cfg!(target_os = "macos") {
        let text = proc::output("/usr/libexec/java_home", &["-V"], 10).await;
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s(/\S.*)$").unwrap());
        for line in text.lines() {
            if let Some(c) = RE.captures(line) { add(PathBuf::from(c[1].trim()).join("bin/java")); }
        }
        for parent in [PathBuf::from("/Library/Java/JavaVirtualMachines"), crate::paths::home().join("Library/Java/JavaVirtualMachines")] {
            for d in children(&parent) { add(d.join("Contents/Home/bin/java")); }
        }
        for parent in ["/opt/homebrew/opt", "/usr/local/opt"] {
            for d in children(Path::new(parent)) {
                if d.file_name().is_some_and(|n| n.to_string_lossy().contains("openjdk")) { add(d.join("bin/java")); }
            }
        }
    } else if cfg!(windows) {
        let mut roots = vec![];
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(v) = std::env::var(var) { roots.push(PathBuf::from(v)); }
        }
        if let Some(l) = dirs::data_local_dir() { roots.push(l.join("Programs")); }
        for root in roots {
            for vendor in ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft", "Semeru", "OpenJDK", "AdoptOpenJDK", "Eclipse Foundation"] {
                for d in children(&root.join(vendor)) { add(d.join("bin").join("java.exe")); }
            }
        }
        // The official Minecraft launcher ships its own runtimes.
        if let Some(l) = dirs::data_local_dir() {
            for d in children(&l.join("Packages").join("Microsoft.4297127D64EC6_8wekyb3d8bbwe").join("LocalCache").join("Local").join("runtime")) {
                if let Some(b) = find_java_bin(&d, 3) { add(b); }
            }
        }
    } else {
        for d in children(Path::new("/usr/lib/jvm")) { add(d.join("bin/java")); }
    }
    if let Ok(h) = std::env::var("JAVA_HOME") { add(PathBuf::from(h).join("bin").join(crate::paths::JAVA_EXE)); }
    if let Some(p) = on_path() { add(p); }
    out
}

pub async fn list(force: bool) -> Vec<Java> {
    if !force {
        if let Some((at, l)) = CACHE.lock().unwrap().as_ref() { if at.elapsed().as_secs() < 30 { return l.clone(); } }
    }
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for (bin, managed) in candidates().await {
        let real = std::fs::canonicalize(&bin).unwrap_or_else(|_| bin.clone());
        if !seen.insert(real) { continue; }
        if let Some((version, major)) = version_of(&bin).await {
            list.push(Java { path: bin.to_string_lossy().into_owned(), version, major, managed });
        }
    }
    list.sort_by(|a, b| b.major.cmp(&a.major));
    *CACHE.lock().unwrap() = Some((std::time::Instant::now(), list.clone()));
    list
}

/// Exact major first (Blockyard's own preferred); Java 17+ servers also run on newer Java.
pub fn pick(list: &[Java], major: u32) -> Option<Java> {
    let exact: Vec<&Java> = list.iter().filter(|j| j.major == major).collect();
    if !exact.is_empty() { return Some(exact.iter().find(|j| j.managed).copied().unwrap_or(exact[0]).clone()); }
    if major >= 16 {
        let mut newer: Vec<&Java> = list.iter().filter(|j| j.major > major).collect();
        newer.sort_by_key(|j| j.major);
        return newer.first().map(|j| (*j).clone());
    }
    None
}

pub async fn find(major: u32) -> Option<Java> { pick(&list(false).await, major) }

pub type Log = std::sync::Arc<dyn Fn(String, Option<f64>) + Send + Sync>;

pub fn adoptium_url(feature: u32, os: &str, arch: &str) -> String {
    format!("https://api.adoptium.net/v3/binary/latest/{feature}/ga/{os}/{arch}/jre/hotspot/normal/eclipse")
}

/// Download Eclipse Temurin (JRE) into the managed folder. Returns the path to java.
pub async fn install(major: u32, log: Log) -> Result<String> {
    let feature = if major == 16 { 17 } else { major }; // Temurin never shipped 16 as LTS; 17 runs 1.17 fine.
    let os = if cfg!(target_os = "macos") { "mac" } else if cfg!(windows) { "windows" } else { "linux" };
    let mut arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    let root = managed_root();
    std::fs::create_dir_all(&root)?;
    let archive = root.join(format!("temurin-{feature}.{}", if cfg!(windows) { "zip" } else { "tar.gz" }));
    log(format!("Downloading Java {feature} (Eclipse Temurin)…"), None);
    let progress = |l: Log| move |got: u64, total: u64| {
        l(format!("Downloading Java {feature}… {:.1}{} MB", got as f64 / 1048576.0, if total > 0 { format!(" / {:.1}", total as f64 / 1048576.0) } else { String::new() }), (total > 0).then(|| got as f64 / total as f64));
    };
    if let Err(e) = net::download(&adoptium_url(feature, os, arch), &archive, progress(log.clone())).await {
        if arch != "aarch64" || os != "mac" { return Err(e); }
        log(format!("No Apple Silicon build of Java {feature}, using the Intel one (runs through Rosetta)."), None);
        arch = "x64";
        net::download(&adoptium_url(feature, os, arch), &archive, progress(log.clone())).await?;
    }
    log(format!("Unpacking Java {feature}…"), None);
    let dest = root.join(feature.to_string());
    let tmp = root.join(format!("{feature}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let (a, t) = (archive.clone(), tmp.clone());
    let r = tokio::task::spawn_blocking(move || if cfg!(windows) { crate::archive::extract_zip(&a, &t).map(|_| ()) } else { crate::archive::extract_tar_gz(&a, &t) }).await?;
    let _ = std::fs::remove_file(&archive);
    r.map_err(|e| anyhow::anyhow!("Couldn't unpack Java: {e}"))?;
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest)?;
    let bin = find_java_bin(&dest, 4).ok_or_else(|| anyhow::anyhow!("Java downloaded but bin/java was not found inside it."))?;
    *CACHE.lock().unwrap() = None;
    log(format!("Java {feature} is ready."), None);
    Ok(bin.to_string_lossy().into_owned())
}

pub async fn ensure(major: u32, log: Log) -> Result<String> {
    if let Some(j) = find(major).await {
        log(format!("Using Java {} at {}", j.version, j.path), None);
        return Ok(j.path);
    }
    install(major, log).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn j(major: u32, managed: bool) -> Java { Java { path: format!("/j{major}{managed}"), version: major.to_string(), major, managed } }
    #[test]
    fn picks_exact_then_newer() {
        let l = vec![j(25, false), j(21, false), j(21, true), j(8, false)];
        assert_eq!(pick(&l, 21).unwrap().path, "/j21true");
        assert_eq!(pick(&l, 17).unwrap().major, 21);
        assert!(pick(&l, 11).is_none());
        assert!(pick(&[j(21, false)], 8).is_none());
    }
}
