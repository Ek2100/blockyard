//! One running Minecraft server process: console in/out, state, players, CPU/memory and TPS probes.
use crate::{now_ms, props, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch};

const MAX_LOG: usize = 2500;
const NAME: &str = r"([.\w]{1,17})"; // Java names are 3–16 \w; Bedrock (Geyser/Floodgate) adds a leading "."

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]").unwrap());
static RE_DONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bDone \(\d+[.,]?\d*s\)!").unwrap());
static RE_JOIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\]: {NAME} joined the game\s*$")).unwrap());
static RE_LEAVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\]: {NAME} left the game\s*$")).unwrap());
static RE_LIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"There are (\d+)(?: of a max of |/)(\d+) players online:?\s*(.*)$").unwrap());
static RE_UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"UUID of player {NAME} is ([0-9a-f-]{{32,36}})")).unwrap());
static RE_PAPER_TPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"TPS from last 1m, 5m, 15m: \*?([\d.]+)").unwrap());
static RE_MSPT_HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Server tick times \(avg/min/max\)").unwrap());
static RE_MSPT_VALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([\d.]+)/([\d.]+)/([\d.]+)").unwrap());
static RE_VANILLA_MSPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Average time per tick: ([\d.]+)\s*ms").unwrap());
static RE_UNKNOWN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Unknown (or incomplete )?command|Unknown command\. Type|<--\[HERE\]|Incorrect argument for command").unwrap());
static RE_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^>\s?(\[)").unwrap());

/// Console lines that answer the background TPS probes (hidden from the console).
pub fn probe_answers(kind: &str) -> Vec<Regex> {
    let pats: &[&str] = if kind == "paper" {
        &[r"TPS from last 1m", r"Server tick times \(avg", r"^\S*\s*[\d.]+/[\d.]+/[\d.]+", r"\]: \W*[\d.]+/[\d.]+/[\d.]+,"]
    } else {
        &[r"The game is (running|frozen|sprinting|stepping)", r"Target tick rate", r"Average time per tick", r"Percentiles: "]
    };
    pats.iter().map(|p| Regex::new(p).unwrap()).collect()
}

/// Aikar's widely used G1 flags (docs.papermc.io/paper/aikars-flags), minus ones newer JDKs dropped.
pub const OPTIMIZED_FLAGS: &[&str] = &[
    "-XX:+IgnoreUnrecognizedVMOptions", "-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=30",
    "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4", "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:SurvivorRatio=32", "-XX:+PerfDisableSharedMem", "-XX:MaxTenuringThreshold=1",
    "-Dusing.aikars.flags=https://mcflags.emc.gs", "-Daikars.new.flags=true",
];

/// Split a command line like a shell would for simple cases: quotes group words (`-Dname="a b"` → `-Dname=a b`).
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in s.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => { quote = Some(c); has = true; }
            None if c.is_whitespace() => { if has { out.push(std::mem::take(&mut cur)); has = false; } }
            None => { cur.push(c); has = true; }
        }
    }
    if has { out.push(cur); }
    out
}

#[derive(Debug, Clone)]
pub enum Event {
    Line(Value),
    State(Value),
    Stats(Value),
    Metrics(Value),
    Player { join: bool, name: String },
    Exit { code: Option<i32>, expected: bool },
}

struct Hide { re: Regex, until: i64, command: String, unknown: bool }

#[derive(Clone)]
struct Player { name: String, uuid: Option<String>, joined_at: Option<i64> }

struct St {
    state: &'static str,
    sleeping: bool,
    log: VecDeque<Value>,
    players: Vec<Player>,
    max_players: Option<u32>,
    pid: Option<u32>,
    started_at: Option<i64>,
    stats: (f64, u64),
    last_exit: Value,
    metrics: (Option<f64>, Option<f64>, Option<i64>),
    hide: Vec<Hide>,
    unsupported: HashSet<String>,
    expect_mspt: bool,
    pending_uuid: Option<(String, String)>,
    stdin: Option<mpsc::UnboundedSender<String>>,
    kill: Option<mpsc::UnboundedSender<()>>,
    run: u64,
}

pub struct Instance {
    pub id: String,
    cfg: Mutex<Value>,
    st: Mutex<St>,
    lines: broadcast::Sender<Value>,
    exits: watch::Sender<u64>,
    listener: Box<dyn Fn(Event) + Send + Sync>,
}

