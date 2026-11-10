//! The engine: every server, the scheduler, public access, stats and all UI channels.
use crate::host::{Ask, Host};
use crate::instance::{Event, Instance};
use crate::java::Log;
use crate::playit::{Playit, PlayitOpts};
use crate::portmap::{Mapper, MapperOpts};
use crate::stats::Stats;
use crate::store::Store;
use crate::wake::{WakeListener, WakeOpts};
use crate::{backups, files, geyser, installer, java, modrinth, mrpack, now_ms, props, providers, updates, versions, worlds, Result};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

pub struct CoreOpts {
    pub data_dir: PathBuf,
    pub version: String,
    /// Test hooks (fake router / fake playitd).
    pub mapper: Option<MapperOpts>,
    pub playit: Option<PlayitOpts>,
}

pub struct Core {
    me: Weak<Core>,
    pub host: Arc<dyn Host>,
    pub data_dir: PathBuf,
    pub version: String,
    pub store: Store,
    pub stats: Stats,
    pub mapper: Arc<Mapper>,
    pub playit: Arc<Playit>,
    instances: Mutex<HashMap<String, Arc<Instance>>>,
    upnp: Mutex<HashMap<String, Value>>,
    bedrock: Mutex<HashMap<String, Value>>,
    last_diag: Mutex<Option<Value>>,
    backup_busy: Mutex<HashSet<String>>,
    crash_log: Mutex<HashMap<String, Vec<i64>>>,
    restarting: Mutex<HashSet<String>>,
    warned: Mutex<HashMap<String, (String, bool, bool)>>,
    sched_last: Mutex<HashMap<String, i64>>,
    prev_state: Mutex<HashMap<String, &'static str>>,
    run_started: Mutex<HashMap<String, i64>>,
    empty_since: Mutex<HashMap<String, i64>>,
    going_to_sleep: Mutex<HashSet<String>>,
    sleepers: tokio::sync::Mutex<HashMap<String, WakeListener>>,
}

// ---------- small JSON helpers ----------
fn s(v: &Value) -> &str { v.as_str().unwrap_or("") }
fn arg<'a>(a: &'a [Value], i: usize) -> &'a Value { a.get(i).unwrap_or(&Value::Null) }
fn arg_str(a: &[Value], i: usize) -> String { s(arg(a, i)).to_string() }
fn dir_of(cfg: &Value) -> PathBuf { PathBuf::from(s(&cfg["dir"])) }
fn kind_of(cfg: &Value) -> String { cfg["kind"].as_str().unwrap_or("none").to_string() }
fn obj(v: &Value) -> Map<String, Value> { v.as_object().cloned().unwrap_or_default() }
fn ok() -> Result<Value> { Ok(Value::Null) }
fn trash(p: &Path) -> Result<()> { trash::delete(p).map_err(|e| anyhow::anyhow!("Couldn't move it to the Trash ({e}).")) }

/// The kinds of public access that expose the server to the internet.
pub fn is_public(method: &str) -> bool { matches!(method, "upnp" | "playit" | "manual" | "ipv6") }

impl Core {
    pub fn new(host: Arc<dyn Host>, o: CoreOpts) -> Arc<Core> {
        let _ = std::fs::create_dir_all(&o.data_dir);
        java::set_managed_root(o.data_dir.join("java"));
        let playit = Playit::new(o.data_dir.join("playit"), o.playit.unwrap_or(PlayitOpts { daemon_path: None, socket_path: None, download_url: None }));
        let core = Arc::new_cyclic(|me| Core {
            me: me.clone(),
            host,
            store: Store::open(&o.data_dir),
            stats: Stats::new(o.data_dir.join("stats")),
            mapper: Mapper::new(o.mapper.unwrap_or_else(MapperOpts::real)),
            playit,
            version: o.version,
            data_dir: o.data_dir,
            instances: Mutex::default(), upnp: Mutex::default(), bedrock: Mutex::default(), last_diag: Mutex::default(),
            backup_busy: Mutex::default(), crash_log: Mutex::default(), restarting: Mutex::default(), warned: Mutex::default(),
            sched_last: Mutex::default(), prev_state: Mutex::default(), run_started: Mutex::default(), empty_since: Mutex::default(),
            going_to_sleep: Mutex::default(), sleepers: tokio::sync::Mutex::default(),
        });
        let w = core.me.clone();
        core.playit.set_on_change(move |snap| {
            if let Some(c) = w.upgrade() {
                c.host.emit("playit:state", snap);
                for cfg in c.store.list() { if c.access_of(&cfg)["method"] == "playit" { c.push_access(s(&cfg["id"])); } }
            }
        });
        let w = core.me.clone();
        *core.mapper.on_error.lock().unwrap() = Some(Box::new(move |port, e| { if let Some(c) = w.upgrade() { c.log("warn", &format!("port {port} renewal failed: {e}")); } }));
        core.log("info", &format!("Blockyard {} starting on {} {}", core.version, std::env::consts::OS, std::env::consts::ARCH));
        core
    }

    fn arc(&self) -> Arc<Core> { self.me.upgrade().expect("core alive") }

    // ---------- app log (data/logs/blockyard.log) ----------
    pub fn log_dir(&self) -> PathBuf { self.data_dir.join("logs") }
    pub fn log(&self, level: &str, msg: &str) {
        let dir = self.log_dir();
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("blockyard.log");
        if std::fs::metadata(&f).map(|m| m.len() > 5 * 1048576).unwrap_or(false) { let _ = std::fs::rename(&f, dir.join("blockyard.log.1")); }
        use std::io::Write;
        if let Ok(mut h) = std::fs::OpenOptions::new().create(true).append(true).open(&f) {
            let _ = writeln!(h, "{} [{level}] {msg}", chrono::Utc::now().to_rfc3339());
        }
    }

