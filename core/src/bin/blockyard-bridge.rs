//! UI test bridge: runs the real engine and serves the web UI over plain HTTP so a headless browser
//! can drive it (the desktop app uses Tauri instead). Not shipped in the app.
//!
//!   blockyard-bridge --ui ui --data /tmp/data --port 0 [--router '{"gateway":…}']
//!
//! POST /call {channel,args} · GET /events (server-sent events) · POST /test/* for dialogs and timers.
use blockyard_core::{Ask, Core, CoreOpts, Host};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

struct TestHost { tx: broadcast::Sender<String>, answers: Mutex<VecDeque<usize>>, log: Mutex<Vec<Value>> }
impl TestHost {
    fn record(&self, v: Value) { self.log.lock().unwrap().push(v.clone()); let _ = self.tx.send(json!({ "event": "test:log", "payload": v }).to_string()); }
}
impl Host for TestHost {
    fn emit(&self, event: &str, payload: Value) { let _ = self.tx.send(json!({ "event": event, "payload": payload }).to_string()); }
    fn notify(&self, title: &str, body: &str, _always: bool) { self.record(json!({ "kind": "notify", "title": title, "body": body })); }
    fn ask(&self, a: Ask) -> BoxFuture<'static, usize> {
        let n = self.answers.lock().unwrap().pop_front().unwrap_or(0);
        self.record(json!({ "kind": "ask", "message": a.message, "answer": n }));
        Box::pin(async move { n })
    }
    fn open_url(&self, url: &str) { self.record(json!({ "kind": "open", "url": url })); }
}

struct Bridge { core: Arc<Core>, host: Arc<TestHost>, ui: PathBuf, picks: Mutex<VecDeque<Value>>, autostart: Mutex<bool> }

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

impl Bridge {
    async fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        match channel {
            // What the desktop app does natively: answered from queues set by the test.
            "dialog:pickFolder" => Ok(self.picks.lock().unwrap().pop_front().unwrap_or(Value::Null)),
            "dialog:pickFiles" => Ok(self.picks.lock().unwrap().pop_front().unwrap_or(json!([]))),
            "dialog:confirm" => { let n = self.host.answers.lock().unwrap().pop_front().unwrap_or(0); self.host.record(json!({ "kind": "confirm", "message": a(0)["message"], "answer": n })); Ok(json!(n)) }
            "shell:external" | "clipboard:write" | "files:reveal" | "files:open" | "addons:openFolder" | "backups:reveal" | "worlds:openSaves" | "app:openLogs" | "app:openRelease" | "app:reportIssue" => {
                self.host.record(json!({ "kind": channel, "args": args })); Ok(Value::Null)
            }
            "tray:set" => { self.core.store.set_settings(json!({ "menuBar": a(0) })).map_err(|e| e.to_string())?; Ok(a(0)) }
            "app:autostart" => { let mut v = self.autostart.lock().unwrap(); if let Some(b) = a(0).as_bool() { *v = b; } Ok(json!(*v)) }
            "icon:set" => {
                let pick = self.picks.lock().unwrap().pop_front();
                match pick {
                    Some(Value::String(p)) => self.core.call("icon:setFrom", vec![a(0), json!(p)]).await.map_err(|e| e.to_string()),
                    _ => Ok(Value::Null),
                }
            }
            _ => self.core.call(channel, args).await.map_err(|e| e.to_string()),
        }
    }
}

async fn respond(s: &mut tokio::net::TcpStream, code: u16, ctype: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {code} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = s.write_all(head.as_bytes()).await;
    let _ = s.write_all(body).await;
}

