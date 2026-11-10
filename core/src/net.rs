//! HTTP helpers: one shared client with a descriptive User-Agent, JSON/text fetches and streamed downloads.
//!
//! Tests (and the UI test bridge) can send every request to a local mock instead: with an override
//! base set, `https://api.modrinth.com/v2/search` becomes `<base>/api.modrinth.com/v2/search`.
use crate::Result;
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use std::path::Path;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const UA: &str = concat!("Blockyard/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Ek2100/blockyard)");

static OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// Route all outgoing requests to a mock server (tests only). `None` restores real URLs.
pub fn set_override(base: Option<String>) { *OVERRIDE.write().unwrap() = base; }

/// Apply the test override, if any. Local URLs (routers, 127.0.0.1) are never rewritten.
pub fn route(url: &str) -> String {
    let ov = OVERRIDE.read().unwrap().clone().or_else(|| std::env::var("BLOCKYARD_HTTP_OVERRIDE").ok().filter(|s| !s.is_empty()));
    match ov {
        Some(base) if url.starts_with("https://") => format!("{}/{}", base.trim_end_matches('/'), &url["https://".len()..]),
        _ => url.to_string(),
    }
}

/// One HTTP client per async runtime: pooled connections belong to the runtime that opened them, so a
/// client shared across runtimes fails with "runtime dropped the dispatch task" once the first one ends.
pub fn client() -> reqwest::Client {
    static C: OnceLock<std::sync::Mutex<Vec<(tokio::runtime::Handle, reqwest::Client)>>> = OnceLock::new();
    let handle = tokio::runtime::Handle::try_current().ok();
    // A stalled connection fails after 60 s of silence instead of hanging an install forever.
    let build = || reqwest::Client::builder().user_agent(UA).connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(60)).build().expect("http client");
    let Some(h) = handle else { return build() };
    let mut list = C.get_or_init(Default::default).lock().unwrap();
    if let Some((_, c)) = list.iter().find(|(rh, _)| rh.id() == h.id()) { return c.clone(); }
    let c = build();
    list.push((h, c.clone()));
    // The app has one runtime; tests make many. Keep the newest few.
    if list.len() > 8 { list.remove(0); }
    c
}

fn host_of(url: &str) -> String { url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| url.to_string()) }

pub async fn request(url: &str, accept_json: bool) -> Result<reqwest::Response> {
    let real = route(url);
    let mut rb = client().get(&real);
    // API calls get an overall limit; file downloads only the read timeout (they can be big).
    if accept_json { rb = rb.header("Accept", "application/json").timeout(Duration::from_secs(30)); }
    let res = rb.send().await.map_err(|e| {
        anyhow::anyhow!("Couldn't reach {}. Check your internet connection. ({})", host_of(url), short_err(&e))
    })?;
    if !res.status().is_success() {
        crate::bail!("{} answered HTTP {} for {}", host_of(url), res.status().as_u16(), url);
    }
    Ok(res)
}

fn short_err(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(x) = src { s = x.to_string(); src = x.source(); }
    s
}

pub async fn get_json<T: DeserializeOwned>(url: &str) -> Result<T> {
    let res = request(url, true).await?;
    let text = res.text().await?;
    serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("{} sent something unexpected ({e})", host_of(url)))
}

pub async fn get_text(url: &str) -> Result<String> { Ok(request(url, false).await?.text().await?) }

/// Stream a file to `dest` via `dest.part`. `progress(received, total)` is called at most every 150 ms.
pub async fn download(url: &str, dest: &Path, mut progress: impl FnMut(u64, u64) + Send) -> Result<()> {
    let res = request(url, false).await?;
    let total = res.content_length().unwrap_or(0);
    let tmp = dest.with_file_name(format!("{}.part", dest.file_name().unwrap_or_default().to_string_lossy()));
    if let Some(p) = dest.parent() { tokio::fs::create_dir_all(p).await?; }
    let result: Result<u64> = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        let mut got = 0u64;
        let mut last = std::time::Instant::now() - Duration::from_secs(1);
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("The download from {} was interrupted ({})", host_of(url), short_err(&e)))?;
            f.write_all(&chunk).await?;
            got += chunk.len() as u64;
            if last.elapsed() > Duration::from_millis(150) { last = std::time::Instant::now(); progress(got, total); }
        }
        f.flush().await?;
        f.sync_all().await.ok();
        Ok(got)
    }.await;
    match result {
        Ok(got) => {
            tokio::fs::rename(&tmp, dest).await?;
            progress(got, if total > 0 { total } else { got });
            Ok(())
        }
        Err(e) => { let _ = tokio::fs::remove_file(&tmp).await; Err(e) }
    }
}

pub fn sha512_file(p: &Path) -> Result<String> { hash_file::<sha2::Sha512>(p) }
pub fn sha256_file(p: &Path) -> Result<String> { hash_file::<sha2::Sha256>(p) }
pub fn sha1_file(p: &Path) -> Result<String> { hash_file::<sha1::Sha1>(p) }

fn hash_file<D: sha2::Digest>(p: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p)?;
    let mut h = D::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
