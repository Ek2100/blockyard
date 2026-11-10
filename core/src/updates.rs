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

/// The download for this computer's OS from a release's assets (falls back to the release page).
pub fn pick_asset(release: &Value) -> String {
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let name = |a: &Value| a["name"].as_str().unwrap_or("").to_lowercase();
    let want: &[&str] = if cfg!(target_os = "macos") { &[".dmg", "mac", ".app.zip"] } else if cfg!(windows) { &["setup.exe", ".exe", ".msi"] } else { &[".appimage", ".deb"] };
    want.iter().find_map(|w| assets.iter().find(|a| name(a).contains(w)))
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
        assert_eq!(pick_asset(&json!({ "html_url": "https://x/rel", "assets": [] })), "https://x/rel");
        let u = issue_url("2.0.0");
        assert!(u.starts_with("https://github.com/Ek2100/blockyard/issues/new?body=") && u.contains("2.0.0"));
    }
}