impl Instance {
    pub fn new(cfg: Value, listener: impl Fn(Event) + Send + Sync + 'static) -> Arc<Instance> {
        Arc::new(Instance {
            id: cfg["id"].as_str().unwrap_or_default().to_string(),
            cfg: Mutex::new(cfg),
            st: Mutex::new(St {
                state: "stopped", sleeping: false, log: VecDeque::new(), players: vec![], max_players: None, pid: None, started_at: None,
                stats: (0.0, 0), last_exit: Value::Null, metrics: (None, None, None), hide: vec![], unsupported: HashSet::new(),
                expect_mspt: false, pending_uuid: None, stdin: None, kill: None, run: 0,
            }),
            lines: broadcast::channel(512).0,
            exits: watch::channel(0).0,
            listener: Box::new(listener),
        })
    }

    pub fn cfg(&self) -> Value { self.cfg.lock().unwrap().clone() }
    pub fn set_cfg(&self, cfg: Value) { *self.cfg.lock().unwrap() = cfg; }
    pub fn dir(&self) -> PathBuf { PathBuf::from(self.cfg()["dir"].as_str().unwrap_or_default()) }

    pub fn is_running(&self) -> bool { self.st.lock().unwrap().pid.is_some() }
    pub fn state(&self) -> &'static str { self.st.lock().unwrap().state }
    pub fn pid(&self) -> Option<u32> { self.st.lock().unwrap().pid }
    pub fn started_at(&self) -> Option<i64> { self.st.lock().unwrap().started_at }
    pub fn stats(&self) -> (f64, u64) { self.st.lock().unwrap().stats }
    pub fn metrics(&self) -> (Option<f64>, Option<f64>, Option<i64>) { self.st.lock().unwrap().metrics }
    pub fn player_names(&self) -> Vec<String> { self.st.lock().unwrap().players.iter().map(|p| p.name.clone()).collect() }
    pub fn player_count(&self) -> usize { self.st.lock().unwrap().players.len() }
    pub fn player_uuid(&self, name: &str) -> Option<String> {
        self.st.lock().unwrap().players.iter().find(|p| p.name == name).and_then(|p| p.uuid.clone())
    }
    pub fn log(&self) -> Vec<Value> { self.st.lock().unwrap().log.iter().cloned().collect() }

    fn snap(&self, s: &St) -> Value {
        json!({
            "id": self.id,
            "state": if s.state == "stopped" && s.sleeping { "sleeping" } else { s.state },
            "players": s.players.iter().map(|p| json!({ "name": p.name, "uuid": p.uuid, "joinedAt": p.joined_at })).collect::<Vec<_>>(),
            "maxPlayers": s.max_players, "startedAt": s.started_at,
            "stats": { "cpu": s.stats.0, "memMB": s.stats.1 }, "lastExit": s.last_exit, "pid": s.pid,
            "metrics": { "tps": s.metrics.0, "mspt": s.metrics.1, "at": s.metrics.2 },
        })
    }
    pub fn snapshot(&self) -> Value { let s = self.st.lock().unwrap(); self.snap(&s) }

    fn emit(&self, e: Event) { (self.listener)(e); }

    fn set_state(&self, state: &'static str) {
        let snap = { let mut s = self.st.lock().unwrap(); s.state = state; self.snap(&s) };
        self.emit(Event::State(snap));
    }

    /// Show the "sleeping" state (wake-on-join listener active) while stopped.
    pub fn set_sleeping(&self, on: bool) {
        let snap = { let mut s = self.st.lock().unwrap(); if s.sleeping == on { return; } s.sleeping = on; self.snap(&s) };
        self.emit(Event::State(snap));
    }
    pub fn is_sleeping(&self) -> bool { self.st.lock().unwrap().sleeping }

    pub fn push_line(&self, text: &str, source: &str) {
        let entry = json!({ "t": now_ms(), "text": text, "source": source });
        {
            let mut s = self.st.lock().unwrap();
            s.log.push_back(entry.clone());
            while s.log.len() > MAX_LOG { s.log.pop_front(); }
        }
        let _ = self.lines.send(entry.clone());
        self.emit(Event::Line(entry));
    }
    /// A message from Blockyard itself in the console.
    pub fn info(&self, msg: &str) { self.push_line(msg, "app"); }

    pub fn build_args(&self) -> Vec<String> {
        let cfg = self.cfg();
        let mem = cfg["memoryMB"].as_u64().unwrap_or(2048).max(512);
        let optimized = cfg["optimizedFlags"].as_bool().unwrap_or(false);
        let xms = if optimized { mem } else { mem.min(1024) }; // Aikar's flags expect Xms = Xmx
        let mut a = vec![format!("-Xms{xms}M"), format!("-Xmx{mem}M")];
        if optimized { a.extend(OPTIMIZED_FLAGS.iter().map(|s| s.to_string())); }
        a.extend(split_args(cfg["jvmArgs"].as_str().unwrap_or("")));
        match cfg["launchArgs"].as_array() {
            Some(l) if !l.is_empty() => a.extend(l.iter().filter_map(|v| v.as_str().map(String::from))),
            _ => a.extend(["-jar".to_string(), "server.jar".to_string()]),
        }
        if cfg["noGui"].as_bool() != Some(false) { a.push("nogui".into()); }
        a
    }

