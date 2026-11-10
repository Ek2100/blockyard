//! Shared test helpers: a mock web server for every outside service, a fake home router, a recording
//! host, and the fake Minecraft server jars.
#![allow(dead_code)]
use blockyard_core::host::{Ask, Host};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn fake(name: &str) -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fake").join(name) }

/// Tests that touch the shared mock routes / global caches run one at a time.
pub async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(())).lock().await
}

pub async fn java() -> String {
    if let Ok(j) = std::env::var("BLOCKYARD_TEST_JAVA") { return j; }
    blockyard_core::java::list(true).await.first().map(|j| j.path.clone()).expect("tests need Java 17+ installed (or BLOCKYARD_TEST_JAVA)")
}

// ---------- mock HTTP ----------
pub type Handler = Arc<dyn Fn(&str, &[u8]) -> (u16, Vec<u8>) + Send + Sync>;
#[derive(Default)]
pub struct Routes { map: HashMap<String, Handler>, pub hits: HashMap<String, usize>, pub bodies: Vec<(String, String)> }

pub fn routes() -> &'static Mutex<Routes> { static R: OnceLock<Mutex<Routes>> = OnceLock::new(); R.get_or_init(|| Mutex::new(Routes::default())) }

/// `url` is the real https URL (e.g. "https://api.modrinth.com/v2/search?…"); a trailing `*` matches a prefix.
pub fn route_json(url: &str, v: Value) { let b = v.to_string().into_bytes(); route_fn(url, move |_, _| (200, b.clone())); }
pub fn route_bytes(url: &str, b: Vec<u8>) { route_fn(url, move |_, _| (200, b.clone())); }
pub fn route_status(url: &str, code: u16) { route_fn(url, move |_, _| (code, vec![])); }
pub fn route_fn(url: &str, f: impl Fn(&str, &[u8]) -> (u16, Vec<u8>) + Send + Sync + 'static) {
    routes().lock().unwrap().map.insert(url.trim_start_matches("https://").to_string(), Arc::new(f));
}
pub fn clear_routes() { let mut r = routes().lock().unwrap(); r.map.clear(); r.hits.clear(); r.bodies.clear(); }
pub fn hits(url: &str) -> usize { *routes().lock().unwrap().hits.get(url.trim_start_matches("https://")).unwrap_or(&0) }

fn find(path: &str) -> Option<Handler> {
    let r = routes().lock().unwrap();
    if let Some(h) = r.map.get(path) { return Some(h.clone()); }
    r.map.iter().filter(|(k, _)| k.ends_with('*') && path.starts_with(&k[..k.len() - 1])).max_by_key(|(k, _)| k.len()).map(|(_, h)| h.clone())
}

/// Start (once) the mock server and point Blockyard's HTTP at it.
pub async fn mock_http() -> String {
    static BASE: OnceLock<String> = OnceLock::new();
    if let Some(b) = BASE.get() { blockyard_core::net::set_override(Some(b.clone())); return b.clone(); }
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        rt.block_on(async move {
            let l = tokio::net::TcpListener::from_std(l.into_std().unwrap()).unwrap();
            loop {
                let Ok((mut s, _)) = l.accept().await else { continue };
                tokio::spawn(async move {
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
                    let body = buf[head_end..].to_vec();
                    let target = head.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                    {
                        let mut r = routes().lock().unwrap();
                        *r.hits.entry(target.clone()).or_default() += 1;
                        r.bodies.push((target.clone(), String::from_utf8_lossy(&body).into_owned()));
                    }
                    let (code, out) = match find(&target) { Some(h) => h(&target, &body), None => (404, b"no route".to_vec()) };
                    let resp = format!("HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
                    let _ = s.write_all(resp.as_bytes()).await;
                    // Stream big bodies in chunks so download progress code runs.
                    for c in out.chunks(16 * 1024) { if s.write_all(c).await.is_err() { break; } }
                    let _ = s.flush().await;
                });
            }
        });
    });
    BASE.set(base.clone()).ok();
    blockyard_core::net::set_override(Some(base.clone()));
    base
}

pub fn sha512(b: &[u8]) -> String { use sha2::Digest; hex::encode(sha2::Sha512::digest(b)) }
pub fn sha256(b: &[u8]) -> String { use sha2::Digest; hex::encode(sha2::Sha256::digest(b)) }
pub fn sha1(b: &[u8]) -> String { use sha1::Digest; hex::encode(sha1::Sha1::digest(b)) }

