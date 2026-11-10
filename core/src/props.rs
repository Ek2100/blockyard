//! server.properties: read and update while keeping comments, order and Java escaping intact.
use crate::Result;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$").unwrap());
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([^#!=:\s][^=:]*?)\s*[=:]").unwrap());

fn path(dir: &Path) -> std::path::PathBuf { dir.join("server.properties") }

/// Values exactly as written in the file (no unescaping). Missing file = empty map.
pub fn read_raw(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Ok(text) = std::fs::read_to_string(path(dir)) {
        for line in text.lines() {
            if let Some(c) = LINE.captures(line) { out.insert(c[1].to_string(), c[2].to_string()); }
        }
    }
    out
}

/// Values with Java properties escaping undone.
pub fn read(dir: &Path) -> (bool, BTreeMap<String, String>) {
    let exists = path(dir).exists();
    (exists, read_raw(dir).into_iter().map(|(k, v)| (k, unescape(&v))).collect())
}

pub fn get(dir: &Path, key: &str) -> Option<String> { read(dir).1.remove(key) }

pub fn port(dir: &Path) -> u16 {
    get(dir, "server-port").and_then(|p| p.trim().parse().ok()).filter(|p| *p > 0).unwrap_or(25565)
}

pub fn level_name(dir: &Path) -> String { get(dir, "level-name").filter(|s| !s.is_empty()).unwrap_or_else(|| "world".into()) }

pub fn unescape(v: &str) -> String {
    let mut out = String::new();
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' { out.push(c); continue; }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) if hex.len() == 4 => out.push(ch),
                    _ => { out.push('u'); out.push_str(&hex); }
                }
            }
            Some(n) => out.push(n),
            None => {}
        }
    }
    out
}

pub fn escape(v: &str) -> String {
    let mut out = String::new();
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ':' | '=' => { out.push('\\'); out.push(c); }
            ' '..='~' => out.push(c),
            _ => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) { out.push_str(&format!("\\u{:04x}", u)); }
            }
        }
    }
    out
}

/// Set some keys, keeping every other line as it was. New keys go at the end.
pub fn write(dir: &Path, updates: &BTreeMap<String, String>) -> Result<()> {
    let p = path(dir);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|_| "#Minecraft server properties".into());
    let mut pending = updates.clone();
    let mut out: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r')).map(|line| {
        if let Some(c) = KEY.captures(line) {
            if let Some(v) = pending.remove(&c[1]) { return format!("{}={}", &c[1], escape(&v)); }
        }
        line.to_string()
    }).collect();
    while out.last().is_some_and(|l| l.is_empty()) { out.pop(); }
    for (k, v) in pending { out.push(format!("{k}={}", escape(&v))); }
    std::fs::write(&p, out.join("\n") + "\n")?;
    Ok(())
}

pub fn set(dir: &Path, pairs: &[(&str, &str)]) -> Result<()> {
    write(dir, &pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_keeps_comments_and_escapes() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("server.properties"), "#Minecraft server properties\n#Mon\nmotd=Hello\\: world\nserver-port=25565\npvp=true\n").unwrap();
        let (exists, v) = read(d.path());
        assert!(exists);
        assert_eq!(v["motd"], "Hello: world");
        set(d.path(), &[("motd", "Café=1"), ("max-players", "5")]).unwrap();
        let text = std::fs::read_to_string(d.path().join("server.properties")).unwrap();
        assert_eq!(text, "#Minecraft server properties\n#Mon\nmotd=Caf\\u00e9\\=1\nserver-port=25565\npvp=true\nmax-players=5\n");
        assert_eq!(read(d.path()).1["motd"], "Café=1");
        assert_eq!(port(d.path()), 25565);
        assert_eq!(unescape("a\\u00e9b\\\\c"), "aéb\\c");
    }
}
