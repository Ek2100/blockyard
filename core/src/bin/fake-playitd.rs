//! A stand-in for playit's daemon, for tests. Speaks the IPC protocol (v3, newline-delimited JSON) on a
//! Unix socket (macOS/Linux) or a named pipe (Windows). Tunnels come from tunnels.json next to the secret.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

type Clients = Arc<Mutex<Vec<UnboundedSender<String>>>>;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

struct Paths { secret: PathBuf, tunnels: PathBuf, socket: String }

fn has_secret(p: &Paths) -> bool {
    std::fs::read_to_string(&p.secret).map(|t| regex::Regex::new(r#"secret_key = "[0-9a-f]+""#).unwrap().is_match(&t)).unwrap_or(false)
}
fn tunnels(p: &Paths) -> Value { std::fs::read_to_string(&p.tunnels).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!([])) }
fn lifecycle(p: &Paths) -> Value {
    if !has_secret(p) { return json!({ "state": "waiting_for_secret" }); }
    json!({ "state": "running", "data": { "version": "2.0.2", "tunnels": tunnels(p), "pending_tunnels": [], "notices": [], "account_status": "guest",
        "agent_id": "11111111-2222-3333-4444-555555555555", "login_link": "https://playit.gg/login/guest-account/abc", "start_time": 0 } })
}
fn status(p: &Paths) -> Value {
    json!({ "phase": if has_secret(p) { "running" } else { "waiting_for_secret" }, "pid": std::process::id(), "uptime_secs": 1, "version": "2.0.2",
        "socket_path": p.socket, "has_secret": has_secret(p), "protocol": { "ipc_version": 3, "capabilities": [] }, "last_error": null })
}
fn event(ev: Value) -> String { json!({ "message_kind": "event", "data": { "ipc_version": 3, "event": ev } }).to_string() + "\n" }
fn broadcast(c: &Clients, line: String) { c.lock().unwrap().retain(|tx| tx.send(line.clone()).is_ok()); }

async fn serve<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static>(stream: S, p: Arc<Paths>, clients: Clients) {
    let (r, mut w) = tokio::io::split(stream);
    let (tx, mut rx) = unbounded_channel::<String>();
    tokio::spawn(async move { while let Some(l) = rx.recv().await { if w.write_all(l.as_bytes()).await.is_err() { break; } let _ = w.flush().await; } });
    let _ = tx.send(json!({ "message_kind": "hello", "data": { "protocol": { "ipc_version": 3, "capabilities": ["stream_events", "secret_provisioning"] } } }).to_string() + "\n");
    let mut lines = tokio::io::BufReader::new(r).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg["request_id"].clone();
        let respond = |resp: Value| { let _ = tx.send(json!({ "message_kind": "response", "data": { "ipc_version": 3, "request_id": id, "response": resp } }).to_string() + "\n"); };
        match msg["request"]["type"].as_str() {
            Some("subscribe") => {
                clients.lock().unwrap().push(tx.clone());
                respond(json!({ "type": "subscribe", "data": { "protocol": { "ipc_version": 3, "capabilities": [] }, "snapshot": { "status": status(&p), "lifecycle": lifecycle(&p), "stats": { "bytes_in": 0, "bytes_out": 0, "active_tcp": 0, "active_udp": 0 } } } }));
            }
            Some("set_secret") => {
                let secret = msg["request"]["secret"].as_str().unwrap_or("");
                if secret.is_empty() || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
                    respond(json!({ "type": "error", "data": { "code": "invalid_secret", "message": "bad secret", "retryable": false, "details": null } }));
                    continue;
                }
                std::fs::write(&p.secret, format!("secret_key = \"{secret}\"\n")).unwrap();
                respond(json!({ "type": "set_secret", "data": { "accepted": true, "message": null } }));
                let (p2, c2) = (p.clone(), clients.clone());
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    broadcast(&c2, event(json!({ "type": "status", "data": status(&p2) })));
                    broadcast(&c2, event(json!({ "type": "lifecycle", "data": lifecycle(&p2) })));
                });
            }
            Some("stop") => { respond(json!({ "type": "stop", "data": { "accepted": true, "message": null } })); tokio::time::sleep(std::time::Duration::from_millis(20)).await; std::process::exit(0); }
            _ => respond(json!({ "type": "error", "data": { "code": "invalid_request_type", "message": "nope", "retryable": false, "details": null } })),
        }
    }
}

#[tokio::main]
async fn main() {
    let secret = PathBuf::from(arg("--secret-path").expect("--secret-path"));
    let socket = arg("--socket-path").expect("--socket-path");
    let p = Arc::new(Paths { tunnels: secret.parent().unwrap().join("tunnels.json"), secret, socket: socket.clone() });
    let clients: Clients = Arc::new(Mutex::new(vec![]));
    {
        let (p, c) = (p.clone(), clients.clone());
        tokio::spawn(async move {
            let mut last = tunnels(&p).to_string();
            let mut n = 0u32;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let now = tunnels(&p).to_string();
                if now != last { last = now; broadcast(&c, event(json!({ "type": "lifecycle", "data": lifecycle(&p) }))); }
                n += 1;
                if n % 10 == 0 { broadcast(&c, event(json!({ "type": "log", "data": { "level": "info", "target": "playitd", "message": "tick", "timestamp": 0 } }))); }
            }
        });
    }
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&socket);
        let l = tokio::net::UnixListener::bind(&socket).expect("bind socket");
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(serve(s, p.clone(), clients.clone()));
        }
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let mut server = ServerOptions::new().first_pipe_instance(true).create(&socket).expect("create pipe");
        loop {
            server.connect().await.unwrap();
            let connected = server;
            server = ServerOptions::new().create(&socket).unwrap();
            tokio::spawn(serve(connected, p.clone(), clients.clone()));
        }
    }
}