/// Mojang + Paper for one Minecraft version, serving the fake server jar.
pub fn route_paper(mc: &str) {
    let jar = std::fs::read(fake("server.jar")).unwrap();
    route_json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", json!({ "versions": [{ "id": mc, "type": "release", "url": format!("https://piston-meta.mojang.com/v1/{mc}.json") }] }));
    route_json(&format!("https://piston-meta.mojang.com/v1/{mc}.json"), json!({ "javaVersion": { "majorVersion": 17 }, "downloads": { "server": { "url": "https://piston-data.mojang.com/server.jar" } } }));
    route_bytes("https://piston-data.mojang.com/server.jar", jar.clone());
    route_json("https://fill.papermc.io/v3/projects/paper", json!({ "versions": { "1.21": [mc, "1.21-pre1"], "1.20": ["1.20.6"] } }));
    route_json(&format!("https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds"), json!([
        { "id": 230, "channel": "STABLE", "downloads": { "server:default": { "url": "https://fill-data.papermc.io/paper-230.jar" } } },
        { "id": 232, "channel": "STABLE", "downloads": { "server:default": { "url": "https://fill-data.papermc.io/paper-232.jar" } } },
        { "id": 233, "channel": "ALPHA", "downloads": { "server:default": { "url": "https://fill-data.papermc.io/paper-233.jar" } } },
    ]));
    route_bytes("https://fill-data.papermc.io/paper-232.jar", jar);
}

// ---------- recording host ----------
#[derive(Default)]
pub struct TestHost {
    pub events: Mutex<Vec<(String, Value)>>,
    pub notes: Mutex<Vec<(String, String)>>,
    pub asked: Mutex<Vec<String>>,
    pub answers: Mutex<Vec<usize>>,
    pub opened: Mutex<Vec<String>>,
}
impl TestHost {
    pub fn new() -> Arc<TestHost> { Arc::new(TestHost::default()) }
    pub fn events(&self, name: &str) -> Vec<Value> { self.events.lock().unwrap().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect() }
    pub fn lines(&self, id: &str) -> Vec<String> {
        self.events("server:line").iter().filter(|e| e["id"] == id).map(|e| e["line"]["text"].as_str().unwrap_or("").to_string()).collect()
    }
}
impl Host for TestHost {
    fn emit(&self, event: &str, payload: Value) { self.events.lock().unwrap().push((event.into(), payload)); }
    fn notify(&self, t: &str, b: &str, _always: bool) { self.notes.lock().unwrap().push((t.into(), b.into())); }
    fn ask(&self, a: Ask) -> BoxFuture<'static, usize> {
        self.asked.lock().unwrap().push(a.message.clone());
        let ans = { let mut q = self.answers.lock().unwrap(); if q.is_empty() { 0 } else { q.remove(0) } };
        Box::pin(async move { ans })
    }
    fn open_url(&self, url: &str) { self.opened.lock().unwrap().push(url.into()); }
}