    pub async fn start(self: &Arc<Self>, java: &str, keep_awake: bool) -> Result<()> {
        if self.is_running() { crate::bail!("This server is already running."); }
        let dir = self.dir();
        if !dir.is_dir() { crate::bail!("The server folder is missing: {}", dir.display()); }
        let port = props::port(&dir);
        if !port_free(port).await {
            crate::bail!("Port {port} is already in use, maybe by another server. Stop it or change \"server-port\" in Properties.");
        }
        let args = self.build_args();
        {
            let mut s = self.st.lock().unwrap();
            s.players.clear(); s.max_players = None; s.last_exit = Value::Null; s.metrics = (None, None, None);
            s.hide.clear(); s.unsupported.clear(); s.pending_uuid = None; s.expect_mspt = false; s.sleeping = false;
        }
        let shown = if std::path::Path::new(java).file_stem().is_some_and(|s| s == "java") { java.to_string() } else { "java".into() };
        self.info(&format!("Starting server with: {shown} {}", args.join(" ")));

        let mut child = crate::proc::command(java)
            .args(&args)
            .current_dir(&dir)
            .env("TERM", "dumb")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false)
            .spawn()
            .map_err(|e| anyhow::anyhow!("Couldn't start Java ({java}): {e}"))?;
        let pid = child.id().unwrap_or(0);
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();
        let run = {
            let mut s = self.st.lock().unwrap();
            s.pid = Some(pid); s.started_at = Some(now_ms()); s.stdin = Some(in_tx); s.kill = Some(kill_tx); s.run += 1;
            s.run
        };
        self.set_state("starting");

        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            while let Some(cmd) = in_rx.recv().await {
                if stdin.write_all(cmd.as_bytes()).await.is_err() || stdin.flush().await.is_err() { break; }
            }
        });
        let out = tokio::spawn(read_stream(self.clone(), child.stdout.take().unwrap()));
        let err = tokio::spawn(read_stream(self.clone(), child.stderr.take().unwrap()));

        let awake = if keep_awake { crate::proc::KeepAwake::start(pid) } else { None };
        // CPU + memory every 2.5 s.
        let me = self.clone();
        tokio::spawn(async move {
            let mut sampler = crate::proc::Sampler::default();
            loop {
                tokio::time::sleep(Duration::from_millis(2500)).await;
                if me.st.lock().unwrap().run != run || !me.is_running() { break; }
                if let Some((cpu, mem)) = sampler.sample(pid) {
                    me.st.lock().unwrap().stats = (cpu, mem);
                    me.emit(Event::Stats(json!({ "cpu": cpu, "memMB": mem })));
                }
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx.recv() => { let _ = child.kill().await; child.wait().await.ok() }
            };
            let _ = out.await;
            let _ = err.await;
            drop(awake);
            me.on_exit(status.and_then(|s| s.code()));
        });
        Ok(())
    }

    fn on_exit(&self, code: Option<i32>) {
        let expected = {
            let mut s = self.st.lock().unwrap();
            let expected = s.state == "stopping";
            s.pid = None; s.stdin = None; s.kill = None; s.players.clear(); s.started_at = None; s.stats = (0.0, 0);
            s.last_exit = code.map(|c| json!(c)).unwrap_or(json!("killed"));
            expected
        };
        let clean = expected || code == Some(0);
        self.info(&if clean { "Server stopped.".to_string() } else {
            format!("Server stopped unexpectedly (exit {}). Check the lines above for the error.", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into()))
        });
        self.set_state("stopped");
        self.exits.send_modify(|n| *n += 1);
        self.emit(Event::Exit { code, expected });
    }

    fn handle_line(&self, raw: &str) {
        // Console prompts like ">" and carriage-return redraws: keep the last real segment.
        let clean = ANSI.replace_all(raw, "");
        let seg = clean.split('\r').filter(|s| !s.trim().is_empty()).last().unwrap_or("");
        let line = RE_PROMPT.replace(seg, "$1");
        let line = line.trim_end();
        if line.is_empty() { return; }
        let now = now_ms();
        let hidden = {
            let mut s = self.st.lock().unwrap();
            s.hide.retain(|h| h.until > now);
            let hit = s.hide.iter().position(|h| h.re.is_match(line)).map(|i| (s.hide[i].command.clone(), s.hide[i].unknown));
            match &hit {
                // Answered: an "unknown command" line later belongs to a different probe.
                Some((cmd, false)) => { let c = cmd.clone(); s.hide.retain(|h| !(h.unknown && h.command == c)); }
                // Not supported: that probe's answer filters are no longer needed.
                // (keep its "unknown" filter: the error spans two lines).
                Some((cmd, true)) => { let c = cmd.clone(); s.hide.retain(|h| h.command != c || h.unknown); }
                None => {}
            }
            hit
        };
        self.parse_metrics(line, hidden.as_ref());
        if hidden.is_some() { return; }
        self.push_line(line, "server");
        self.parse(line);
    }

    fn parse_metrics(&self, line: &str, hidden: Option<&(String, bool)>) {
        let mut s = self.st.lock().unwrap();
        if let Some((cmd, true)) = hidden { s.unsupported.insert(cmd.clone()); return; }
        let now = Some(now_ms());
        let changed = if let Some(c) = RE_PAPER_TPS.captures(line) {
            s.metrics.0 = c[1].parse::<f64>().ok().map(|t| t.min(20.0)); s.metrics.2 = now; true
        } else if RE_MSPT_HEAD.is_match(line) {
            s.expect_mspt = true; false
        } else if s.expect_mspt && RE_MSPT_VALS.is_match(line) {
            let c = RE_MSPT_VALS.captures(line).unwrap();
            s.expect_mspt = false; s.metrics.1 = c[1].parse().ok(); s.metrics.2 = now; true
        } else if let Some(c) = RE_VANILLA_MSPT.captures(line) {
            // Vanilla only reports time per tick; the server can't exceed 20 TPS and falls behind past 50 ms.
            let mspt: f64 = c[1].parse().unwrap_or(0.0);
            s.metrics = (Some(if mspt > 0.0 { (1000.0 / mspt.max(50.0)).min(20.0) } else { 20.0 }), Some(mspt), now); true
        } else { false };
        if changed {
            let m = json!({ "tps": s.metrics.0, "mspt": s.metrics.1, "at": s.metrics.2 });
            drop(s);
            self.emit(Event::Metrics(m));
        }
    }

    fn parse(&self, line: &str) {
        if self.state() == "starting" && RE_DONE.is_match(line) { self.set_state("online"); return; }
        if let Some(c) = RE_UUID.captures(line) {
            let mut s = self.st.lock().unwrap();
            match s.players.iter_mut().find(|p| p.name == c[1]) {
                Some(p) => p.uuid = Some(c[2].to_string()),
                None => s.pending_uuid = Some((c[1].to_string(), c[2].to_string())),
            }
            return;
        }
        if let Some(c) = RE_JOIN.captures(line) {
            let name = c[1].to_string();
            let snap = {
                let mut s = self.st.lock().unwrap();
                let uuid = s.pending_uuid.take().filter(|(n, _)| *n == name).map(|(_, u)| u);
                s.players.retain(|p| p.name != name);
                s.players.push(Player { name: name.clone(), uuid, joined_at: Some(now_ms()) });
                self.snap(&s)
            };
            self.emit(Event::Player { join: true, name });
            self.emit(Event::State(snap));
            return;
        }
        if let Some(c) = RE_LEAVE.captures(line) {
            let name = c[1].to_string();
            let snap = {
                let mut s = self.st.lock().unwrap();
                let before = s.players.len();
                s.players.retain(|p| p.name != name);
                (s.players.len() != before).then(|| self.snap(&s))
            };
            if let Some(snap) = snap { self.emit(Event::Player { join: false, name }); self.emit(Event::State(snap)); }
            return;
        }
        if let Some(c) = RE_LIST.captures(line) {
            let snap = {
                let mut s = self.st.lock().unwrap();
                s.max_players = c[2].parse().ok();
                static COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new("§.").unwrap());
                let names: Vec<String> = c[3].split(',').map(|x| COLOR.replace_all(x.trim(), "").to_string()).filter(|x| !x.is_empty())
                    .map(|x| x.rsplit(' ').next().unwrap_or(&x).to_string()).collect(); // strip rank prefixes
                let old = std::mem::take(&mut s.players);
                s.players = names.into_iter().map(|n| old.iter().find(|p| p.name == n).cloned().unwrap_or(Player { name: n, uuid: None, joined_at: None })).collect();
                self.snap(&s)
            };
            self.emit(Event::State(snap));
        }
    }

    /// Run a command without echoing it, hiding its answer for `ms`. "Unknown command" disables the probe.
    pub fn probe(&self, command: &str, answers: Vec<Regex>, ms: i64) -> bool {
        let mut s = self.st.lock().unwrap();
        if s.pid.is_none() || s.state != "online" || s.unsupported.contains(command) { return false; }
        let until = now_ms() + ms;
        for re in answers { s.hide.push(Hide { re, until, command: command.into(), unknown: false }); }
        s.hide.push(Hide { re: RE_UNKNOWN.clone(), until, command: command.into(), unknown: true });
        s.stdin.as_ref().map(|tx| tx.send(format!("{command}\n")).is_ok()).unwrap_or(false)
    }

    /// Type a command into the console.
    pub fn send(self: &Arc<Self>, command: &str) -> Result<()> {
        let cmd = command.trim().trim_start_matches('/').trim().to_string();
        let tx = { let s = self.st.lock().unwrap(); s.stdin.clone() };
        let Some(tx) = tx else { crate::bail!("The server is not running.") };
        if cmd.is_empty() { return Ok(()); }
        self.push_line(&cmd, "cmd");
        // The user is typing: never risk hiding their output behind a background probe's filter.
        self.st.lock().unwrap().hide.clear();
        let _ = tx.send(format!("{cmd}\n"));
        if cmd.eq_ignore_ascii_case("stop") { self.mark_stopping(); }
        Ok(())
    }

    fn mark_stopping(self: &Arc<Self>) {
        self.set_state("stopping");
        let me = self.clone();
        let mut ex = self.exits.subscribe();
        let start = *ex.borrow();
        // Force-close after 60 s if it ignores "stop".
        tokio::spawn(async move {
            let limit = std::env::var("BLOCKYARD_STOP_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000);
            let waited = tokio::time::timeout(Duration::from_millis(limit), async {
                while ex.changed().await.is_ok() { if *ex.borrow() != start { break; } }
            }).await;
            if waited.is_err() && me.is_running() {
                me.info("The server didn't stop within 60 seconds, so it was force-closed.");
                let k = me.st.lock().unwrap().kill.clone();
                if let Some(k) = k { let _ = k.send(()); }
            }
        });
    }

    pub fn stop(self: &Arc<Self>) {
        let (running, state, tx) = { let s = self.st.lock().unwrap(); (s.pid.is_some(), s.state, s.stdin.clone()) };
        if !running || state == "stopping" { return; }
        self.push_line("stop", "cmd");
        if let Some(tx) = tx { let _ = tx.send("stop\n".into()); }
        self.mark_stopping();
    }

    pub fn kill(&self) {
        let k = { let mut s = self.st.lock().unwrap(); if s.pid.is_none() { return; } s.state = "stopping"; s.kill.clone() };
        self.info("Force-stopping the server…");
        if let Some(k) = k { let _ = k.send(()); }
    }

    /// The first server console line matching `re`, or an error after `ms` / when the server stops.
    pub async fn wait_for_line(&self, re: &Regex, ms: u64) -> Result<String> {
        let mut rx = self.lines.subscribe();
        let mut ex = self.exits.subscribe();
        let start = *ex.borrow();
        let fut = async {
            loop {
                tokio::select! {
                    l = rx.recv() => match l {
                        Ok(e) => if e["source"] == "server" && re.is_match(e["text"].as_str().unwrap_or("")) { return Ok(e["text"].as_str().unwrap_or("").to_string()); },
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => crate::bail!("The server stopped."),
                    },
                    r = ex.changed() => if r.is_err() || *ex.borrow() != start { crate::bail!("The server stopped.") },
                }
            }
        };
        tokio::time::timeout(Duration::from_millis(ms), fut).await.map_err(|_| anyhow::anyhow!("timeout"))?
    }

    /// Resolves when the current run exits (immediately if not running).
    pub async fn wait_for_exit(&self) {
        let mut ex = self.exits.subscribe();
        let start = *ex.borrow();
        if !self.is_running() { return; }
        while ex.changed().await.is_ok() { if *ex.borrow() != start { return; } }
    }
}

async fn read_stream(inst: Arc<Instance>, mut r: impl tokio::io::AsyncRead + Unpin) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=i).collect();
                    inst.handle_line(&String::from_utf8_lossy(&line[..line.len() - 1]));
                }
            }
        }
    }
    if !buf.is_empty() { inst.handle_line(&String::from_utf8_lossy(&buf)); }
}

/// Is a TCP port free on all interfaces?
pub async fn port_free(port: u16) -> bool {
    tokio::net::TcpListener::bind(("0.0.0.0", port)).await.is_ok()
}