    /// Start the timers: stats sampling, scheduled backups/restarts/commands, sleep mode, stats saving.
    pub fn start_background(self: &Arc<Self>) {
        let w = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut n: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(c) = w.upgrade() else { break };
                n += 1;
                if n % 2 == 0 { c.sample_metrics(); }
                if n % 3 == 0 { c.run_schedules(now_ms()); }
                if n % 4 == 0 { c.scheduler_tick(); c.sleep_tick(now_ms()); }
                c.stats.flush();
            }
        });
        let w = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            if let Some(c) = w.upgrade() { c.recover_orphans().await; }
            tokio::time::sleep(Duration::from_millis(300)).await;
            let Some(c) = w.upgrade() else { return };
            for cfg in c.store.list() {
                if cfg["automation"]["startOnLaunch"] == true {
                    let id = s(&cfg["id"]).to_string();
                    if let Err(e) = c.start_server(&id, true).await { if let Ok(i) = c.instance(&id) { i.info(&format!("Couldn't start automatically: {e}")); } }
                }
            }
        });
    }

    // ---------- instances ----------
    pub fn cfg_of(&self, id: &str) -> Result<Value> { self.store.get(id).ok_or_else(|| anyhow::anyhow!("Unknown server")) }

    pub fn instance(&self, id: &str) -> Result<Arc<Instance>> {
        if let Some(i) = self.instances.lock().unwrap().get(id) { return Ok(i.clone()); }
        let cfg = self.store.get(id).ok_or_else(|| anyhow::anyhow!("That server no longer exists."))?;
        let w = self.me.clone();
        let sid = id.to_string();
        let inst = Instance::new(cfg, move |ev| { if let Some(c) = w.upgrade() { c.on_event(&sid, ev); } });
        Ok(self.instances.lock().unwrap().entry(id.to_string()).or_insert(inst).clone())
    }
    fn existing(&self, id: &str) -> Option<Arc<Instance>> { self.instances.lock().unwrap().get(id).cloned() }
    pub fn running_count(&self) -> usize { self.instances.lock().unwrap().values().filter(|i| i.is_running()).count() }

    fn server_view(&self, cfg: &Value) -> Value {
        let mut v = cfg.clone();
        let id = s(&cfg["id"]);
        v["snapshot"] = match self.existing(id) {
            Some(i) => i.snapshot(),
            None => json!({ "id": id, "state": "stopped", "players": [], "stats": { "cpu": 0, "memMB": 0 } }),
        };
        v
    }

    /// Server list for the tray / menu bar icon.
    pub fn tray_items(&self) -> Vec<Value> {
        self.store.list().iter().map(|cfg| {
            let id = s(&cfg["id"]);
            let (state, players) = self.existing(id).map(|i| (i.snapshot()["state"].as_str().unwrap_or("stopped").to_string(), i.player_count())).unwrap_or(("stopped".into(), 0));
            json!({ "id": id, "name": cfg["name"], "state": state, "players": players })
        }).collect()
    }

    fn on_event(&self, id: &str, ev: Event) {
        match ev {
            Event::Line(line) => {
                self.host.emit("server:line", json!({ "id": id, "line": line }));
                if line["source"] == "server" {
                    let t = s(&line["text"]);
                    if geyser::READY_RE.is_match(t) {
                        self.bedrock.lock().unwrap().entry(id.into()).or_insert_with(|| json!({}))["ready"] = json!(true);
                        self.push_bedrock(id);
                    } else if geyser::FAIL_RE.is_match(t) {
                        if let Some(i) = self.existing(id) { i.info("Geyser couldn’t open the Bedrock port. Another server may be using it: change the Bedrock port in Public Access."); }
                    }
                }
            }
            Event::State(snap) => {
                let state: &'static str = match s(&snap["state"]) { "starting" => "starting", "online" => "online", "stopping" => "stopping", "sleeping" => "sleeping", _ => "stopped" };
                let prev = self.prev_state.lock().unwrap().insert(id.to_string(), state);
                self.host.emit("server:state", snap);
                if prev != Some(state) {
                    if state == "starting" {
                        self.run_started.lock().unwrap().insert(id.into(), now_ms());
                        self.stats.on_start(id);
                        self.bedrock.lock().unwrap().insert(id.into(), json!({ "ready": false }));
                    }
                    if state == "online" {
                        self.empty_since.lock().unwrap().insert(id.into(), now_ms());
                        self.webhook(id, "start", "🟢 **{name}** is online.");
                        let c = self.arc();
                        let id = id.to_string();
                        tokio::spawn(async move { c.on_online(&id).await });
                    }
                    self.host.tray_changed();
                }
            }
            Event::Stats(st) => self.host.emit("server:stats", json!({ "id": id, "stats": st })),
            Event::Metrics(m) => self.host.emit("server:metrics", json!({ "id": id, "metrics": m })),
            Event::Player { join, name } => {
                let cfg = self.store.get(id);
                let server = cfg.as_ref().map(|c| s(&c["name"]).to_string()).unwrap_or_default();
                if join {
                    let uuid = self.existing(id).and_then(|i| i.player_uuid(&name));
                    self.stats.on_join(id, &name, uuid.as_deref());
                    self.empty_since.lock().unwrap().remove(id);
                    self.webhook(id, "join", &format!("➕ **{}** joined {{name}}.", name));
                } else {
                    self.stats.on_leave(id, &name);
                    if self.existing(id).is_some_and(|i| i.player_count() == 0) { self.empty_since.lock().unwrap().insert(id.into(), now_ms()); }
                    self.webhook(id, "leave", &format!("➖ **{}** left {{name}}.", name));
                }
                if self.store.settings()["notifyPlayers"] != false {
                    self.host.notify(&server, &format!("{name} {} the game", if join { "joined" } else { "left" }), false);
                }
                self.host.tray_changed();
            }
            Event::Exit { code, expected } => {
                let c = self.arc();
                let id = id.to_string();
                tokio::spawn(async move { c.on_exit(&id, code, expected).await });
            }
        }
    }

    async fn on_exit(&self, id: &str, code: Option<i32>, expected: bool) {
        let Some(cfg) = self.store.get(id) else { return };
        let crashed = !expected && code != Some(0);
        let sleeping = self.going_to_sleep.lock().unwrap().remove(id);
        let started = self.run_started.lock().unwrap().remove(id);
        self.stats.on_stop(id, started, crashed);
        let _ = self.store.update(id, json!({ "lastPid": null }));
        if sleeping {
            self.webhook(id, "stop", "💤 **{name}** is asleep until someone joins.");
        } else {
            self.webhook(id, if crashed { "crash" } else { "stop" }, &if crashed { format!("🔴 **{{name}}** crashed (exit {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())) } else { "⚪️ **{name}** stopped.".into() });
        }
        // Bedrock UDP port.
        let b = self.bedrock.lock().unwrap().insert(id.into(), json!({ "ready": false }));
        if let Some(p) = b.and_then(|b| b["upnp"]["port"].as_u64()) { if !sleeping { self.mapper.unmap(p as u16, true).await; } }
        self.push_bedrock(id);
        if sleeping {
            if let Err(e) = self.enter_sleep(id).await {
                if let Some(i) = self.existing(id) { i.info(&format!("Couldn't start sleep mode: {e}")); }
                if self.access_of(&cfg)["method"] == "upnp" { let _ = self.close_upnp(id).await; }
            }
            return;
        }
        if self.access_of(&cfg)["method"] == "upnp" { let _ = self.close_upnp(id).await; }
        self.maybe_stop_playit();
        if !crashed { return; }
        if self.store.settings()["notifyCrashes"] != false {
            self.host.notify(&format!("{} crashed", s(&cfg["name"])), &format!("The server stopped unexpectedly (exit {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())), true);
        }
        if cfg["automation"]["restartOnCrash"] == false || self.restarting.lock().unwrap().contains(id) { return; }
        let recent = {
            let mut l = self.crash_log.lock().unwrap();
            let v = l.entry(id.into()).or_default();
            v.retain(|t| now_ms() - t < 10 * 60_000);
            v.push(now_ms());
            v.len()
        };
        let inst = self.existing(id);
        if recent > 3 {
            if let Some(i) = inst { i.info("It crashed 4 times in 10 minutes, so automatic restarts are paused. Check the errors above."); }
            return;
        }
        if let Some(i) = &inst { i.info("Restarting automatically in 5 seconds… (turn this off in Automation)"); }
        let c = self.arc();
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if let Err(e) = c.start_server(&id, true).await { if let Some(i) = c.existing(&id) { i.info(&format!("Automatic restart failed: {e}")); } }
        });
    }

    // ---------- starting ----------
    async fn resolve_java(&self, cfg: &Value, inst: &Arc<Instance>, auto: bool) -> Result<Option<String>> {
        if let Some(p) = cfg["javaPath"].as_str().filter(|p| !p.is_empty() && Path::new(p).is_file()) { return Ok(Some(p.to_string())); }
        let mut major = cfg["javaMajor"].as_u64().map(|n| n as u32).unwrap_or(0);
        if major == 0 { if let Some(mc) = cfg["mcVersion"].as_str().filter(|s| !s.is_empty()) { major = providers::java_major_for(mc).await; } }
        if major == 0 {
            if let Some(j) = java::list(false).await.first() { return Ok(Some(j.path.clone())); }
            major = 25;
        }
        if let Some(j) = java::find(major).await { return Ok(Some(j.path)); }
        if auto { crate::bail!("Java {major} isn't installed."); }
        let r = self.host.ask(Ask::new("question", format!("Java {major} is needed"),
            format!("{} needs Java {major}, which isn't installed on this computer. Blockyard can download it for you (Eclipse Temurin, about 50 MB). It's kept inside Blockyard and won't change anything else on your computer.", s(&cfg["name"])),
            &["Download Java", "Cancel"])).await;
        if r != 0 { return Ok(None); }
        let i = inst.clone();
        let last = Arc::new(Mutex::new(-1i64));
        let log: Log = Arc::new(move |m: String, pct: Option<f64>| {
            match pct {
                None => if !m.contains(" MB") { i.info(&m) },
                Some(p) => { let step = (p * 10.0) as i64; let mut l = last.lock().unwrap(); if *l != step { *l = step; i.info(&m); } }
            }
        });
        Ok(Some(java::install(major, log).await?))
    }

    pub async fn start_server(&self, id: &str, auto: bool) -> Result<Value> {
        let inst = self.instance(id)?;
        let cfg = self.cfg_of(id)?;
        inst.set_cfg(cfg.clone());
        if inst.is_running() { return Ok(json!({ "ok": true })); }
        let dir = dir_of(&cfg);
        let eula = std::fs::read_to_string(dir.join("eula.txt")).unwrap_or_default();
        if !eula.lines().any(|l| l.trim().to_lowercase().replace(' ', "") == "eula=true") {
            if auto { crate::bail!("The Minecraft EULA hasn’t been accepted for this server."); }
            let r = self.host.ask(Ask::new("question", "Accept the Minecraft EULA?",
                "Mojang requires everyone who runs a server to agree to the Minecraft End User License Agreement (aka.ms/MinecraftEULA).",
                &["I Agree", "Read the EULA", "Cancel"])).await;
            if r == 1 { self.host.open_url("https://aka.ms/MinecraftEULA"); }
            if r != 0 { return Ok(json!({ "cancelled": true })); }
            std::fs::write(dir.join("eula.txt"), format!("# Accepted in Blockyard on {}\neula=true\n", chrono::Utc::now().to_rfc3339()))?;
        }
        let Some(java) = self.resolve_java(&cfg, &inst, auto).await? else { return Ok(json!({ "cancelled": true })) };
        // Sleeping? Free the port first.
        if let Some(l) = self.sleepers.lock().await.remove(id) { l.close().await; }
        inst.set_sleeping(false);
        if cfg["crossplay"]["enabled"] == true {
            let _ = geyser::apply_config(&cfg, cfg["crossplay"]["port"].as_u64().map(|p| p as u16).unwrap_or(geyser::DEFAULT_PORT));
        }
        let keep_awake = self.store.settings()["keepAwake"] != false;
        inst.start(&java, keep_awake).await?;
        if let Some(pid) = inst.pid() { let _ = self.store.update(id, json!({ "lastPid": pid })); }
        let a = self.access_of(&cfg);
        if a["method"] == "playit" && a["auto"] != false {
            let c = self.arc();
            let id2 = id.to_string();
            tokio::spawn(async move { if let Err(e) = c.ensure_playit(&id2).await { if let Some(i) = c.existing(&id2) { i.info(&format!("playit: {e}")); } } });
        }
        Ok(json!({ "ok": true }))
    }

    pub async fn stop_server(&self, id: &str) -> Result<()> {
        if let Some(l) = self.sleepers.lock().await.remove(id) {
            l.close().await;
            if let Some(i) = self.existing(id) { i.set_sleeping(false); i.info("Sleep mode turned off."); }
            let cfg = self.cfg_of(id)?;
            if self.access_of(&cfg)["method"] == "upnp" { let _ = self.close_upnp(id).await; }
            if let Some(p) = self.bedrock_upnp_port(id) { self.mapper.unmap(p, true).await; }
            self.maybe_stop_playit();
            return Ok(());
        }
        self.going_to_sleep.lock().unwrap().remove(id);
        self.instance(id)?.stop();
        Ok(())
    }

    fn suggest_port(&self) -> u16 {
        let used: HashSet<u16> = self.store.list().iter().map(|c| props::port(&dir_of(c))).collect();
        let mut p = 25565;
        while used.contains(&p) { p += 1; }
        p
    }

    // ---------- sleep mode (auto-stop when empty, wake when someone joins) ----------
    fn sleep_minutes(cfg: &Value) -> f64 { cfg["automation"]["sleepWhenEmpty"].as_f64().unwrap_or(0.0).max(0.0) }

    fn sleep_tick(&self, now: i64) {
        for cfg in self.store.list() {
            let id = s(&cfg["id"]).to_string();
            let mins = Self::sleep_minutes(&cfg);
            let Some(inst) = self.existing(&id) else { continue };
            if mins <= 0.0 || inst.state() != "online" || inst.player_count() > 0 { continue; }
            let since = *self.empty_since.lock().unwrap().entry(id.clone()).or_insert(now);
            if ((now - since) as f64) < mins * 60_000.0 { continue; }
            if self.backup_busy.lock().unwrap().contains(&id) { continue; }
            self.empty_since.lock().unwrap().remove(&id);
            self.going_to_sleep.lock().unwrap().insert(id.clone());
            inst.info(&format!("Nobody has been online for {} minutes, so the server is going to sleep to save memory and power. It wakes up when someone joins.", (mins * 10.0).round() / 10.0));
            inst.stop();
        }
    }

    /// Who may wake a sleeping server: whitelisted players (or ops) when the whitelist is on, anyone not banned otherwise.
    fn wake_decider(dir: PathBuf) -> crate::wake::Decide {
        Arc::new(move |name: &str| {
            let has = |f: &str| files::read_json_list(&dir, f).iter().any(|o| o["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)));
            if has("banned-players.json") { return Err("You are banned from this server.".into()); }
            let wl = props::get(&dir, "white-list").is_some_and(|v| v.trim() == "true");
            if wl && !has("whitelist.json") && !has("ops.json") { return Err("You're not on this server's whitelist.".into()); }
            if !crate::worlds::valid_username(name.trim_start_matches('.')) { return Err("That isn't a valid username.".into()); }
            Ok(())
        })
    }

    async fn enter_sleep(&self, id: &str) -> Result<()> {
        let cfg = self.cfg_of(id)?;
        let dir = dir_of(&cfg);
        let port = props::port(&dir);
        let w = self.me.clone();
        let sid = id.to_string();
        let listener = WakeListener::start(WakeOpts {
            port,
            motd: format!("💤 {} is asleep. Join to wake it up!", s(&cfg["name"])),
            decide: Self::wake_decider(dir),
            on_wake: Arc::new(move |player| {
                let (w, sid) = (w.clone(), sid.clone());
                tokio::spawn(async move { if let Some(c) = w.upgrade() { c.wake(&sid, &player).await; } });
            }),
        }).await?;
        self.sleepers.lock().await.insert(id.to_string(), listener);
        let inst = self.instance(id)?;
        inst.set_sleeping(true);
        inst.info("Sleeping. The server starts by itself when someone on the whitelist tries to join.");
        self.push_access(id);
        Ok(())
    }

    async fn wake(&self, id: &str, player: &str) {
        let Ok(cfg) = self.cfg_of(id) else { return };
        if let Some(i) = self.existing(id) { i.info(&format!("{player} is trying to join, so the server is waking up.")); }
        self.host.notify(s(&cfg["name"]), &format!("Waking up because {player} wants to play."), false);
        self.webhook(id, "start", &format!("⏰ **{{name}}** is waking up for {}.", player.replace(['*', '_', '`', '~', '|'], "")));
        if let Err(e) = self.start_server(id, true).await {
            if let Some(i) = self.existing(id) { i.info(&format!("Couldn't wake the server: {e}")); }
        }
    }

    pub fn is_sleeping(&self, id: &str) -> bool { self.existing(id).is_some_and(|i| i.is_sleeping()) }

    // ---------- public access ----------
    fn access_of(&self, cfg: &Value) -> Value {
        let mut a = obj(&json!({ "method": "off", "auto": true }));
        a.extend(obj(&cfg["access"]));
        Value::Object(a)
    }
    fn with_port(host: &str, port: u16) -> String { if port == 25565 { host.into() } else { format!("{host}:{port}") } }

    /// Whitelist / online-mode status, used for the safety warnings.
    pub fn safety(&self, cfg: &Value) -> Value {
        let dir = dir_of(cfg);
        let (exists, p) = props::read(&dir);
        let truthy = |k: &str, def: bool| p.get(k).map(|v| v.trim() == "true").unwrap_or(def);
        let lists = files::player_lists(&dir);
        let method = self.access_of(cfg)["method"].as_str().unwrap_or("off").to_string();
        let whitelist = truthy("white-list", false);
        let online_mode = truthy("online-mode", true);
        let mut warnings: Vec<&str> = vec![];
        if is_public(&method) {
            if !online_mode { warnings.push("online-mode is off: anyone can join pretending to be any player, including you or your admins. Turn it back on in Properties unless you really know why it's off."); }
            if !whitelist { warnings.push("The whitelist is off: anyone who finds your address can join. Bots scan the internet for open servers all the time, and strangers often show up within hours."); }
        }
        json!({ "public": is_public(&method), "whitelist": whitelist, "enforceWhitelist": truthy("enforce-whitelist", false), "onlineMode": online_mode,
            "propertiesExist": exists, "whitelistCount": lists["whitelist"].as_array().map(|a| a.len()).unwrap_or(0),
            "opsCount": lists["ops"].as_array().map(|a| a.len()).unwrap_or(0), "warnings": warnings })
    }

    pub fn access_view(&self, id: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let mut a = self.access_of(&cfg);
        let port = props::port(&dir_of(&cfg));
        let up = self.upnp.lock().unwrap().get(id).cloned().unwrap_or_else(|| json!({ "status": "idle" }));
        let pl = self.playit.snapshot();
        let tunnel = self.playit.tunnel_for_port(port);
        let diag = self.last_diag.lock().unwrap().clone();
        let ts = crate::portmap::tailscale_address();
        let method = s(&a["method"]).to_string();
        let mut public_address = Value::Null;
        if method == "upnp" && up["status"] == "open" { if let Some(ip) = up["info"]["externalIP"].as_str() { public_address = json!(Self::with_port(ip, up["info"]["externalPort"].as_u64().map(|p| p as u16).unwrap_or(port))); } }
        if method == "playit" { if let Some(addr) = tunnel.as_ref().and_then(|t| t["address"].as_str()) { public_address = json!(addr); } }
        if method == "manual" { if let Some(ip) = diag.as_ref().and_then(|d| d["publicIP"].as_str()) { public_address = json!(Self::with_port(ip, port)); } }
        if method == "vpn" { if let Some(t) = &ts { public_address = json!(Self::with_port(t, port)); } }
        let v6 = crate::portmap::public_ipv6_addresses().into_iter().next();
        if method == "ipv6" { if let Some(ip) = &v6 { public_address = json!(crate::portmap::ipv6_address(ip, port)); } }
        let o = a.as_object_mut().unwrap();
        o.insert("port".into(), json!(port)); o.insert("upnp".into(), up); o.insert("playit".into(), pl); o.insert("tunnel".into(), tunnel.unwrap_or(Value::Null));
        o.insert("publicAddress".into(), public_address); o.insert("tailscale".into(), json!(ts)); o.insert("ipv6".into(), json!(v6)); o.insert("diag".into(), diag.unwrap_or(Value::Null));
        o.insert("safety".into(), self.safety(&cfg)); o.insert("sleeping".into(), json!(self.is_sleeping(id))); o.insert("os".into(), json!(std::env::consts::OS));
        Ok(a)
    }

    pub fn push_access(&self, id: &str) { if let Ok(v) = self.access_view(id) { self.host.emit("access:state", json!({ "id": id, "view": v })); } }

    async fn open_upnp(&self, id: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let port = props::port(&dir_of(&cfg));
        self.upnp.lock().unwrap().insert(id.into(), json!({ "status": "opening" }));
        self.push_access(id);
        let desc: String = format!("Blockyard {}", s(&cfg["name"])).chars().take(40).collect();
        match self.mapper.map(port, &desc, false).await {
            Ok(info) => {
                if let Some(i) = self.existing(id) {
                    let ext = info["externalIP"].as_str().map(|ip| format!(". Public address: {}", Self::with_port(ip, info["externalPort"].as_u64().unwrap_or(port as u64) as u16))).unwrap_or_default();
                    i.info(&format!("Port {port} opened on your router via {}{ext}", s(&info["via"])));
                }
                self.upnp.lock().unwrap().insert(id.into(), json!({ "status": "open", "info": info }));
            }
            Err(e) => {
                if let Some(i) = self.existing(id) { i.info(&format!("Automatic port forwarding failed: {e}")); }
                self.upnp.lock().unwrap().insert(id.into(), json!({ "status": "error", "error": e.to_string() }));
            }
        }
        self.push_access(id);
        self.access_view(id)
    }

    async fn close_upnp(&self, id: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let st = self.upnp.lock().unwrap().get(id).cloned();
        let port = st.as_ref().and_then(|s| s["info"]["port"].as_u64()).map(|p| p as u16).unwrap_or_else(|| props::port(&dir_of(&cfg)));
        self.mapper.unmap(port, false).await;
        self.upnp.lock().unwrap().insert(id.into(), json!({ "status": "idle" }));
        self.push_access(id);
        self.access_view(id)
    }

    async fn ensure_playit(&self, id: &str) -> Result<()> {
        if !self.playit.installed() { crate::bail!("playit isn’t installed yet. Open Public Access to set it up."); }
        self.playit.start().await?;
        let cfg = self.cfg_of(id)?;
        if self.playit.snapshot()["agentId"].is_string() && self.playit.tunnel_for_port(props::port(&dir_of(&cfg))).is_none() {
            if let Some(i) = self.existing(id) { i.info("playit: no tunnel for this server yet. Create one in Public Access."); }
        }
        Ok(())
    }

    fn maybe_stop_playit(&self) {
        let c = self.arc();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let sleepers: HashSet<String> = c.sleepers.lock().await.keys().cloned().collect();
            let needed = c.store.list().iter().any(|cfg| {
                let id = s(&cfg["id"]);
                c.access_of(cfg)["method"] == "playit" && (c.existing(id).is_some_and(|i| i.is_running()) || sleepers.contains(id))
            });
            let claiming = c.playit.snapshot()["claim"]["status"].as_str().is_some_and(|s| s.starts_with("waiting"));
            if !needed && !claiming { c.playit.stop(); }
        });
    }

    async fn on_online(&self, id: &str) {
        let Some(cfg) = self.store.get(id) else { return };
        let a = self.access_of(&cfg);
        if a["method"] == "upnp" && a["auto"] != false && self.upnp.lock().unwrap().get(id).map(|u| u["status"] != "open").unwrap_or(true) {
            let _ = self.open_upnp(id).await;
        }
        self.bedrock_online(id).await;
        self.push_access(id);
    }

    /// Turn the whitelist on (when going public), keeping current players and this computer's
    /// Minecraft accounts on it so nobody who should be there gets locked out.
    async fn secure_for_public(&self, id: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let dir = dir_of(&cfg);
        let mut added: Vec<String> = vec![];
        let accounts = worlds::launcher_accounts(&crate::paths::minecraft_dir());
        let inst = self.existing(id).filter(|i| i.is_running() && i.state() == "online");
        if let Some(i) = &inst {
            for name in i.player_names().into_iter().chain(accounts.iter().filter_map(|a| a["name"].as_str().map(String::from))) {
                let _ = i.send(&format!("whitelist add {name}"));
                added.push(name);
            }
            let _ = i.send("whitelist on");
        } else {
            for a in &accounts { if files::whitelist_add(&dir, s(&a["uuid"]), s(&a["name"]))? { added.push(s(&a["name"]).into()); } }
            props::set(&dir, &[("white-list", "true"), ("enforce-whitelist", "true")])?;
        }
        // The server saves this itself too; writing it now keeps the safety status accurate right away.
        if inst.is_some() { props::set(&dir, &[("white-list", "true"), ("enforce-whitelist", "true")])?; }
        added.dedup();
        Ok(json!({ "whitelistOn": true, "added": added }))
    }

    /// Invite a friend: look up their account, put them on the whitelist and build a message to send.
    async fn invite(&self, id: &str, name: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let dir = dir_of(&cfg);
        let bedrock = name.starts_with('.');
        let (uuid, real) = if bedrock {
            (String::new(), name.to_string())
        } else {
            let p = worlds::lookup_player(name).await?;
            (s(&p["uuid"]).to_string(), s(&p["name"]).to_string())
        };
        let inst = self.existing(id).filter(|i| i.is_running());
        if let Some(i) = &inst {
            i.send(&format!("{} {real}", if bedrock { "fwhitelist add" } else { "whitelist add" }))?;
        } else if !bedrock {
            files::whitelist_add(&dir, &uuid, &real)?;
        } else {
            crate::bail!("Start the server to invite Bedrock players (Floodgate adds them while it runs).");
        }
        let view = self.access_view(id)?;
        let address = view["publicAddress"].as_str().map(String::from);
        let mc = s(&cfg["mcVersion"]);
        let mut text = format!("Hey {real}! Join my Minecraft server");
        if !mc.is_empty() { text += &format!(" (Java Edition {mc})"); }
        match &address { Some(a) => text += &format!(": {a}"), None => text += ". I'll send you the address when it's online." }
        let bport = cfg["crossplay"]["port"].as_u64();
        if bedrock && cfg["crossplay"]["enabled"] == true {
            if let Some(a) = &address { text += &format!("\nOn Bedrock (phone, tablet, console): add server {} port {}", a.split(':').next().unwrap_or(a), bport.unwrap_or(19132)); }
        }
        Ok(json!({ "name": real, "uuid": uuid, "address": address, "text": text, "whitelistOn": self.safety(&cfg)["whitelist"] }))
    }

    // ---------- Bedrock crossplay ----------
    fn next_bedrock_port(&self, except: &str) -> u16 {
        let used: HashSet<u16> = self.store.list().iter().filter(|c| s(&c["id"]) != except && c["crossplay"]["enabled"] == true)
            .map(|c| c["crossplay"]["port"].as_u64().map(|p| p as u16).unwrap_or(geyser::DEFAULT_PORT)).collect();
        let mut p = geyser::DEFAULT_PORT;
        while used.contains(&p) { p += 1; }
        p
    }

    fn bedrock_upnp_port(&self, id: &str) -> Option<u16> { self.bedrock.lock().unwrap().get(id).and_then(|b| b["upnp"]["port"].as_u64()).map(|p| p as u16) }

    fn bedrock_view(&self, id: &str) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let det = geyser::detect(&cfg);
        let b = self.bedrock.lock().unwrap().get(id).cloned().unwrap_or_else(|| json!({}));
        let port = cfg["crossplay"]["port"].as_u64().map(|p| p as u16).or_else(|| geyser::read_port(&cfg)).unwrap_or(geyser::DEFAULT_PORT);
        let tunnel = self.playit.tunnel_for_port(port);
        let method = self.access_of(&cfg)["method"].as_str().unwrap_or("off").to_string();
        let public = if method == "playit" { tunnel.as_ref().and_then(|t| t["address"].as_str()).map(String::from) }
            else { b["upnp"]["externalIP"].as_str().map(|ip| format!("{ip}:{port}")) };
        Ok(json!({
            "supported": geyser::supported(s(&cfg["software"])), "enabled": cfg["crossplay"]["enabled"] == true && det["geyser"].is_string(),
            "installed": det, "port": port, "configExists": geyser::config_path(&cfg).exists(), "ready": b["ready"] == true,
            "upnp": b["upnp"], "upnpError": b["error"], "publicAddress": public, "tunnel": tunnel,
        }))
    }
    fn push_bedrock(&self, id: &str) { if let Ok(v) = self.bedrock_view(id) { self.host.emit("bedrock:state", json!({ "id": id, "view": v })); } }

    /// Server came online: open the Bedrock UDP port too, or make sure a playit tunnel exists.
    async fn bedrock_online(&self, id: &str) {
        let Some(cfg) = self.store.get(id) else { return };
        if cfg["crossplay"]["enabled"] != true || !geyser::detect(&cfg)["geyser"].is_string() { return; }
        let inst = self.existing(id);
        let port = cfg["crossplay"]["port"].as_u64().map(|p| p as u16).unwrap_or(geyser::DEFAULT_PORT);
        if let Ok((_, true)) = geyser::apply_config(&cfg, port) { if let Some(i) = &inst { i.info("Bedrock settings updated. They take effect after the next restart."); } }
        let method = self.access_of(&cfg)["method"].as_str().unwrap_or("off").to_string();
        if method == "upnp" {
            let desc: String = format!("Blockyard {} Bedrock", s(&cfg["name"])).chars().take(40).collect();
            match self.mapper.map(port, &desc, true).await {
                Ok(info) => {
                    self.bedrock.lock().unwrap().entry(id.into()).or_insert_with(|| json!({}))["upnp"] = info;
                    if let Some(i) = &inst { i.info(&format!("Bedrock port {port} (UDP) opened on your router.")); }
                }
                Err(e) => {
                    let mut b = self.bedrock.lock().unwrap();
                    let e2 = b.entry(id.into()).or_insert_with(|| json!({}));
                    e2["upnp"] = Value::Null; e2["error"] = json!(e.to_string());
                    if let Some(i) = &inst { i.info(&format!("Couldn’t open the Bedrock port automatically: {e}")); }
                }
            }
        } else if method == "playit" && self.playit.snapshot()["agentId"].is_string() && self.playit.tunnel_for_port(port).is_none() {
            match self.playit.create_tunnel(s(&cfg["name"]), port, true).await {
                Ok(_) => if let Some(i) = &inst { i.info("playit: Bedrock tunnel created."); },
                Err(e) => if let Some(i) = &inst { i.info(&format!("playit: couldn’t create the Bedrock tunnel ({e}).")); },
            }
        }
        self.push_bedrock(id);
    }

    // ---------- backups ----------
    pub async fn run_backup(&self, id: &str, reason: &str, scope: Option<&str>) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        if !self.backup_busy.lock().unwrap().insert(id.into()) { crate::bail!("A backup is already running."); }
        self.host.emit("backups:busy", json!({ "id": id, "busy": true }));
        let inst = self.existing(id);
        let scope = scope.map(String::from).unwrap_or_else(|| cfg["backup"]["scope"].as_str().unwrap_or("world").to_string());
        let r = backups::create(&dir_of(&cfg), &scope, reason, inst.as_ref()).await;
        self.backup_busy.lock().unwrap().remove(id);
        self.host.emit("backups:busy", json!({ "id": id, "busy": false }));
        match r {
            Ok(b) => {
                if reason == "auto" {
                    let _ = self.store.update(id, json!({ "lastAutoBackup": now_ms() }));
                    backups::prune(&dir_of(&cfg), cfg["backup"]["keep"].as_u64().unwrap_or(10) as usize);
                }
                if let Some(i) = &inst { i.info(&format!("Backup saved: {} ({:.1} MB)", s(&b["file"]), b["size"].as_f64().unwrap_or(0.0) / 1048576.0)); }
                Ok(b)
            }
            Err(e) => {
                if let Some(i) = &inst { i.info(&format!("Backup failed: {e}")); }
                if reason == "auto" { self.host.notify(&format!("{}: backup failed", s(&cfg["name"])), &e.to_string(), true); }
                Err(e)
            }
        }
    }

    // ---------- timers ----------
    fn sample_metrics(&self) {
        let list: Vec<(String, Arc<Instance>)> = self.instances.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (id, inst) in list {
            if inst.state() != "online" { continue; }
            let (tps, mspt, at) = inst.metrics();
            let fresh = at.is_some_and(|t| now_ms() - t < 45_000);
            let (cpu, mem) = inst.stats();
            self.stats.add_point(&id, if fresh { tps } else { None }, if fresh { mspt } else { None }, cpu, mem, inst.player_count());
            let cfg = inst.cfg();
            let sw = s(&cfg["software"]);
            if sw == "paper" || sw == "purpur" {
                inst.probe("tps", crate::instance::probe_answers("paper"), 2500);
                inst.probe("mspt", crate::instance::probe_answers("paper"), 2500);
            } else if cfg["mcVersion"].as_str().filter(|v| !v.is_empty()).map(|v| versions::compare(v, "1.20.3").is_ge()).unwrap_or(true) {
                inst.probe("tick query", crate::instance::probe_answers("vanilla"), 2500);
            }
        }
    }

    fn tps_support(cfg: &Value) -> &'static str {
        let sw = s(&cfg["software"]);
        if sw == "paper" || sw == "purpur" { return "full"; }
        if cfg["mcVersion"].as_str().filter(|v| !v.is_empty()).map(|v| versions::compare(v, "1.20.3").is_ge()).unwrap_or(true) { "mspt" } else { "none" }
    }

    fn run_schedules(&self, now: i64) {
        for cfg in self.store.list() {
            let id = s(&cfg["id"]);
            let Some(inst) = self.existing(id).filter(|i| i.state() == "online") else { continue };
            for sch in cfg["schedules"].as_array().cloned().unwrap_or_default() {
                let every = sch["every"].as_f64().unwrap_or(0.0);
                if sch["enabled"] != true || s(&sch["command"]).is_empty() || every <= 0.0 { continue; }
                let key = format!("{id}:{}", sch["id"]);
                let last = self.sched_last.lock().unwrap().get(&key).copied().unwrap_or(0).max(inst.started_at().unwrap_or(0));
                if (now - last) as f64 >= every * 60_000.0 {
                    self.sched_last.lock().unwrap().insert(key, now);
                    let _ = inst.send(s(&sch["command"]));
                }
            }
        }
    }

    fn scheduler_tick(&self) {
        let now = chrono::Local::now();
        for cfg in self.store.list() {
            let id = s(&cfg["id"]).to_string();
            let Some(inst) = self.existing(&id).filter(|i| i.state() == "online") else { continue };
            let hrs = cfg["backup"]["intervalHours"].as_f64().unwrap_or(0.0);
            if hrs > 0.0 && !self.backup_busy.lock().unwrap().contains(&id) {
                let last = cfg["lastAutoBackup"].as_i64().unwrap_or(0).max(inst.started_at().unwrap_or(0));
                if (now_ms() - last) as f64 >= hrs * 3_600_000.0 {
                    let c = self.arc();
                    let id2 = id.clone();
                    tokio::spawn(async move { let _ = c.run_backup(&id2, "auto", None).await; });
                }
            }
            let Some(t) = cfg["automation"]["dailyRestart"].as_str() else { continue };
            let Some((h, m)) = t.split_once(':').and_then(|(h, m)| Some((h.parse::<u32>().ok()?, m.parse::<u32>().ok()?))) else { continue };
            let day = now.format("%Y-%m-%d").to_string();
            if s(&cfg["lastDailyRestart"]) == day { continue; }
            let Some(target) = now.date_naive().and_hms_opt(h, m, 0) else { continue };
            let mins = (target - now.naive_local()).num_seconds() as f64 / 60.0;
            let (w5, w1) = {
                let mut w = self.warned.lock().unwrap();
                let e = w.entry(id.clone()).or_insert((day.clone(), false, false));
                if e.0 != day { *e = (day.clone(), false, false); }
                (e.1, e.2)
            };
            if mins <= 5.0 && mins > 4.0 && !w5 { self.warned.lock().unwrap().get_mut(&id).unwrap().1 = true; let _ = inst.send("say Server restarting in 5 minutes."); }
            if mins <= 1.0 && mins > 0.0 && !w1 { self.warned.lock().unwrap().get_mut(&id).unwrap().2 = true; let _ = inst.send("say Server restarting in 1 minute!"); }
            if mins <= 0.0 && mins > -5.0 {
                let _ = self.store.update(&id, json!({ "lastDailyRestart": day }));
                let _ = inst.send("say Restarting now. Back in a minute!");
                inst.info(&format!("Scheduled daily restart ({t})."));
                let c = self.arc();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    c.restarting.lock().unwrap().insert(id.clone());
                    let _ = c.restart(&id).await;
                    c.restarting.lock().unwrap().remove(&id);
                });
            }
        }
    }

    /// Run every timer once, right now (tests, and after waking from system sleep).
    pub fn run_timers_now(&self) {
        self.sample_metrics();
        self.run_schedules(now_ms());
        self.scheduler_tick();
        self.sleep_tick(now_ms());
    }

    pub async fn restart(&self, id: &str) -> Result<Value> {
        let inst = self.instance(id)?;
        if inst.is_running() { inst.stop(); inst.wait_for_exit().await; }
        self.start_server(id, true).await
    }

    // ---------- Discord webhooks ----------
    fn webhook_ok(url: &str) -> bool {
        regex::Regex::new(r"^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+$").unwrap().is_match(url)
    }
    async fn post_webhook(url: &str, content: &str) -> Result<()> {
        let r = crate::net::client().post(crate::net::route(url))
            .json(&json!({ "content": content, "username": "Blockyard", "allowed_mentions": { "parse": [] } })).send().await?;
        if !r.status().is_success() { crate::bail!("Discord answered HTTP {}. Check the webhook URL.", r.status().as_u16()); }
        Ok(())
    }
    fn webhook(&self, id: &str, event: &str, template: &str) {
        let Some(cfg) = self.store.get(id) else { return };
        let w = &cfg["webhook"];
        let Some(url) = w["url"].as_str().filter(|u| Self::webhook_ok(u)).map(String::from) else { return };
        if w["events"][event] == false { return; }
        if (event == "join" || event == "leave") && w["events"][event] != true { return; } // player events are opt-in
        let text = template.replace("{name}", &s(&cfg["name"]).replace(['*', '_', '`', '~', '|'], ""));
        tokio::spawn(async move { let _ = Self::post_webhook(&url, &text).await; });
    }

    // ---------- servers left running after Blockyard quit unexpectedly ----------
    async fn recover_orphans(&self) {
        for cfg in self.store.list() {
            let id = s(&cfg["id"]).to_string();
            let Some(pid) = cfg["lastPid"].as_u64().map(|p| p as u32) else { continue };
            let cmd = crate::proc::command_line(pid);
            let ours = cmd.as_ref().is_some_and(|c| c.to_lowercase().contains("java") && cfg["launchArgs"].as_array().is_some_and(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| !x.starts_with('-') && x.len() > 3).any(|x| c.contains(x))));
            if !ours { let _ = self.store.update(&id, json!({ "lastPid": null })); continue; }
            let r = self.host.ask(Ask::new("warning", format!("{} is still running in the background", s(&cfg["name"])),
                "Blockyard closed unexpectedly while this server was running, so Blockyard can’t show its console. Stop it safely now (the world is saved first), then start it again from Blockyard.",
                &["Stop Server Safely", "Leave It Running"])).await;
            if r != 0 { continue; }
            tokio::task::spawn_blocking(move || crate::proc::terminate(pid)).await.ok();
            for i in 0..60 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if !crate::proc::alive(pid) { break; }
                if i == 59 { crate::proc::kill(pid); }
            }
            let _ = self.store.update(&id, json!({ "lastPid": null }));
        }
    }

    /// Stop everything cleanly (app quit). Returns once servers have exited (or after `timeout`).
    pub async fn shutdown(&self, timeout: Duration) {
        let running: Vec<Arc<Instance>> = self.instances.lock().unwrap().values().filter(|i| i.is_running()).cloned().collect();
        for i in &running { i.stop(); }
        let _ = tokio::time::timeout(timeout, futures_util::future::join_all(running.iter().map(|i| i.wait_for_exit()))).await;
        let ids: Vec<String> = self.sleepers.lock().await.keys().cloned().collect();
        for id in ids { if let Some(l) = self.sleepers.lock().await.remove(&id) { l.close().await; } }
        self.stats.flush();
        self.playit.stop();
        let _ = tokio::time::timeout(Duration::from_millis(2500), self.mapper.unmap_all()).await;
    }

    fn task_log(&self, task_id: &Value) -> Log {
        let host = self.host.clone();
        let task = task_id.clone();
        Arc::new(move |m: String, pct: Option<f64>| {
            let (verbose, msg) = match m.strip_prefix('\u{1}') { Some(r) => (true, r.to_string()), None => (false, m) };
            host.emit("task:progress", json!({ "taskId": task, "message": msg, "pct": pct, "verbose": verbose }));
        })
    }

    fn icon_data(p: &Path, size: u32) -> Option<String> {
        use base64::Engine;
        let img = image::open(p).ok()?;
        let img = img.resize_to_fill(size, size, image::imageops::FilterType::Lanczos3);
        let mut buf = std::io::Cursor::new(vec![]);
        img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner())))
    }

    /// Save any image as a 64×64 server-icon.png (centre-cropped so it isn't squashed).
    pub fn set_icon_from(&self, id: &str, file: &Path) -> Result<Value> {
        let cfg = self.cfg_of(id)?;
        let img = image::open(file).map_err(|_| anyhow::anyhow!("That file couldn’t be read as an image."))?;
        let img = img.resize_to_fill(64, 64, image::imageops::FilterType::Lanczos3);
        let dest = dir_of(&cfg).join("server-icon.png");
        img.save_with_format(&dest, image::ImageFormat::Png)?;
        Ok(Self::icon_data(&dest, 64).map(Value::from).unwrap_or(Value::Null))
    }

    // ---------- modpacks ----------
    async fn create_modpack(&self, o: &Value, task: &Value) -> Result<Value> {
        let log = self.task_log(task);
        let tmp = self.data_dir.join("downloads").join(uuid::Uuid::new_v4().to_string());
        let file = match o["file"].as_str().filter(|f| !f.is_empty()) {
            Some(f) => PathBuf::from(f),
            None => mrpack::download_from_modrinth(s(&o["project"]), &tmp, &log).await?,
        };
        let r = async {
            let pack = mrpack::read(&file)?;
            log(format!("{} {} for Minecraft {} ({}{})", pack.name, pack.version, pack.mc_version, pack.software, pack.loader.as_ref().map(|l| format!(" {l}")).unwrap_or_default()), None);
            if pack.skipped_client_only > 0 { log(format!("Skipping {} client-only mods (shaders, minimaps and similar) that servers don't need.", pack.skipped_client_only), None); }
            let name = o["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(&pack.name).to_string();
            let mem = o["memoryMB"].as_u64().unwrap_or(6144);
            let mut cfg = installer::create(&installer::CreateOpts {
                name, software: pack.software.clone(), mc_version: pack.mc_version.clone(), parent_dir: PathBuf::from(s(&o["parentDir"])),
                port: o["port"].as_u64().unwrap_or(25565) as u16, memory_mb: mem, eula: o["eula"] == true, loader: pack.loader.clone(),
            }, log.clone()).await?;
            let dir = dir_of(&cfg);
            if let Err(e) = mrpack::install(&pack, &file, &dir, &log).await {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
            cfg["modpack"] = json!({ "name": pack.name, "version": pack.version, "project": o["project"], "files": pack.files.len() });
            log(format!("{} is ready. It has {} mods and files. Press Start to launch it.", pack.name, pack.files.len()), Some(1.0));
            Ok::<Value, anyhow::Error>(cfg)
        }.await;
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = r?;
        let _ = self.store.set_settings(json!({ "defaultParent": o["parentDir"] }));
        let added = self.store.add(cfg)?;
        self.host.tray_changed();
        Ok(self.server_view(&added))
    }

    // ---------- the UI channels ----------
    pub async fn call(&self, channel: &str, a: Vec<Value>) -> Result<Value> {
        let r = self.dispatch(channel, &a).await;
        if channel.starts_with("servers:") { self.host.tray_changed(); }
        if let Err(e) = &r { self.log("warn", &format!("{channel}: {e}")); }
        r
    }

    async fn dispatch(&self, channel: &str, a: &[Value]) -> Result<Value> {
        let id = arg_str(a, 0);
        macro_rules! scfg { () => { self.cfg_of(&id)? } }
        macro_rules! dir { () => { dir_of(&self.cfg_of(&id)?) } }
        match channel {
            "app:info" => Ok(json!({
                "platform": std::env::consts::OS, "arch": std::env::consts::ARCH, "version": self.version,
                "totalMemMB": crate::proc::total_memory_mb(), "home": crate::paths::home(),
                "defaultParent": self.store.settings()["defaultParent"].as_str().map(PathBuf::from).unwrap_or_else(crate::paths::default_servers_parent),
                "lan": crate::portmap::lan_addresses(), "suggestedPort": self.suggest_port(), "fileManager": if cfg!(target_os = "macos") { "Finder" } else if cfg!(windows) { "File Explorer" } else { "your file manager" },
            })),
            "settings:get" => Ok(self.store.settings()),
            "settings:set" => self.store.set_settings(arg(a, 0).clone()),
            "software:list" => Ok(providers::catalogue()),
            "software:versions" => Ok(json!(providers::versions(&id).await?)),
            "servers:list" => Ok(Value::Array(self.store.list().iter().map(|c| self.server_view(c)).collect())),
            "server:log" => Ok(json!(self.existing(&id).map(|i| i.log()).unwrap_or_default())),
            "servers:create" => {
                let o = arg(a, 0);
                let cfg = installer::create(&installer::CreateOpts {
                    name: s(&o["name"]).into(), software: s(&o["software"]).into(), mc_version: s(&o["mcVersion"]).into(), parent_dir: PathBuf::from(s(&o["parentDir"])),
                    port: o["port"].as_u64().unwrap_or(25565) as u16, memory_mb: o["memoryMB"].as_u64().unwrap_or(2048), eula: o["eula"] == true, loader: None,
                }, self.task_log(arg(a, 1))).await?;
                self.store.set_settings(json!({ "defaultParent": o["parentDir"] }))?;
                Ok(self.server_view(&self.store.add(cfg)?))
            }
            "servers:readModpack" => {
                let p = mrpack::read(Path::new(&id))?;
                Ok(json!({ "name": p.name, "version": p.version, "summary": p.summary, "mcVersion": p.mc_version, "software": p.software, "loader": p.loader, "files": p.files.len(), "skipped": p.skipped_client_only }))
            }
            "servers:createModpack" => self.create_modpack(arg(a, 0), arg(a, 1)).await,
            "modrinth:searchModpacks" => {
                let o = arg(a, 0);
                modrinth::search_raw(s(&o["query"]), &json!([["project_type:modpack"], ["categories:fabric", "categories:forge", "categories:neoforge"]]), o["sort"].as_str().unwrap_or("relevance"), o["offset"].as_u64().unwrap_or(0), 20).await
            }
            "servers:detect" => installer::detect(Path::new(&id)),
            "servers:import" => {
                let d = arg(a, 0);
                let dir = PathBuf::from(s(&d["dir"]));
                if self.store.list().iter().any(|c| crate::paths::absolute(&dir_of(c)) == crate::paths::absolute(&dir)) { crate::bail!("That folder is already in Blockyard."); }
                let sw = providers::get(d["software"].as_str().unwrap_or("vanilla"))?;
                let mc = s(&d["mcVersion"]).to_string();
                let cfg = self.store.add(json!({
                    "name": d["name"].as_str().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
                    "dir": dir, "software": sw.id, "kind": sw.kind, "mcVersion": mc, "javaMajor": if mc.is_empty() { Value::Null } else { json!(versions::guess_java_major(&mc)) },
                    "memoryMB": d["memoryMB"].as_u64().unwrap_or(2048), "launchArgs": if d["launchArgs"].is_array() { d["launchArgs"].clone() } else { json!(["-jar", "server.jar"]) },
                    "jvmArgs": "", "javaPath": "", "imported": true,
                }))?;
                if !mc.is_empty() {
                    let c = self.arc();
                    let cid = s(&cfg["id"]).to_string();
                    tokio::spawn(async move { let m = providers::java_major_for(&mc).await; let _ = c.store.update(&cid, json!({ "javaMajor": m })); });
                }
                Ok(self.server_view(&cfg))
            }
            "servers:update" => {
                const ALLOWED: &[&str] = &["name", "memoryMB", "jvmArgs", "javaPath", "launchArgs", "mcVersion", "javaMajor", "software", "noGui", "backup", "automation", "optimizedFlags", "schedules", "webhook", "onboarded"];
                let mut clean: Map<String, Value> = obj(arg(a, 1)).into_iter().filter(|(k, _)| ALLOWED.contains(&k.as_str())).collect();
                if let Some(sw) = clean.get("software").and_then(|v| v.as_str()) { let k = providers::get(sw)?.kind; clean.insert("kind".into(), json!(k)); }
                if let Some(mc) = clean.get("mcVersion").and_then(|v| v.as_str()).map(String::from) { if !clean.contains_key("javaMajor") && !mc.is_empty() { clean.insert("javaMajor".into(), json!(versions::guess_java_major(&mc))); } }
                let cfg = self.store.update(&id, Value::Object(clean))?;
                if let Some(i) = self.existing(&id) { i.set_cfg(cfg.clone()); }
                if Self::sleep_minutes(&cfg) <= 0.0 && self.is_sleeping(&id) { let _ = self.stop_server(&id).await; }
                Ok(self.server_view(&cfg))
            }
            "servers:remove" => {
                if self.existing(&id).is_some_and(|i| i.is_running()) { crate::bail!("Stop the server first."); }
                if let Some(l) = self.sleepers.lock().await.remove(&id) { l.close().await; }
                if let Some(cfg) = self.store.get(&id) {
                    if arg(a, 1)["trash"] == true && dir_of(&cfg).exists() { trash(&dir_of(&cfg))?; }
                }
                self.instances.lock().unwrap().remove(&id);
                self.stats.forget(&id);
                self.store.remove(&id)?;
                ok()
            }
            "server:start" => self.start_server(&id, false).await,
            "server:stop" => { self.stop_server(&id).await?; ok() }
            "server:kill" => { self.instance(&id)?.kill(); ok() }
            "server:restart" => {
                let inst = self.instance(&id)?;
                if inst.is_running() { inst.stop(); inst.wait_for_exit().await; }
                self.start_server(&id, false).await
            }
            "server:command" => { self.instance(&id)?.send(&arg_str(a, 1))?; ok() }
            "java:list" => Ok(json!(java::list(true).await)),
            "java:install" => Ok(json!(java::install(arg(a, 0).as_u64().unwrap_or(21) as u32, self.task_log(arg(a, 1))).await?)),

            "files:list" => files::list(&dir!(), &arg_str(a, 1)),
            "files:read" => Ok(json!(files::read_text(&dir!(), &arg_str(a, 1))?)),
            "files:write" => { files::write_text(&dir!(), &arg_str(a, 1), &arg_str(a, 2))?; ok() }
            "files:mkdir" => { files::mkdir(&dir!(), &arg_str(a, 1))?; ok() }
            "files:rename" => { files::rename(&dir!(), &arg_str(a, 1), &arg_str(a, 2))?; ok() }
            "files:trash" => { let p = files::safe(&dir!(), &arg_str(a, 1))?; if p == crate::paths::absolute(&dir!()) { crate::bail!("That's the whole server folder."); } trash(&p)?; ok() }
            "files:copyIn" => Ok(json!(files::copy_in(&dir!(), &arg_str(a, 1), &serde_json::from_value::<Vec<String>>(arg(a, 2).clone()).unwrap_or_default())?)),
            "files:path" => Ok(json!(files::safe(&dir!(), &arg_str(a, 1))?)),
            "addons:list" => { let c = scfg!(); files::list_addons(&dir_of(&c), &kind_of(&c)) }
            "addons:toggle" => { let c = scfg!(); files::toggle_addon(&dir_of(&c), &kind_of(&c), &arg_str(a, 1), arg(a, 2) == true)?; ok() }
            "addons:add" => { let c = scfg!(); Ok(json!(files::add_addons(&dir_of(&c), &kind_of(&c), &serde_json::from_value::<Vec<String>>(arg(a, 1).clone()).unwrap_or_default())?)) }
            "addons:trash" => { let c = scfg!(); trash(&files::safe(&dir_of(&c), &format!("{}/{}", files::addons_dir(&kind_of(&c)), arg_str(a, 1)))?)?; ok() }
            "addons:path" => { let c = scfg!(); let p = files::safe(&dir_of(&c), files::addons_dir(&kind_of(&c)))?; std::fs::create_dir_all(&p)?; Ok(json!(p)) }
            "props:get" => { let (exists, values) = props::read(&dir!()); Ok(json!({ "exists": exists, "values": values })) }
            "props:set" => {
                let updates: std::collections::BTreeMap<String, String> = obj(arg(a, 1)).into_iter().map(|(k, v)| (k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect();
                props::write(&dir!(), &updates)?;
                self.push_access(&id);
                ok()
            }
            "players:lists" => Ok(files::player_lists(&dir!())),
            "players:invite" => self.invite(&id, arg_str(a, 1).trim()).await,
            "port:check" => Ok(json!(crate::instance::port_free(arg(a, 0).as_u64().unwrap_or(25565) as u16).await)),

            "access:get" => self.access_view(&id),
            "access:set" => {
                let cfg = scfg!();
                let prev = self.access_of(&cfg);
                let mut next = obj(&prev);
                next.extend(obj(arg(a, 1)));
                let next = Value::Object(next);
                self.store.update(&id, json!({ "access": next }))?;
                let (pm, nm) = (s(&prev["method"]).to_string(), s(&next["method"]).to_string());
                if pm == "upnp" && nm != "upnp" { let _ = self.close_upnp(&id).await; }
                if pm == "playit" && nm != "playit" { self.maybe_stop_playit(); }
                // Going public: switch the whitelist on (once per server; people can turn it off again).
                let mut secured = Value::Null;
                if is_public(&nm) && !is_public(&pm) && cfg["safety"]["whitelistOffered"] != true {
                    secured = self.secure_for_public(&id).await.unwrap_or(Value::Null);
                    self.store.update(&id, json!({ "safety": { "whitelistOffered": true } }))?;
                }
                if self.existing(&id).is_some_and(|i| i.state() == "online") {
                    if nm == "upnp" && pm != "upnp" && next["auto"] != false { let _ = self.open_upnp(&id).await; }
                    if nm == "playit" && self.playit.installed() {
                        let c = self.arc();
                        let id2 = id.clone();
                        tokio::spawn(async move { let _ = c.ensure_playit(&id2).await; });
                    }
                }
                let mut v = self.access_view(&id)?;
                v["secured"] = secured;
                Ok(v)
            }
            "access:setWhitelist" => {
                let on = arg(a, 1) == true;
                let cfg = scfg!();
                match self.existing(&id).filter(|i| i.state() == "online") {
                    Some(i) => { i.send(if on { "whitelist on" } else { "whitelist off" })?; props::set(&dir_of(&cfg), &[("white-list", if on { "true" } else { "false" }), ("enforce-whitelist", if on { "true" } else { "false" })])?; }
                    None => props::set(&dir_of(&cfg), &[("white-list", if on { "true" } else { "false" }), ("enforce-whitelist", if on { "true" } else { "false" })])?,
                }
                if on { let _ = self.secure_for_public(&id).await; }
                tokio::time::sleep(Duration::from_millis(300)).await;
                self.access_view(&id)
            }
            "access:upnpOpen" => self.open_upnp(&id).await,
            "access:upnpClose" => self.close_upnp(&id).await,
            "access:diagnose" => {
                let d = self.mapper.diagnose().await;
                *self.last_diag.lock().unwrap() = Some(d.clone());
                for c in self.store.list() { self.push_access(s(&c["id"])); }
                Ok(d)
            }
            "access:test" => {
                let cfg = scfg!();
                if !self.existing(&id).is_some_and(|i| i.state() == "online") { crate::bail!("Start the server first, then test."); }
                let v = self.access_view(&id)?;
                if v["method"] == "vpn" { crate::bail!("Private networks (Tailscale/ZeroTier) can’t be tested from the public internet. Ask a friend on your network to try."); }
                let port = props::port(&dir_of(&cfg));
                let target = match v["publicAddress"].as_str() {
                    Some(t) => t.to_string(),
                    None => {
                        let d = match self.last_diag.lock().unwrap().clone() { Some(d) => d, None => Value::Null };
                        let d = if d.is_null() { let d = self.mapper.diagnose().await; *self.last_diag.lock().unwrap() = Some(d.clone()); d } else { d };
                        let ip = d["publicIP"].as_str().ok_or_else(|| anyhow::anyhow!("Couldn’t find your public IP address."))?.to_string();
                        Self::with_port(&ip, port)
                    }
                };
                let (host, p) = crate::portmap::split_host_port(&target);
                let mut r = crate::portmap::test_reachable(&host, p).await?;
                r["target"] = json!(target); r["cfgPort"] = json!(port); r["at"] = json!(now_ms());
                Ok(r)
            }
            "access:allowFirewall" => {
                let cfg = scfg!();
                let inst = self.instance(&id)?;
                let java = self.resolve_java(&cfg, &inst, false).await?.ok_or_else(|| anyhow::anyhow!("Java isn't installed yet."))?;
                crate::portmap::allow_through_windows_firewall(&java).await?;
                ok()
            }

            "playit:state" => Ok(self.playit.snapshot()),
            "playit:install" => { let log = self.task_log(arg(a, 0)); self.playit.install(move |m, p| log(m, p)).await?; Ok(self.playit.snapshot()) }
            "playit:start" => { self.playit.start().await?; Ok(self.playit.snapshot()) }
            "playit:stop" => { self.playit.stop(); self.playit.wait_stopped().await; Ok(self.playit.snapshot()) }
            "playit:link" => { let h = self.host.clone(); self.playit.link(move |u| h.open_url(u), 1500, 15 * 60_000).await?; Ok(self.playit.snapshot()) }
            "playit:cancelLink" => { self.playit.cancel_link(); Ok(self.playit.snapshot()) }
            "playit:createTunnel" => {
                let cfg = scfg!();
                if !self.playit.snapshot()["agentId"].is_string() { self.playit.start().await?; }
                let t = self.playit.create_tunnel(s(&cfg["name"]), props::port(&dir_of(&cfg)), false).await?;
                self.push_access(&id);
                Ok(t)
            }
            "playit:logs" => Ok(json!(self.playit.logs())),

            "backups:list" => { let d = dir!(); Ok(json!({ "items": backups::list(&d), "busy": self.backup_busy.lock().unwrap().contains(&id), "folder": backups::backup_dir(&d) })) }
            "backups:create" => self.run_backup(&id, "manual", arg(a, 1).as_str()).await,
            "backups:restore" => {
                if self.existing(&id).is_some_and(|i| i.is_running()) { crate::bail!("Stop the server before restoring a backup."); }
                if !self.backup_busy.lock().unwrap().insert(id.clone()) { crate::bail!("A backup is already running."); }
                let log = self.task_log(arg(a, 2));
                let r = backups::restore(&dir!(), &arg_str(a, 1), &move |m| log(m, None)).await;
                self.backup_busy.lock().unwrap().remove(&id);
                r
            }
            "backups:trash" => { let f = arg_str(a, 1); let name = Path::new(&f).file_name().unwrap_or_default().to_owned(); trash(&backups::backup_dir(&dir!()).join(name))?; ok() }
            "backups:path" => { let d = backups::backup_dir(&dir!()); std::fs::create_dir_all(&d)?; let f = arg_str(a, 1); Ok(json!(if f.is_empty() { d } else { d.join(Path::new(&f).file_name().unwrap_or_default()) })) }

            "modrinth:search" => {
                let cfg = scfg!();
                if kind_of(&cfg) == "none" { crate::bail!("Vanilla servers can’t use plugins or mods."); }
                let mut r = modrinth::search(&cfg, arg(a, 1)).await?;
                let inst = modrinth::installed_map(&cfg);
                if let Some(h) = r["hits"].as_array_mut() { for x in h { let pid = s(&x["id"]).to_string(); x["installed"] = json!(inst.contains_key(&pid)); } }
                Ok(r)
            }
            "modrinth:install" => {
                let cfg = scfg!();
                let mut installed = modrinth::installed_map(&cfg);
                let r = modrinth::install(&cfg, &arg_str(a, 1), &mut installed, &self.task_log(arg(a, 2)), 0, &mut vec![]).await?;
                self.store.update(&id, json!({ "modrinth": installed }))?;
                Ok(json!(r))
            }
            "modrinth:installed" => Ok(Value::Object(modrinth::installed_map(&scfg!()))),
            "modrinth:checkUpdates" => {
                let cfg = scfg!();
                let mut out = vec![];
                for (pid, info) in modrinth::installed_map(&cfg) {
                    if let Ok(Some(v)) = modrinth::best_version(&cfg, &pid).await {
                        if v["id"] != info["versionId"] { out.push(json!({ "projectId": pid, "title": info["title"].as_str().unwrap_or(&pid), "current": info["version"], "latest": v["version_number"] })); }
                    }
                }
                Ok(json!(out))
            }
            "modrinth:updateAll" => {
                let cfg = scfg!();
                let mut installed = modrinth::installed_map(&cfg);
                let log = self.task_log(arg(a, 2));
                let mut done = vec![];
                for pid in serde_json::from_value::<Vec<String>>(arg(a, 1).clone()).unwrap_or_default() {
                    log(format!("Updating {}…", installed.get(&pid).and_then(|v| v["title"].as_str()).unwrap_or(&pid)), None);
                    match modrinth::install(&cfg, &pid, &mut installed, &log, 0, &mut vec![]).await {
                        Ok(r) => done.extend(r),
                        Err(e) => log(format!("Skipped: {e}"), None),
                    }
                }
                self.store.update(&id, json!({ "modrinth": installed }))?;
                Ok(json!(done))
            }

            "icon:get" => { let p = dir!().join("server-icon.png"); Ok(if p.exists() { Self::icon_data(&p, 64).map(Value::from).unwrap_or(Value::Null) } else { Value::Null }) }
            "icon:setFrom" => self.set_icon_from(&id, Path::new(&arg_str(a, 1))),
            "icon:remove" => { let p = dir!().join("server-icon.png"); if p.exists() { let _ = trash(&p); } ok() }

            "stats:get" => {
                let cfg = scfg!();
                let online = self.existing(&id).filter(|i| i.is_running()).map(|i| i.player_names()).unwrap_or_default();
                let mut v = self.stats.summary(&id, &online);
                v["worldBytes"] = Value::Null;
                v["supportsTps"] = json!(Self::tps_support(&cfg));
                Ok(v)
            }
            "stats:worldSize" | "worlds:size" => {
                let d = dir!();
                let w = worlds::list_server_worlds(&d);
                let mut folders: Vec<String> = vec![];
                for x in w["worlds"].as_array().cloned().unwrap_or_default() {
                    folders.push(s(&x["folder"]).to_string());
                    for d in x["dims"].as_array().cloned().unwrap_or_default() { folders.push(s(&d).to_string()); }
                }
                Ok(json!(tokio::task::spawn_blocking(move || worlds::world_dir_size(&d, &folders)).await?))
            }
            "stats:reset" => { self.stats.forget(&id); ok() }

            "geyser:status" => self.bedrock_view(&id),
            "geyser:install" => {
                let cfg = scfg!();
                let log = self.task_log(arg(a, 1));
                let mut installed = obj(&cfg["modrinth"]);
                let port = cfg["crossplay"]["port"].as_u64().map(|p| p as u16).unwrap_or_else(|| self.next_bedrock_port(&id));
                let mut r = geyser::install(&cfg, &mut installed, port, &log).await?;
                self.store.update(&id, json!({ "modrinth": installed, "crossplay": { "enabled": true, "port": port } }))?;
                if let Some(i) = self.existing(&id).filter(|i| i.is_running()) { i.info("Bedrock crossplay installed. Restart the server to turn it on."); }
                log("Done! Bedrock players can join after the next (re)start.".into(), None);
                r["view"] = self.bedrock_view(&id)?;
                Ok(r)
            }
            "geyser:setEnabled" => {
                let cfg = scfg!();
                let on = arg(a, 1) == true;
                geyser::set_enabled(&cfg, on);
                let port = cfg["crossplay"]["port"].as_u64().map(|p| p as u16).unwrap_or_else(|| self.next_bedrock_port(&id));
                self.store.update(&id, json!({ "crossplay": { "enabled": on, "port": port } }))?;
                self.bedrock_view(&id)
            }
            "geyser:setPort" => {
                let port = arg(a, 1).as_u64().or_else(|| arg_str(a, 1).parse().ok()).unwrap_or(0);
                if !(1024..=65535).contains(&port) { crate::bail!("Pick a port between 1024 and 65535."); }
                let mut cp = obj(&scfg!()["crossplay"]);
                cp.insert("port".into(), json!(port));
                let cfg = self.store.update(&id, json!({ "crossplay": cp }))?;
                geyser::apply_config(&cfg, port as u16)?;
                self.bedrock_view(&id)
            }
            "geyser:createTunnel" => {
                let cfg = scfg!();
                let t = self.playit.create_tunnel(s(&cfg["name"]), self.bedrock_view(&id)?["port"].as_u64().unwrap_or(19132) as u16, true).await?;
                self.push_bedrock(&id);
                Ok(t)
            }

            "worlds:saves" => {
                let d = if id.is_empty() { crate::paths::default_saves_dir() } else { PathBuf::from(&id) };
                let (saves, only) = worlds::saves_or_world(&d);
                let mut l = worlds::list_saves(&saves);
                if let Some(o) = only { l.retain(|w| PathBuf::from(s(&w["dir"])) == o); }
                for w in &mut l { if let Some(icon) = w["icon"].as_str().map(PathBuf::from) { w["icon"] = Self::icon_data(&icon, 64).map(Value::from).unwrap_or(Value::Null); } }
                Ok(json!(l))
            }
            "worlds:savesDir" => { let d = crate::paths::default_saves_dir(); Ok(json!({ "default": d, "exists": d.exists() })) }
            "worlds:accounts" => Ok(json!(worlds::launcher_accounts(&crate::paths::minecraft_dir()))),
            "worlds:lookup" => worlds::lookup_player(&id).await,
            "worlds:list" => {
                let d = dir!();
                let mut r = worlds::list_server_worlds(&d);
                if let Some(ws) = r["worlds"].as_array_mut() {
                    for w in ws {
                        if w["missing"] == true { continue; }
                        let folders: Vec<String> = std::iter::once(s(&w["folder"]).to_string()).chain(w["dims"].as_array().cloned().unwrap_or_default().iter().map(|x| s(x).to_string())).collect();
                        w["size"] = json!(worlds::world_dir_size(&d, &folders));
                    }
                }
                Ok(r)
            }
            "worlds:importSave" => {
                let o = arg(a, 1);
                let cfg = scfg!();
                let d = dir_of(&cfg);
                if o["setActive"] == true && self.existing(&id).is_some_and(|i| i.is_running()) { crate::bail!("Stop the server first: switching worlds needs a restart anyway."); }
                let target = o["targetName"].as_str().filter(|t| !t.is_empty()).unwrap_or("world").to_string();
                let player = o["player"]["uuid"].as_str().map(|u| (u.to_string(), s(&o["player"]["name"]).to_string()));
                let done = worlds::copy_save_to_server(Path::new(s(&o["worldDir"])), &d, &target, player.as_ref().map(|(u, n)| (u.as_str(), n.as_str())), o["makeOp"] == true)?;
                if o["setActive"] == true {
                    let p: Vec<(String, String)> = if o["applySettings"] == false { vec![("level-name".into(), target.clone())] } else { worlds::props_for_world(&done["info"], &target) };
                    props::write(&d, &p.into_iter().collect())?;
                }
                let icon = Path::new(s(&o["worldDir"])).join("icon.png");
                if o["copyIcon"] != false && icon.exists() && !d.join("server-icon.png").exists() { let _ = self.set_icon_from(&id, &icon); }
                Ok(done)
            }
            "worlds:setActive" => {
                let f = arg_str(a, 1);
                let d = dir!();
                if !files::safe(&d, &f)?.join("level.dat").exists() { crate::bail!("That world folder is missing."); }
                props::set(&d, &[("level-name", &f)])?;
                Ok(json!({ "restartNeeded": self.existing(&id).is_some_and(|i| i.is_running()) }))
            }
            "worlds:reset" => {
                let f = arg_str(a, 1);
                if self.existing(&id).is_some_and(|i| i.is_running()) { crate::bail!("Stop the server before resetting a world."); }
                if let Err(e) = self.run_backup(&id, "manual", Some("world")).await { if !e.to_string().to_lowercase().contains("no world folder") { return Err(e); } }
                let d = dir!();
                for x in [f.clone(), format!("{f}_nether"), format!("{f}_the_end")] { let p = files::safe(&d, &x)?; if p.exists() { trash(&p)?; } }
                let seed = arg(a, 2)["seed"].clone();
                props::set(&d, &[("level-seed", &if seed.is_null() { String::new() } else { seed.as_str().map(String::from).unwrap_or_else(|| seed.to_string()) })])?;
                Ok(json!({ "ok": true }))
            }
            "worlds:trash" => {
                let f = arg_str(a, 1);
                let d = dir!();
                if f == props::level_name(&d) { crate::bail!("That’s the active world. Switch to another world first."); }
                for x in [f.clone(), format!("{f}_nether"), format!("{f}_the_end")] { let p = files::safe(&d, &x)?; if p.exists() { trash(&p)?; } }
                ok()
            }
            "worlds:exportToSaves" => {
                let f = arg_str(a, 1);
                let o = arg(a, 2);
                let inst = self.existing(&id).filter(|i| i.state() == "online");
                if let Some(i) = &inst {
                    let re = regex::Regex::new(r"(?i)Saved the game|Saved the world|All dimensions are saved").unwrap();
                    i.send("save-off")?;
                    let saved = i.wait_for_line(&re, 60_000);
                    i.send("save-all flush")?;
                    let _ = saved.await;
                }
                let r = worlds::copy_server_world_to_saves(&dir!(), &f, &crate::paths::default_saves_dir(), o["newName"].as_str(), o["player"]["uuid"].as_str());
                if let Some(i) = &inst { if i.is_running() { let _ = i.send("save-on"); } }
                r
            }
            "worlds:savesPath" => { let d = crate::paths::default_saves_dir(); std::fs::create_dir_all(&d)?; Ok(json!(d)) }

            "server:changeVersion" => {
                let cfg = scfg!();
                let mc = arg_str(a, 1);
                let log = self.task_log(arg(a, 2));
                if self.existing(&id).is_some_and(|i| i.is_running()) { crate::bail!("Stop the server first."); }
                if let Some(cur) = cfg["mcVersion"].as_str().filter(|v| !v.is_empty()) {
                    if versions::compare(&mc, cur).is_lt() { crate::bail!("Minecraft can’t downgrade a world ({cur} → {mc}); it would corrupt it. Restore an older backup instead, or create a new server."); }
                }
                let sw = providers::get(s(&cfg["software"]))?;
                log("Backing up the world first…".into(), None);
                if let Err(e) = self.run_backup(&id, "manual", Some("world")).await { if !e.to_string().to_lowercase().contains("no world folder") { return Err(e); } }
                let major = providers::java_major_for(&mc).await;
                let java = java::ensure(major, log.clone()).await?;
                log(format!("Installing {} {mc}…", sw.label), None);
                let launch = providers::install(sw.id, &mc, &dir_of(&cfg), None, &log, &java).await?;
                let keep_java = cfg["javaPath"].as_str().is_some_and(|p| !p.is_empty() && Path::new(p).exists()) && cfg["javaMajor"].as_u64() == Some(major as u64);
                let updated = self.store.update(&id, json!({ "mcVersion": mc, "javaMajor": major, "launchArgs": launch, "javaPath": if keep_java { cfg["javaPath"].clone() } else { json!("") } }))?;
                if let Some(i) = self.existing(&id) { i.set_cfg(updated.clone()); }
                log(format!("Now on {} {mc}. Check Plugins/Mods for updates before starting.", sw.label), Some(1.0));
                Ok(updated)
            }
            "webhook:test" => {
                let url = arg_str(a, 0).trim().to_string();
                if !Self::webhook_ok(&url) { crate::bail!("That doesn’t look like a Discord webhook URL (Server Settings → Integrations → Webhooks → Copy Webhook URL)."); }
                Self::post_webhook(&url, "👋 Blockyard is connected. Server notifications will appear here.").await?;
                ok()
            }
            "logs:list" => {
                let d = dir!();
                let mut out: Vec<Value> = vec![];
                for (folder, kind, ext) in [("logs", "log", [".log", ".log.gz"].as_slice()), ("crash-reports", "crash", [".txt"].as_slice())] {
                    for e in std::fs::read_dir(d.join(folder)).map(|r| r.flatten().collect::<Vec<_>>()).unwrap_or_default() {
                        let n = e.file_name().to_string_lossy().into_owned();
                        if !ext.iter().any(|x| n.to_lowercase().ends_with(x)) { continue; }
                        let Ok(m) = e.metadata() else { continue };
                        let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
                        out.push(json!({ "rel": format!("{folder}/{n}"), "name": n, "kind": kind, "size": m.len(), "time": t }));
                    }
                }
                out.sort_by(|x, y| (y["name"] == "latest.log").cmp(&(x["name"] == "latest.log")).then(y["time"].as_i64().cmp(&x["time"].as_i64())));
                Ok(json!(out))
            }
            "logs:read" => {
                let rel = arg_str(a, 1).replace('\\', "/");
                if !(rel.starts_with("logs/") || rel.starts_with("crash-reports/")) { crate::bail!("Only log files can be opened here."); }
                let p = files::safe(&dir!(), &rel)?;
                let mut buf = std::fs::read(&p)?;
                if rel.to_lowercase().ends_with(".gz") { use std::io::Read; let mut out = vec![]; flate2::read::GzDecoder::new(&buf[..]).read_to_end(&mut out)?; buf = out; }
                let max = 1536 * 1024;
                let text = if buf.len() > max { format!("…(start of file cut, showing the last 1.5 MB)…\n{}", String::from_utf8_lossy(&buf[buf.len() - max..])) } else { String::from_utf8_lossy(&buf).into_owned() };
                Ok(json!(regex::Regex::new(r"\x1b\[[0-9;]*m").unwrap().replace_all(&text, "")))
            }
            "app:logError" => { self.log("renderer", &format!("{} {}", arg_str(a, 0), arg_str(a, 1))); ok() }
            "app:checkUpdate" => {
                if arg(a, 0) != true && self.store.settings()["checkUpdates"] == false { return Ok(json!({ "current": self.version, "available": false, "disabled": true })); }
                updates::check(&self.version).await
            }
            "app:issueUrl" => Ok(json!(updates::issue_url(&self.version))),
            "app:logDir" => { std::fs::create_dir_all(self.log_dir())?; Ok(json!(self.log_dir())) }
            "tray:items" => Ok(json!(self.tray_items())),
            _ => crate::bail!("Unknown request: {channel}"),
        }
    }
}