pub async fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < end {
        if f() { return; }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

// ---------- fake home router: NAT-PMP (UDP) + UPnP IGD (HTTP) ----------
#[derive(Default)]
pub struct RouterState {
    pub external_ip: String,
    pub pmp_enabled: bool,
    pub upnp_enabled: bool,
    pub permanent_only: bool,
    pub conflicts: HashMap<u16, String>,
    pub pmp_maps: HashMap<(u16, u8), (u16, u32)>,
    pub upnp_maps: HashMap<(u16, String), (String, u32)>,
    pub calls: Vec<String>,
}
pub struct Router { pub state: Arc<Mutex<RouterState>>, pub pmp_port: u16, pub location: String }

impl Router {
    pub fn opts(&self) -> blockyard_core::portmap::MapperOpts {
        blockyard_core::portmap::MapperOpts::from_json(&json!({ "gateway": "127.0.0.1", "lanIp": "192.168.1.50", "pmpPort": self.pmp_port, "locations": [self.location], "firstTimeout": 100 }))
    }
}

fn arg_of(body: &str, n: &str) -> String {
    regex::Regex::new(&format!("<{n}>([^<]*)</{n}>")).unwrap().captures(body).map(|c| c[1].to_string()).unwrap_or_default()
}

pub async fn start_router(external_ip: &str, pmp: bool, upnp: bool, permanent_only: bool, conflicts: &[(u16, &str)]) -> Router {
    let state = Arc::new(Mutex::new(RouterState { external_ip: external_ip.into(), pmp_enabled: pmp, upnp_enabled: upnp, permanent_only, conflicts: conflicts.iter().map(|(p, c)| (*p, c.to_string())).collect(), ..Default::default() }));
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let pmp_port = udp.local_addr().unwrap().port();
    let st = state.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 64];
        while let Ok((n, from)) = udp.recv_from(&mut buf).await {
            if n < 2 { continue; }
            let op = buf[1];
            let mut res = vec![0u8; if op == 0 { 12 } else { 16 }];
            res[1] = 128 + op;
            let s = st.lock().unwrap().pmp_enabled;
            res[2..4].copy_from_slice(&(if s { 0u16 } else { 2 }).to_be_bytes());
            res[4..8].copy_from_slice(&1234u32.to_be_bytes());
            if op == 0 {
                let ip: std::net::Ipv4Addr = st.lock().unwrap().external_ip.parse().unwrap();
                res[8..12].copy_from_slice(&ip.octets());
            } else {
                let internal = u16::from_be_bytes([buf[4], buf[5]]);
                let external = u16::from_be_bytes([buf[6], buf[7]]);
                let life = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
                let mut g = st.lock().unwrap();
                g.calls.push(format!("pmp {op} {internal} {external} {life}"));
                if g.pmp_enabled { if life == 0 { g.pmp_maps.remove(&(internal, op)); } else { g.pmp_maps.insert((internal, op), (external, life)); } }
                res[8..10].copy_from_slice(&internal.to_be_bytes());
                res[10..12].copy_from_slice(&(if life == 0 { 0 } else { external }).to_be_bytes());
                res[12..16].copy_from_slice(&life.to_be_bytes());
            }
            let _ = udp.send_to(&res, from).await;
        }
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!("http://{}/rootDesc.xml", l.local_addr().unwrap());
    let st = state.clone();
    tokio::spawn(async move {
        const SVC: &str = "urn:schemas-upnp-org:service:WANIPConnection:1";
        loop {
            let Ok((mut s, _)) = l.accept().await else { continue };
            let st = st.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    let n = match s.read(&mut tmp).await { Ok(0) | Err(_) => return, Ok(n) => n };
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len: usize = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
                while buf.len() < head_end + len { let n = s.read(&mut tmp).await.unwrap_or(0); if n == 0 { break; } buf.extend_from_slice(&tmp[..n]); }
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let action = head.lines().find_map(|l| l.to_lowercase().starts_with("soapaction:").then(|| l.split('#').nth(1).unwrap_or("").trim_matches(['"', ' ', '\r']).to_string())).unwrap_or_default();
                let (code, out) = if head.starts_with("GET") && path == "/rootDesc.xml" {
                    (200, format!(r#"<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><deviceList><device><deviceList><device><serviceList><service><serviceType>{SVC}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>/ctl/IPConn</controlURL><eventSubURL>/evt/IPConn</eventSubURL><SCPDURL>/x.xml</SCPDURL></service></serviceList></device></deviceList></device></deviceList></device></root>"#))
                } else if path == "/ctl/IPConn" {
                    let mut g = st.lock().unwrap();
                    let (port, proto, lease, client) = (arg_of(&body, "NewExternalPort").parse::<u16>().unwrap_or(0), arg_of(&body, "NewProtocol"), arg_of(&body, "NewLeaseDuration"), arg_of(&body, "NewInternalClient"));
                    g.calls.push(format!("upnp {action} {port} {proto} {lease} {client}"));
                    let fault = |c: u32, d: &str| (500, format!("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>{c}</errorCode><errorDescription>{d}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>"));
                    let okr = |inner: String| (200, format!(r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:{action}Response xmlns:u="{SVC}">{inner}</u:{action}Response></s:Body></s:Envelope>"#));
                    if !g.upnp_enabled { fault(606, "Action not authorized") }
                    else { match action.as_str() {
                        "GetExternalIPAddress" => okr(format!("<NewExternalIPAddress>{}</NewExternalIPAddress>", g.external_ip)),
                        "AddPortMapping" => {
                            if g.permanent_only && lease != "0" { fault(725, "OnlyPermanentLeasesSupported") }
                            else if g.conflicts.contains_key(&port) { fault(718, "ConflictInMappingEntry") }
                            else if g.upnp_maps.get(&(port, proto.clone())).is_some_and(|m| m.0 != client) { fault(718, "ConflictInMappingEntry") }
                            else { g.upnp_maps.insert((port, proto), (client, lease.parse().unwrap_or(0))); okr(String::new()) }
                        }
                        "GetSpecificPortMappingEntry" => {
                            match g.upnp_maps.get(&(port, proto)).map(|m| m.0.clone()).or_else(|| g.conflicts.get(&port).cloned()) {
                                Some(c) => okr(format!("<NewInternalPort>{port}</NewInternalPort><NewInternalClient>{c}</NewInternalClient><NewEnabled>1</NewEnabled>")),
                                None => fault(714, "NoSuchEntryInArray"),
                            }
                        }
                        "DeletePortMapping" => { g.conflicts.remove(&port); g.upnp_maps.remove(&(port, proto)); okr(String::new()) }
                        _ => fault(401, "Invalid Action"),
                    } }
                } else { (404, String::new()) };
                let resp = format!("HTTP/1.1 {code} X\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    Router { state, pmp_port, location }
}

pub fn new_core(host: Arc<TestHost>, data: &std::path::Path, mapper: Option<blockyard_core::portmap::MapperOpts>, playit: Option<blockyard_core::playit::PlayitOpts>) -> Arc<blockyard_core::Core> {
    blockyard_core::Core::new(host, blockyard_core::CoreOpts { data_dir: data.to_path_buf(), version: "2.0.0".into(), mapper, playit })
}