async fn serve(b: Arc<Bridge>, mut s: tokio::net::TcpStream) {
    let mut buf = vec![];
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        let n = match s.read(&mut tmp).await { Ok(0) | Err(_) => return, Ok(n) => n };
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let len: usize = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
    while buf.len() < head_end + len { let n = s.read(&mut tmp).await.unwrap_or(0); if n == 0 { break; } buf.extend_from_slice(&tmp[..n]); }
    let body: Value = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
    let mut parts = head.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/").split('?').next().unwrap_or("/").to_string());
    match (method, path.as_str()) {
        ("POST", "/call") => {
            let args = body["args"].as_array().cloned().unwrap_or_default();
            let r = match b.call(body["channel"].as_str().unwrap_or(""), args).await { Ok(v) => json!({ "ok": true, "value": v }), Err(e) => json!({ "ok": false, "error": e }) };
            respond(&mut s, 200, "application/json", r.to_string().as_bytes()).await;
        }
        ("GET", "/events") => {
            let mut rx = b.host.tx.subscribe();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: hi\n\n").await;
            loop {
                match rx.recv().await {
                    Ok(m) => { if s.write_all(format!("data: {m}\n\n").as_bytes()).await.is_err() { break; } }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
        ("POST", "/test/pick") => { b.picks.lock().unwrap().push_back(body); respond(&mut s, 200, "application/json", b"{}").await; }
        ("POST", "/test/answers") => { b.host.answers.lock().unwrap().extend(body.as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_u64().map(|n| n as usize))); respond(&mut s, 200, "application/json", b"{}").await; }
        ("POST", "/test/tick") => { b.core.run_timers_now(); respond(&mut s, 200, "application/json", b"{}").await; }
        ("GET", "/test/log") => { let l = json!(*b.host.log.lock().unwrap()); respond(&mut s, 200, "application/json", l.to_string().as_bytes()).await; }
        ("POST", "/test/shutdown") => { respond(&mut s, 200, "application/json", b"{}").await; b.core.shutdown(std::time::Duration::from_secs(20)).await; std::process::exit(0); }
        ("GET", p) => {
            let rel = if p == "/" { "index.html" } else { p.trim_start_matches('/') };
            let Some(file) = blockyard_core::archive::entry_path(&b.ui, rel) else { return respond(&mut s, 404, "text/plain", b"no").await };
            let file = if rel == "bridge-http.js" { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/ui/bridge-http.js") } else { file };
            match std::fs::read(&file) {
                Ok(mut data) => {
                    let ct = match file.extension().and_then(|e| e.to_str()) { Some("html") => "text/html; charset=utf-8", Some("js") => "text/javascript", Some("css") => "text/css", Some("png") => "image/png", _ => "application/octet-stream" };
                    if rel == "index.html" { data = String::from_utf8_lossy(&data).replace("<script src=\"bridge.js\"></script>", "<script src=\"bridge-http.js\"></script><script src=\"bridge.js\"></script>").into_bytes(); }
                    respond(&mut s, 200, ct, &data).await;
                }
                Err(_) => respond(&mut s, 404, "text/plain", b"not found").await,
            }
        }
        _ => respond(&mut s, 404, "text/plain", b"no").await,
    }
}

#[tokio::main]
async fn main() {
    let ui = PathBuf::from(arg("--ui").unwrap_or_else(|| "ui".into()));
    let data = PathBuf::from(arg("--data").expect("--data"));
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(0);
    let mapper = arg("--router").and_then(|r| serde_json::from_str::<Value>(&r).ok()).map(|v| blockyard_core::portmap::MapperOpts::from_json(&v));
    let (tx, _) = broadcast::channel(4096);
    let host = Arc::new(TestHost { tx, answers: Mutex::new(VecDeque::new()), log: Mutex::new(vec![]) });
    let core = Core::new(host.clone(), CoreOpts { data_dir: data, version: env!("CARGO_PKG_VERSION").into(), mapper, playit: None });
    core.start_background();
    let b = Arc::new(Bridge { core, host, ui, picks: Mutex::new(VecDeque::new()), autostart: Mutex::new(false) });
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("BRIDGE http://{}", l.local_addr().unwrap());
    loop {
        let Ok((s, _)) = l.accept().await else { continue };
        tokio::spawn(serve(b.clone(), s));
    }
}
