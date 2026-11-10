//! Unpacking .zip and .tar.gz files safely (nothing can be written outside the destination).
use crate::Result;
use std::path::{Path, PathBuf};

/// The relative path inside `dest` an archive entry may be written to, or None if it tries to escape.
pub fn entry_path(dest: &Path, name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.contains(':') { return None; }
    let mut out = dest.to_path_buf();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p => out.push(p),
        }
    }
    Some(out)
}

/// Extract every entry of a zip into `dest`, overwriting files. Returns the entry names.
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<Vec<String>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(zip_path)?)
        .map_err(|e| anyhow::anyhow!("That file is damaged or not a zip ({e})."))?;
    let mut names = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        let name = f.name().to_string();
        let Some(out) = entry_path(dest, &name) else { continue };
        if f.is_dir() { std::fs::create_dir_all(&out)?; names.push(name); continue; }
        if let Some(p) = out.parent() { std::fs::create_dir_all(p)?; }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut f, &mut w)?;
        #[cfg(unix)]
        if let Some(mode) = f.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777));
        }
        names.push(name);
    }
    Ok(names)
}

pub fn zip_entries(zip_path: &Path) -> Result<Vec<String>> {
    let z = zip::ZipArchive::new(std::fs::File::open(zip_path)?).map_err(|_| anyhow::anyhow!("That backup file is damaged or not a zip."))?;
    Ok(z.file_names().map(String::from).collect())
}

pub fn extract_tar_gz(file: &Path, dest: &Path) -> Result<()> {
    let gz = flate2::read::GzDecoder::new(std::fs::File::open(file)?);
    let mut ar = tar::Archive::new(gz);
    ar.set_preserve_permissions(true);
    for entry in ar.entries()? {
        let mut e = entry?;
        // unpack_in refuses paths that escape `dest`.
        e.unpack_in(dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_escaping_entries() {
        let d = Path::new("/srv/x");
        assert_eq!(entry_path(d, "world/level.dat"), Some(PathBuf::from("/srv/x/world/level.dat")));
        assert_eq!(entry_path(d, "../evil"), None);
        assert_eq!(entry_path(d, "/etc/passwd"), None);
        assert_eq!(entry_path(d, "a\\..\\..\\b"), None);
        assert_eq!(entry_path(d, "C:/x"), None);
    }
}
