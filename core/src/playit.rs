//! playit.gg integration. Blockyard runs its own copy of playit's daemon (playitd) with its own secret
//! and control channel (a Unix socket on macOS/Linux, a named pipe on Windows), then talks to it with
//! playit's IPC protocol: newline-delimited JSON, version 3.
use crate::{net, now_ms, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

pub const IPC_VERSION: u32 = 3;
pub const API: &str = "https://api.playit.gg";
const RELEASES: &str = "https://github.com/playit-cloud/playit-agent/releases/latest/download";

/// What to download for this OS, and the daemon's file name. None = not supported here.
pub fn download_for_os() -> Option<(String, &'static str)> {
    if cfg!(target_os = "macos") { Some((format!("{RELEASES}/playit-macos-universal.tar.gz"), "playitd")) }
    else if cfg!(windows) { Some((format!("{RELEASES}/playitd-windows-x86_64.exe"), "playitd.exe")) }
    else { None }
}

async fn api(path: &str, body: Value, secret: Option<&str>) -> Result<Value> {
    let mut rb = net::client().post(net::route(&format!("{API}{path}"))).json(&body);
    if let Some(s) = secret { rb = rb.header("Authorization", format!("Agent-Key {s}")); }
    let res = rb.send().await.map_err(|e| anyhow::anyhow!("Couldn't reach playit.gg ({e})"))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("playit.gg answered HTTP {status}"))
}

fn tunnel_error(why: &str) -> String {
    match why {
        "RequiresVerifiedAccount" => "playit needs a verified account for this. Open the playit dashboard, verify your email, then try again.".into(),
        "AgentNotFound" => "playit doesn’t know this agent yet. Wait a few seconds and try again.".into(),
        "AgentVersionTooOld" => "The playit agent is too old. Reinstall it from the Public Access tab.".into(),
        "InvalidPortCount" => "playit rejected the port count.".into(),
        "RegionNotSupported" => "Your playit plan doesn’t support that region.".into(),
        w => format!("playit couldn’t create the tunnel ({w}). You can add it on the playit dashboard instead."),
    }
}

type Writer = Box<dyn tokio::io::AsyncWrite + Send + Unpin>;

#[derive(Default)]
struct St {
    phase: String,
    lifecycle: Value,
    stats: Value,
    error: Option<String>,
    logs: Vec<String>,
    claim: Option<Claim>,
    running: bool,
    stopping: bool,
    pid: Option<u32>,
}

#[derive(Clone)]
struct Claim { url: String, status: String, cancelled: bool }

pub struct Playit {
    pub dir: PathBuf,
    pub daemon_path: PathBuf,
    pub socket_path: String,
    pub download_url: Option<String>,
    st: Mutex<St>,
    writer: tokio::sync::Mutex<Option<Writer>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>,
    next_id: Mutex<u64>,
    kill: Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>,
    on_change: Mutex<Option<Box<dyn Fn(Value) + Send + Sync>>>,
}

pub struct PlayitOpts { pub daemon_path: Option<PathBuf>, pub socket_path: Option<String>, pub download_url: Option<String> }

fn default_socket() -> String {
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "u".into());
    let user: String = user.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if cfg!(windows) { format!(r"\\.\pipe\blockyard-playit-{user}") }
    else { std::env::temp_dir().join(format!("blockyard-playit-{user}.sock")).to_string_lossy().into_owned() }
}

impl Playit {
    pub fn new(dir: PathBuf, o: PlayitOpts) -> Arc<Playit> {
        let exe = download_for_os().map(|d| d.1).unwrap_or("playitd");
        Arc::new(Playit {
            daemon_path: o.daemon_path.unwrap_or_else(|| dir.join("bin").join(exe)),
            socket_path: o.socket_path.unwrap_or_else(default_socket),
            download_url: o.download_url.or_else(|| download_for_os().map(|d| d.0)),
            dir,
            st: Mutex::new(St { phase: "stopped".into(), ..Default::default() }),
            writer: tokio::sync::Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            kill: Mutex::new(None),
            on_change: Mutex::new(None),
        })
    }

