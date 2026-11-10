//! Checks GitHub Releases for a newer Blockyard. It never installs anything: it tells people a new
//! version exists and opens the release page.
use crate::{net, Result};
use serde_json::{json, Value};

pub const REPO: &str = "Ek2100/blockyard";
pub const REPO_URL: &str = "https://github.com/Ek2100/blockyard";
pub const RELEASES_URL: &str = "https://github.com/Ek2100/blockyard/releases";
pub const API_LATEST: &str = "https://api.github.com/repos/Ek2100/blockyard/releases/latest";

/// "v1.2.10" → (1, 2, 10); pre-release suffixes are ignored for ordering.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let s = v.trim().trim_start_matches(['v', 'V']);
    let mut it = s.split(|c: char| !c.is_ascii_digit() && c != '.').next()?.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let c = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    Some((a, b, c))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(a), Some(b)) if a > b)
}

/// The download for this computer (OS and processor) from a release's assets (falls back to the release page).
pub fn pick_asset(release: &Value) -> String { pick_asset_for(release, std::env::consts::OS, std::env::consts::ARCH) }

pub fn pick_asset_for(release: &Value, os: &str, arch: &str) -> String {
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let name = |a: &Value| a["name"].as_str().unwrap_or("").to_lowercase();
    let arm = arch == "aarch64";
    // Arch words in our file names: x64/amd64 for Intel/AMD, arm64/aarch64 for ARM; Mac builds are universal.
    let arch_ok = |n: &str| {
        let is_arm = n.contains("arm64") || n.contains("aarch64");
        let is_x64 = n.contains("x64") || n.contains("amd64") || n.contains("x86_64");
        if arm { is_arm || (!is_x64) } else { !is_arm }
    };
    let kinds: &[&str] = match os { "macos" => &[".dmg", ".app.zip"], "windows" => &["setup.exe", ".msi", ".exe"], _ => &[".appimage", ".deb"] };
    let pick = |strict: bool| kinds.iter().find_map(|k| assets.iter().find(|a| { let n = name(a); n.ends_with(k) && !n.ends_with(".sha256") && (!strict || arch_ok(&n)) }));
    // Windows on ARM runs x64 builds too, so fall back to those if there's no ARM one.
    pick(true).or_else(|| if os == "windows" { pick(false) } else { None })
        .and_then(|a| a["browser_download_url"].as_str().map(String::from))
        .or_else(|| release["html_url"].as_str().map(String::from))
        .unwrap_or_else(|| RELEASES_URL.into())
}

/// Ask GitHub for the latest release.
pub async fn check(current: &str) -> Result<Value> {
    let none = || json!({ "current": current, "latest": null, "available": false, "url": RELEASES_URL });
    let res = net::client().get(net::route(API_LATEST)).header("Accept", "application/vnd.github+json").send().await
        .map_err(|e| anyhow::anyhow!("Couldn't reach GitHub ({e})."))?;
    if res.status().as_u16() == 404 { return Ok(none()); } // no published release yet
    if !res.status().is_success() { crate::bail!("GitHub answered {}. Try again later.", res.status().as_u16()); }
    let rel: Value = res.json().await?;
    if rel["draft"] == true || rel["prerelease"] == true { return Ok(none()); }
    let latest = rel["tag_name"].as_str().or(rel["name"].as_str()).unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    Ok(json!({
        "current": current, "latest": latest, "available": is_newer(&latest, current),
        "url": rel["html_url"].as_str().unwrap_or(RELEASES_URL), "download": pick_asset(&rel),
        "notes": rel["body"].as_str().unwrap_or("").chars().take(4000).collect::<String>(), "publishedAt": rel["published_at"],
    }))
}

/// A "new issue" link prefilled with the app version and OS (nothing personal).
pub fn issue_url(version: &str) -> String {
    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    let body = format!("**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n1. \n\n---\nBlockyard {version} · {os}\nIf it’s a crash, please attach the log from Help → Show Blockyard Logs.");
    format!("{REPO_URL}/issues/new?body={}", url::form_urlencoded::byte_serialize(body.as_bytes()).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_and_assets() {
        assert!(is_newer("v1.2.10", "1.2.9") && !is_newer("1.2.0", "1.2.0") && !is_newer("1.1.9", "1.2.0") && is_newer("2.0.0-beta", "1.9.9"));
        assert!(!is_newer("garbage", "1.0.0"));
        let rel = json!({ "html_url": "https://x/rel", "assets": [
            { "name": "Blockyard_2.0.0_aarch64.dmg", "browser_download_url": "https://x/mac" },
            { "name": "Blockyard_2.0.0_x64-setup.exe", "browser_download_url": "https://x/win" },
            { "name": "Blockyard_2.0.0_amd64.AppImage", "browser_download_url": "https://x/linux" }]});
        let want = if cfg!(target_os = "macos") { "https://x/mac" } else if cfg!(windows) { "https://x/win" } else { "https://x/linux" };
        assert_eq!(pick_asset(&rel), want);
        let full = json!({ "html_url": "https://x/rel", "assets": [
            { "name": "Blockyard_2.1.0_universal.dmg", "browser_download_url": "https://x/mac" },
            { "name": "Blockyard_2.1.0_x64-setup.exe", "browser_download_url": "https://x/win-x64" },
            { "name": "Blockyard_2.1.0_x64-setup.exe.sha256", "browser_download_url": "https://x/sha" },
            { "name": "Blockyard_2.1.0_arm64-setup.exe", "browser_download_url": "https://x/win-arm" },
            { "name": "Blockyard_2.1.0_amd64.AppImage", "browser_download_url": "https://x/lin-x64" },
            { "name": "Blockyard_2.1.0_aarch64.AppImage", "browser_download_url": "https://x/lin-arm" }]});
        assert_eq!(pick_asset_for(&full, "macos", "aarch64"), "https://x/mac");
        assert_eq!(pick_asset_for(&full, "macos", "x86_64"), "https://x/mac");
        assert_eq!(pick_asset_for(&full, "windows", "x86_64"), "https://x/win-x64");
        assert_eq!(pick_asset_for(&full, "windows", "aarch64"), "https://x/win-arm");
        assert_eq!(pick_asset_for(&full, "linux", "x86_64"), "https://x/lin-x64");
        assert_eq!(pick_asset_for(&full, "linux", "aarch64"), "https://x/lin-arm");
        let x64_only = json!({ "assets": [{ "name": "Blockyard_2.1.0_x64-setup.exe", "browser_download_url": "https://x/win-x64" }] });
        assert_eq!(pick_asset_for(&x64_only, "windows", "aarch64"), "https://x/win-x64", "Windows on ARM can run the x64 build");
        assert_eq!(pick_asset(&json!({ "html_url": "https://x/rel", "assets": [] })), "https://x/rel");
        let u = issue_url("2.0.0");
        assert!(u.starts_with("https://github.com/Ek2100/blockyard/issues/new?body=") && u.contains("2.0.0"));
    }
}
