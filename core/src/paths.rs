//! Where things live on each operating system.
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf { dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")) }

/// The official launcher's folder: ~/Library/Application Support/minecraft, %APPDATA%\.minecraft, ~/.minecraft.
pub fn minecraft_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join("minecraft")
    } else if cfg!(windows) {
        dirs::data_dir().unwrap_or_else(home).join(".minecraft")
    } else {
        home().join(".minecraft")
    }
}

pub fn default_saves_dir() -> PathBuf { minecraft_dir().join("saves") }

/// Where new servers go by default.
pub fn default_servers_parent() -> PathBuf {
    let docs = if cfg!(windows) { dirs::document_dir().unwrap_or_else(home) } else { home() };
    docs.join("Minecraft Servers")
}

/// The name of the Java executable on this OS.
pub const JAVA_EXE: &str = if cfg!(windows) { "java.exe" } else { "java" };

/// `a` is `b` or inside it (both must already be absolute and normalised).
pub fn is_within(a: &Path, b: &Path) -> bool { a == b || a.starts_with(b) }

/// Lexically normalise a path (resolve `.` and `..`) without touching the disk.
pub fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Make `p` absolute (relative to the current directory) and normalised.
pub fn absolute(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    normalize(&abs)
}