    pub fn set_on_change(&self, f: impl Fn(Value) + Send + Sync + 'static) { *self.on_change.lock().unwrap() = Some(Box::new(f)); }
    fn secret_path(&self) -> PathBuf { self.dir.join("playit.toml") }
    fn log_path(&self) -> PathBuf { self.dir.join("playitd.log") }
    pub fn installed(&self) -> bool { self.daemon_path.is_file() }
    pub fn supported(&self) -> bool { self.download_url.is_some() || self.installed() }

    fn log(&self, msg: &str) {
        let mut s = self.st.lock().unwrap();
        s.logs.push(format!("{} {msg}", chrono::Local::now().format("%H:%M:%S")));
        if s.logs.len() > 300 { s.logs.remove(0); }
    }
    pub fn logs(&self) -> Vec<String> { let l = &self.st.lock().unwrap().logs; l[l.len().saturating_sub(200)..].to_vec() }

    pub fn snapshot(&self) -> Value {
        let s = self.st.lock().unwrap();
        let lc = &s.lifecycle;
        let state = lc["state"].as_str();
        let running = if state == Some("running") { &lc["data"] } else { &Value::Null };
        let tunnels: Vec<Value> = running["tunnels"].as_array().cloned().unwrap_or_default().iter().map(|t| json!({
            "id": t["id"], "address": t["display_address"], "destination": t["destination"], "disabled": t["is_disabled"], "disabledReason": t["disabled_reason"],
        })).collect();
        json!({
            "supported": self.download_url.is_some() || self.daemon_path.is_file(),
            "installed": self.daemon_path.is_file(), "daemon": if s.running { "running" } else { "stopped" }, "phase": s.phase,
            "lifecycle": state, "needsLink": matches!(state, Some("waiting_for_secret") | Some("has_invalid_secret")),
            "error": s.error.clone().map(Value::from).unwrap_or_else(|| lc["data"]["message"].clone()),
            "agentId": running["agent_id"], "accountStatus": running["account_status"], "loginLink": running["login_link"],
            "tunnels": tunnels, "pending": running["pending_tunnels"].as_array().cloned().unwrap_or_default(),
            "notices": running["notices"].as_array().cloned().unwrap_or_default(),
            "claim": s.claim.as_ref().map(|c| json!({ "url": c.url, "status": c.status })), "stats": s.stats,
        })
    }

    fn changed(&self) {
        let snap = self.snapshot();
        if let Some(f) = self.on_change.lock().unwrap().as_ref() { f(snap); }
    }

    pub fn tunnel_for_port(&self, port: u16) -> Option<Value> {
        let re = regex::Regex::new(&format!(r":{port}\b")).unwrap();
        self.snapshot()["tunnels"].as_array().cloned().unwrap_or_default().into_iter().find(|t| re.is_match(t["destination"].as_str().unwrap_or("")))
    }

    pub async fn install(&self, progress: impl Fn(String, Option<f64>) + Send + Sync) -> Result<()> {
        let Some(url) = self.download_url.clone() else { crate::bail!("playit.gg tunnels are available in Blockyard on macOS and Windows."); };
        let bin = self.daemon_path.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&bin)?;
        progress("Downloading the playit agent…".into(), Some(0.0));
        let file = self.dir.join(if url.ends_with(".tar.gz") { "playit.tar.gz" } else { "playitd.download" });
        net::download(&url, &file, |got, total| progress(format!("Downloading the playit agent… {:.1} MB", got as f64 / 1048576.0), (total > 0).then(|| got as f64 / total as f64))).await?;
        progress("Unpacking…".into(), None);
        if url.ends_with(".tar.gz") {
            let tmp = self.dir.join("unpack");
            let _ = std::fs::remove_dir_all(&tmp);
            std::fs::create_dir_all(&tmp)?;
            crate::archive::extract_tar_gz(&file, &tmp).map_err(|e| anyhow::anyhow!("Couldn’t unpack the playit agent: {e}"))?;
            let mut found = false;
            for e in walkdir::WalkDir::new(&tmp).into_iter().flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if e.file_type().is_file() && (n == "playitd" || n == "playit") {
                    let dest = bin.join(&n);
                    std::fs::copy(e.path(), &dest)?;
                    #[cfg(unix)]
                    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?; }
                    found |= n == "playitd";
                }
            }
            let _ = std::fs::remove_dir_all(&tmp);
            let _ = std::fs::remove_file(&file);
            if !found { crate::bail!("The playit download didn’t contain playitd."); }
        } else {
            std::fs::rename(&file, &self.daemon_path)?;
        }
        progress("playit agent installed.".into(), Some(1.0));
        self.changed();
        Ok(())
    }

    pub fn is_running(&self) -> bool { self.st.lock().unwrap().running }

    pub async fn start(self: &Arc<Self>) -> Result<()> {
        if self.is_running() { return Ok(()); }
        if !self.installed() { crate::bail!("Install the playit agent first."); }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
        self.log("Starting playitd");
        let mut child = crate::proc::command(&self.daemon_path)
            .arg("--secret-path").arg(self.secret_path()).arg("--socket-path").arg(&self.socket_path).arg("--log-path").arg(self.log_path())
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
            .kill_on_drop(true).spawn().map_err(|e| anyhow::anyhow!("Couldn't run playitd: {e}"))?;
        {
            let mut s = self.st.lock().unwrap();
            s.running = true; s.stopping = false; s.phase = "starting".into(); s.error = None; s.pid = child.id();
        }
        for r in [child.stdout.take().map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), child.stderr.take().map(|o| Box::new(o) as _)].into_iter().flatten() {
            let me = self.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(r).lines();
                while let Ok(Some(l)) = lines.next_line().await { if !l.trim().is_empty() { me.log(&l); } }
            });
        }
        let (ktx, mut krx) = tokio::sync::mpsc::unbounded_channel::<()>();
        *self.kill.lock().unwrap() = Some(ktx);
        let me = self.clone();
        tokio::spawn(async move {
            let code = tokio::select! {
                s = child.wait() => s.ok().and_then(|s| s.code()),
                _ = krx.recv() => { let _ = child.start_kill(); child.wait().await.ok().and_then(|s| s.code()) }
            };
            me.log(&format!("playitd exited ({})", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
            *me.writer.lock().await = None;
            {
                let mut s = me.st.lock().unwrap();
                if code.is_some_and(|c| c != 0) && !s.stopping { s.error = Some(format!("playitd stopped unexpectedly (exit {}).", code.unwrap())); }
                s.running = false; s.stopping = false; s.phase = "stopped".into(); s.pid = None;
            }
            me.fail_pending("playitd connection closed");
            me.changed();
        });
        self.changed();
        let mut connected = false;
        for _ in 0..80 {
            if !self.is_running() { let e = self.st.lock().unwrap().error.clone(); crate::bail!("{}", e.unwrap_or_else(|| "playitd exited during start-up.".into())); }
            if self.connect().await.is_ok() { connected = true; break; }
            tokio::time::sleep(Duration::from_millis(125)).await;
        }
        if !connected { self.stop(); crate::bail!("playitd didn’t open its control channel in time."); }
        let sub = self.request(json!({ "type": "subscribe" }), 10_000).await?;
        {
            let mut s = self.st.lock().unwrap();
            s.lifecycle = sub["snapshot"]["lifecycle"].clone();
            s.stats = sub["snapshot"]["stats"].clone();
            s.phase = sub["snapshot"]["status"]["phase"].as_str().unwrap_or("running").to_string();
        }
        self.changed();
        Ok(())
    }

    async fn connect(self: &Arc<Self>) -> Result<()> {
        #[cfg(unix)]
        let (r, w) = tokio::io::split(tokio::net::UnixStream::connect(&self.socket_path).await?);
        #[cfg(windows)]
        let (r, w) = tokio::io::split(tokio::net::windows::named_pipe::ClientOptions::new().open(&self.socket_path)?);
        let mut lines = tokio::io::BufReader::new(r).lines();
        // The daemon greets first.
        let hello = tokio::time::timeout(Duration::from_secs(3), lines.next_line()).await.map_err(|_| anyhow::anyhow!("no hello"))??;
        let msg: Value = serde_json::from_str(hello.as_deref().unwrap_or("")).unwrap_or_default();
        if msg["message_kind"] != "hello" {
            let why = msg["data"]["response"]["data"]["message"].as_str().unwrap_or("playitd refused the connection").to_string();
            crate::bail!("{why}");
        }
        *self.writer.lock().await = Some(Box::new(w));
        let me = self.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(msg) = serde_json::from_str::<Value>(line.trim()) { me.on_message(msg); }
            }
            me.fail_pending("playitd connection closed");
        });
        Ok(())
    }

    fn fail_pending(&self, why: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() { let _ = tx.send(Err(why.to_string())); }
    }

    fn on_message(&self, msg: Value) {
        match msg["message_kind"].as_str() {
            Some("response") => {
                let id = msg["data"]["request_id"].as_u64().unwrap_or(0);
                let resp = &msg["data"]["response"];
                if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(if resp["type"] == "error" { Err(resp["data"]["message"].as_str().unwrap_or("playitd error").into()) } else { Ok(resp["data"].clone()) });
                }
            }
            Some("event") => {
                let ev = &msg["data"]["event"];
                match ev["type"].as_str() {
                    Some("lifecycle") => self.st.lock().unwrap().lifecycle = ev["data"].clone(),
                    Some("status") => { let mut s = self.st.lock().unwrap(); if let Some(p) = ev["data"]["phase"].as_str() { s.phase = p.into(); } }
                    Some("stats") => { self.st.lock().unwrap().stats = ev["data"].clone(); return; }
                    Some("log") => { self.log(&format!("{} {}", ev["data"]["level"].as_str().unwrap_or(""), ev["data"]["message"].as_str().unwrap_or(""))); return; }
                    _ => return,
                }
                self.changed();
            }
            _ => {}
        }
    }

    pub async fn request(&self, request: Value, timeout_ms: u64) -> Result<Value> {
        let id = { let mut n = self.next_id.lock().unwrap(); *n += 1; *n };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        {
            let mut w = self.writer.lock().await;
            let Some(w) = w.as_mut() else { self.pending.lock().unwrap().remove(&id); crate::bail!("playit isn’t running.") };
            let line = json!({ "ipc_version": IPC_VERSION, "request_id": id, "request": request }).to_string() + "\n";
            w.write_all(line.as_bytes()).await?;
            w.flush().await?;
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => crate::bail!("{e}"),
            Ok(Err(_)) => crate::bail!("playitd connection closed"),
            Err(_) => { self.pending.lock().unwrap().remove(&id); crate::bail!("playitd didn’t answer in time.") }
        }
    }

    /// Link this agent to a playit account: open playit.gg/claim/<code>, wait for the user to approve
    /// it in the browser, swap the code for a secret and hand that to playitd.
    pub async fn link(self: &Arc<Self>, open_url: impl Fn(&str), poll_ms: u64, timeout_ms: i64) -> Result<()> {
        if !self.is_running() { self.start().await?; }
        if let Some(c) = self.st.lock().unwrap().claim.clone() {
            if c.status != "done" && c.status != "failed" { open_url(&c.url); return Ok(()); }
        }
        let code: String = (0..5).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
        let url = format!("https://playit.gg/claim/{code}");
        self.st.lock().unwrap().claim = Some(Claim { url: url.clone(), status: "waiting_for_visit".into(), cancelled: false });
        self.changed();
        open_url(&url);
        let end = now_ms() + timeout_ms;
        let r: Result<()> = async {
            loop {
                if self.claim_cancelled() { crate::bail!("Linking was cancelled."); }
                if now_ms() > end { crate::bail!("Linking timed out. Try again."); }
                let r = api("/claim/setup", json!({ "code": code, "agent_type": "assignable", "version": "Blockyard (playit agent)" }), None).await.unwrap_or(json!({ "status": "neterr" }));
                if r["status"] == "success" {
                    let status = match r["data"].as_str() { Some("WaitingForUser") => "waiting_for_approval", Some("UserAccepted") => "accepted", Some("UserRejected") => "rejected", _ => "waiting_for_visit" };
                    let changed = { let mut s = self.st.lock().unwrap(); let c = s.claim.as_mut().unwrap(); let ch = c.status != status; c.status = status.into(); ch };
                    if changed { self.changed(); }
                    if status == "rejected" { crate::bail!("The link was declined in the browser."); }
                    if status == "accepted" { break; }
                } else if r["status"] == "fail" && matches!(r["data"].as_str(), Some("CodeExpired") | Some("InvalidCode")) {
                    crate::bail!("The link code expired. Try again.");
                }
                tokio::time::sleep(Duration::from_millis(poll_ms)).await;
            }
            let secret = loop {
                if self.claim_cancelled() { crate::bail!("Linking was cancelled."); }
                let r = api("/claim/exchange", json!({ "code": code }), None).await.unwrap_or_default();
                if r["status"] == "success" { if let Some(s) = r["data"]["secret_key"].as_str() { break s.to_string(); } }
                if r["status"] == "fail" && matches!(r["data"].as_str(), Some("UserRejected") | Some("CodeExpired") | Some("CodeNotFound")) { crate::bail!("playit: {}", r["data"].as_str().unwrap()); }
                if now_ms() > end { crate::bail!("Linking timed out. Try again."); }
                tokio::time::sleep(Duration::from_millis(poll_ms)).await;
            };
            let res = self.request(json!({ "type": "set_secret", "secret": secret }), 10_000).await?;
            if res["accepted"] == false { crate::bail!("{}", res["message"].as_str().unwrap_or("playitd didn’t accept the new key.")); }
            Ok(())
        }.await;
        {
            let mut s = self.st.lock().unwrap();
            if let Some(c) = s.claim.as_mut() { c.status = if r.is_ok() { "done".into() } else { "failed".into() }; }
            if let Err(e) = &r { s.error = Some(e.to_string()); }
        }
        self.changed();
        r
    }

    fn claim_cancelled(&self) -> bool { self.st.lock().unwrap().claim.as_ref().is_some_and(|c| c.cancelled) }

    pub fn cancel_link(&self) {
        if let Some(c) = self.st.lock().unwrap().claim.as_mut() { c.cancelled = true; c.status = "failed".into(); }
        self.changed();
    }

    pub fn secret(&self) -> Option<String> {
        let t = std::fs::read_to_string(self.secret_path()).ok()?;
        let re = regex::Regex::new(r#"secret_key\s*=\s*"([^"]+)""#).unwrap();
        re.captures(&t).map(|c| c[1].to_string()).or_else(|| { let s = t.trim(); (!s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| s.to_string()) })
    }

    /// Create a Minecraft tunnel to 127.0.0.1:<port>: Java (TCP) by default, or Bedrock (UDP) for Geyser.
    pub async fn create_tunnel(&self, name: &str, port: u16, bedrock: bool) -> Result<Value> {
        let snap = self.snapshot();
        let Some(agent) = snap["agentId"].as_str().map(String::from) else { crate::bail!("Link playit first (the agent isn’t connected yet).") };
        if let Some(t) = self.tunnel_for_port(port) { return Ok(t); }
        let Some(secret) = self.secret() else { crate::bail!("playit has no key yet. Link your account first.") };
        let clean: String = name.chars().filter(|c| (' '..='~').contains(c)).take(22).collect();
        let r = api("/tunnels/create", json!({
            "name": format!("{}{}", if clean.is_empty() { "Minecraft".into() } else { clean }, if bedrock { " Bedrock" } else { "" }),
            "tunnel_type": if bedrock { "minecraft-bedrock" } else { "minecraft-java" }, "port_type": if bedrock { "udp" } else { "tcp" }, "port_count": 1,
            "origin": { "type": "agent", "data": { "agent_id": agent, "local_ip": "127.0.0.1", "local_port": port } },
            "enabled": true, "alloc": null, "firewall_id": null, "proxy_protocol": null,
        }), Some(&secret)).await?;
        if r["status"] != "success" {
            let why = r["data"].as_str().map(String::from).or_else(|| r["data"]["message"].as_str().map(String::from)).or_else(|| r["data"]["type"].as_str().map(String::from)).unwrap_or_else(|| r["data"].to_string());
            crate::bail!("{}", tunnel_error(&why));
        }
        self.log(&format!("Created tunnel {}", r["data"]["id"]));
        // The daemon picks up new tunnels on its next refresh; wait briefly for the address.
        for _ in 0..40 {
            if let Some(t) = self.tunnel_for_port(port) { return Ok(t); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(json!({ "id": r["data"]["id"], "address": null, "destination": format!("127.0.0.1:{port}"), "pending": true }))
    }

    pub fn stop(&self) {
        let pid = { let mut s = self.st.lock().unwrap(); if !s.running { return; } s.stopping = true; s.pid };
        // Ask nicely first, then make sure it's gone.
        #[cfg(unix)]
        if let Some(pid) = pid { crate::proc::terminate(pid); }
        let _ = pid;
        let k = self.kill.lock().unwrap().clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Some(k) = k { let _ = k.send(()); }
        });
    }

    pub async fn wait_stopped(&self) {
        for _ in 0..100 { if !self.is_running() { return; } tokio::time::sleep(Duration::from_millis(50)).await; }
    }
}
