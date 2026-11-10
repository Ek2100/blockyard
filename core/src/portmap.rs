//! Automatic router port forwarding (NAT-PMP + UPnP IGD) and network diagnostics.
//! NAT-PMP is a tiny UDP protocol; UPnP is SSDP discovery plus SOAP over HTTP. No native dependencies.
use crate::{net, proc, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UdpSocket;

// ---------- address helpers ----------
fn ip4(s: &str) -> Option<Ipv4Addr> { s.trim().parse().ok() }
fn in_range(ip: &str, base: [u8; 4], bits: u32) -> bool {
    match ip4(ip) { Some(a) => (u32::from(a) >> (32 - bits)) == (u32::from(Ipv4Addr::from(base)) >> (32 - bits)), None => false }
}
pub fn is_private(ip: &str) -> bool { in_range(ip, [10, 0, 0, 0], 8) || in_range(ip, [172, 16, 0, 0], 12) || in_range(ip, [192, 168, 0, 0], 16) }
pub fn is_cgnat(ip: &str) -> bool { in_range(ip, [100, 64, 0, 0], 10) }

/// IPv4 addresses of this computer's network adapters (Wi-Fi/Ethernet first).
pub fn lan_addresses() -> Vec<Value> {
    let mut out: Vec<(bool, Value)> = vec![];
    for i in netdev::get_interfaces() {
        let name = i.friendly_name.clone().unwrap_or_else(|| i.name.clone());
        for n in &i.ipv4 {
            let a = n.addr();
            if a.is_loopback() || a.is_link_local() || a.is_unspecified() { continue; }
            let preferred = i.default || i.name.starts_with("en") || name.to_lowercase().contains("wi-fi") || name.to_lowercase().contains("ethernet");
            out.push((preferred, json!({ "name": name, "address": a.to_string() })));
        }
    }
    out.sort_by_key(|x| !x.0);
    out.into_iter().map(|x| x.1).collect()
}

/// Tailscale hands out 100.64/10 addresses.
pub fn tailscale_address() -> Option<String> {
    lan_addresses().into_iter().filter_map(|a| a["address"].as_str().map(String::from)).find(|a| is_cgnat(a))
}

/// The router and this computer's address on its network.
pub fn default_route() -> (Option<Ipv4Addr>, Option<String>) {
    let Ok(iface) = netdev::get_default_interface() else { return (None, None) };
    let gw = iface.gateway.as_ref().and_then(|g| g.ipv4.first().copied());
    let lan = iface.ipv4.iter().map(|n| n.addr()).find(|a| !is_cgnat(&a.to_string())).map(|a| a.to_string());
    (gw, lan)
}

pub async fn public_ip() -> Option<String> {
    for url in ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"] {
        if let Ok(v) = net::get_json::<Value>(url).await {
            if let Some(ip) = v["ip"].as_str().filter(|s| ip4(s).is_some()) { return Some(ip.into()); }
        }
    }
    net::get_text("https://icanhazip.com").await.ok().map(|t| t.trim().to_string()).filter(|s| ip4(s).is_some())
}

// ---------- NAT-PMP (RFC 6886) ----------
async fn udp_request(host: Ipv4Addr, port: u16, payload: &[u8], tries: u32, first_ms: u64, validate: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>> {
    let sock = UdpSocket::bind(("0.0.0.0", 0)).await?;
    let mut buf = [0u8; 1500];
    for attempt in 0..tries {
        sock.send_to(payload, (host, port)).await?;
        let wait = Duration::from_millis(first_ms << attempt);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await {
                Ok(Ok((n, _))) if validate(&buf[..n]) => return Ok(buf[..n].to_vec()),
                Ok(Ok(_)) => continue,
                Ok(Err(e)) => return Err(e.into()),
                Err(_) => break,
            }
        }
    }
    crate::bail!("timeout")
}

fn pmp_error(code: u16) -> String {
    match code {
        1 => "unsupported version".into(), 2 => "not authorized (NAT-PMP is turned off on the router)".into(),
        3 => "network failure on the router".into(), 4 => "router is out of resources".into(), 5 => "unsupported opcode".into(),
        c => format!("error {c}"),
    }
}

pub async fn pmp_external_ip(gw: Ipv4Addr, o: &MapperOpts) -> Result<String> {
    let m = udp_request(gw, o.pmp_port, &[0, 0], 3, o.first_timeout_ms, |m| m.len() >= 12 && m[1] == 128).await?;
    let code = u16::from_be_bytes([m[2], m[3]]);
    if code != 0 { crate::bail!("NAT-PMP: {}", pmp_error(code)); }
    Ok(format!("{}.{}.{}.{}", m[8], m[9], m[10], m[11]))
}

pub async fn pmp_map(gw: Ipv4Addr, internal: u16, external: u16, lifetime: u32, udp: bool, o: &MapperOpts) -> Result<(u16, u32)> {
    let op = if udp { 1u8 } else { 2 };
    let mut b = [0u8; 12];
    b[1] = op;
    b[4..6].copy_from_slice(&internal.to_be_bytes());
    b[6..8].copy_from_slice(&external.to_be_bytes());
    b[8..12].copy_from_slice(&lifetime.to_be_bytes());
    let m = udp_request(gw, o.pmp_port, &b, 3, o.first_timeout_ms, |m| m.len() >= 16 && m[1] == 128 + op).await?;
    let code = u16::from_be_bytes([m[2], m[3]]);
    if code != 0 { crate::bail!("NAT-PMP: {}", pmp_error(code)); }
    Ok((u16::from_be_bytes([m[10], m[11]]), u32::from_be_bytes([m[12], m[13], m[14], m[15]])))
}

// ---------- UPnP IGD ----------
const IGD_SERVICES: &[&str] = &["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"];

pub async fn ssdp_discover(timeout_ms: u64) -> Vec<String> {
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", 0)).await else { return vec![] };
    let mut sts = vec!["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"];
    sts.extend_from_slice(IGD_SERVICES);
    for st in sts {
        let m = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
        let _ = sock.send_to(m.as_bytes(), ("239.255.255.250", 1900)).await;
    }
    let re = Regex::new(r"(?im)^location:\s*(\S+)").unwrap();
    let mut found: Vec<String> = vec![];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut buf = [0u8; 2048];
    while let Ok(Ok((n, _))) = tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await {
        if let Some(c) = re.captures(&String::from_utf8_lossy(&buf[..n])) {
            let l = c[1].to_string();
            if !found.contains(&l) { found.push(l); }
        }
    }
    found
}

/// The text inside the first `<name>` (any namespace prefix).
pub fn tag(xml: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?is)<(?:\w+:)?{0}[^>]*>(.*?)</(?:\w+:)?{0}>", regex::escape(name))).ok()?;
    re.captures(xml).map(|c| c[1].trim().to_string())
}

#[derive(Clone, Debug)]
pub struct Igd { pub service_type: String, pub control_url: String }

pub async fn igd_control(location: &str) -> Result<Option<Igd>> {
    let xml = net::client().get(location).timeout(Duration::from_secs(6)).send().await?.text().await?;
    let base = tag(&xml, "URLBase").unwrap_or_else(|| location.to_string());
    let block = Regex::new(r"(?is)<service>.*?</service>").unwrap();
    for b in block.find_iter(&xml) {
        let t = tag(b.as_str(), "serviceType").unwrap_or_default();
        if IGD_SERVICES.contains(&t.as_str()) {
            let ctl = tag(b.as_str(), "controlURL").unwrap_or_default();
            let url = url::Url::parse(&base)?.join(&ctl)?.to_string();
            return Ok(Some(Igd { service_type: t, control_url: url }));
        }
    }
    Ok(None)
}

#[derive(Debug)]
pub struct SoapError { pub code: u32, pub desc: String }
impl std::fmt::Display for SoapError { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "UPnP error {}: {}", self.code, self.desc) } }
impl std::error::Error for SoapError {}
fn soap_code(e: &anyhow::Error) -> Option<u32> { e.downcast_ref::<SoapError>().map(|s| s.code) }

pub async fn soap(svc: &Igd, action: &str, args: &[(&str, String)]) -> Result<String> {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;");
    let body = format!(
        "<?xml version=\"1.0\"?>\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{}</u:{action}></s:Body></s:Envelope>",
        svc.service_type, args.iter().map(|(k, v)| format!("<{k}>{}</{k}>", esc(v))).collect::<String>());
    let res = net::client().post(&svc.control_url).timeout(Duration::from_secs(6))
        .header("Content-Type", "text/xml; charset=\"utf-8\"").header("SOAPAction", format!("\"{}#{action}\"", svc.service_type))
        .body(body).send().await.map_err(|e| anyhow::anyhow!("Router didn't answer UPnP ({e})"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = tag(&text, "errorCode").and_then(|c| c.parse().ok()).unwrap_or(status.as_u16() as u32);
        return Err(SoapError { code, desc: tag(&text, "errorDescription").unwrap_or_else(|| format!("HTTP {}", status.as_u16())) }.into());
    }
    Ok(text)
}

fn upnp_hint(code: u32) -> Option<&'static str> {
    match code {
        606 => Some("the router refused (UPnP control is restricted)"), 714 => Some("no such mapping"),
        718 => Some("that port is already forwarded to another device"), 724 => Some("the router needs the same internal and external port"),
        725 => Some("the router only supports permanent mappings"), _ => None,
    }
}

// ---------- the mapper ----------
#[derive(Clone, Default)]
pub struct MapperOpts {
    pub gateway: Option<Ipv4Addr>,
    pub lan_ip: Option<String>,
    pub locations: Option<Vec<String>>,
    pub pmp_port: u16,
    pub first_timeout_ms: u64,
    pub ssdp_timeout_ms: u64,
}

impl MapperOpts {
    pub fn real() -> Self { MapperOpts { pmp_port: 5351, first_timeout_ms: 250, ssdp_timeout_ms: 2500, ..Default::default() } }
    /// Test hook: `{"gateway":"127.0.0.1","lanIp":"192.168.1.50","pmpPort":1234,"locations":["http://…/rootDesc.xml"],"firstTimeout":100}`.
    pub fn from_json(v: &Value) -> Self {
        let mut o = Self::real();
        if let Some(g) = v["gateway"].as_str().and_then(ip4) { o.gateway = Some(g); }
        if let Some(l) = v["lanIp"].as_str() { o.lan_ip = Some(l.into()); }
        if let Some(p) = v["pmpPort"].as_u64() { o.pmp_port = p as u16; }
        if let Some(l) = v["locations"].as_array() { o.locations = Some(l.iter().filter_map(|x| x.as_str().map(String::from)).collect()); }
        if let Some(t) = v["firstTimeout"].as_u64() { o.first_timeout_ms = t; }
        if let Some(t) = v["timeout"].as_u64() { o.ssdp_timeout_ms = t; }
        o
    }
}

struct Mapping { info: Value, renew: Option<tokio::task::JoinHandle<()>> }

pub struct Mapper {
    pub opts: MapperOpts,
    igd: tokio::sync::Mutex<Option<Igd>>,
    maps: Mutex<HashMap<(u16, bool), Mapping>>,
    /// Called when an automatic renewal fails.
    pub on_error: Mutex<Option<Box<dyn Fn(u16, String) + Send + Sync>>>,
}

impl Mapper {
    pub fn new(opts: MapperOpts) -> Arc<Mapper> {
        Arc::new(Mapper { opts, igd: tokio::sync::Mutex::new(None), maps: Mutex::new(HashMap::new()), on_error: Mutex::new(None) })
    }

    fn route(&self) -> (Option<Ipv4Addr>, Option<String>) {
        if let Some(g) = self.opts.gateway { return (Some(g), self.opts.lan_ip.clone().or_else(|| default_route().1)); }
        default_route()
    }

    async fn find_igd(&self) -> Option<Igd> {
        let mut cached = self.igd.lock().await;
        if cached.is_some() { return cached.clone(); }
        let locations = match &self.opts.locations { Some(l) => l.clone(), None => ssdp_discover(self.opts.ssdp_timeout_ms).await };
        for loc in locations {
            if let Ok(Some(svc)) = igd_control(&loc).await { *cached = Some(svc.clone()); return Some(svc); }
        }
        None
    }

    async fn via_upnp(&self, svc: &Igd, lan: &str, port: u16, desc: &str, udp: bool) -> Result<Value> {
        let proto = if udp { "UDP" } else { "TCP" };
        let add = |lease: u32| {
            let args = vec![
                ("NewRemoteHost", String::new()), ("NewExternalPort", port.to_string()), ("NewProtocol", proto.to_string()), ("NewInternalPort", port.to_string()),
                ("NewInternalClient", lan.to_string()), ("NewEnabled", "1".to_string()), ("NewPortMappingDescription", desc.to_string()), ("NewLeaseDuration", lease.to_string()),
            ];
            async move { soap(svc, "AddPortMapping", &args).await }
        };
        let mut lifetime = 3600u32;
        if let Err(e) = add(lifetime).await {
            match soap_code(&e) {
                Some(725) => { lifetime = 0; add(0).await?; }
                Some(718) => {
                    // Already mapped. Fine if it points at us (e.g. left over from last time).
                    let entry = soap(svc, "GetSpecificPortMappingEntry", &[("NewRemoteHost", String::new()), ("NewExternalPort", port.to_string()), ("NewProtocol", proto.into())]).await.unwrap_or_default();
                    let client = tag(&entry, "NewInternalClient");
                    if client.as_deref() != Some(lan) {
                        crate::bail!("Port {port} is already forwarded to another device ({}). Pick another port or remove that rule in your router.", client.unwrap_or_else(|| "unknown".into()));
                    }
                    let _ = soap(svc, "DeletePortMapping", &[("NewRemoteHost", String::new()), ("NewExternalPort", port.to_string()), ("NewProtocol", proto.into())]).await;
                    if let Err(e2) = add(lifetime).await {
                        if soap_code(&e2) == Some(725) { lifetime = 0; add(0).await?; } else { return Err(e2); }
                    }
                }
                _ => return Err(e),
            }
        }
        let ext = soap(svc, "GetExternalIPAddress", &[]).await.ok().and_then(|t| tag(&t, "NewExternalIPAddress"));
        Ok(json!({ "via": "UPnP", "externalIP": ext, "externalPort": port, "lifetime": lifetime }))
    }

    /// Open a port (TCP for Java, UDP for Bedrock). Tries NAT-PMP first (fast), then UPnP.
    pub async fn map(self: &Arc<Self>, port: u16, desc: &str, udp: bool) -> Result<Value> {
        let (gw, lan) = self.route();
        let Some(gw) = gw else { crate::bail!("Couldn't find your router (no default gateway). Are you connected to a network?") };
        let mut errors: Vec<String> = vec![];
        let mut result: Option<Value> = None;
        match pmp_map(gw, port, port, 3600, udp, &self.opts).await {
            Ok((ext, life)) => {
                let ip = pmp_external_ip(gw, &self.opts).await.ok();
                result = Some(json!({ "via": "NAT-PMP", "externalIP": ip, "externalPort": ext, "lifetime": life }));
            }
            Err(e) => errors.push(format!("NAT-PMP: {}", e.to_string().trim_start_matches("NAT-PMP: "))),
        }
        if result.is_none() {
            match self.find_igd().await {
                None => errors.push("UPnP: no UPnP router answered".into()),
                Some(svc) => match self.via_upnp(&svc, lan.as_deref().unwrap_or(""), port, desc, udp).await {
                    Ok(r) => result = Some(r),
                    Err(e) => {
                        if e.to_string().contains("already forwarded") { return Err(e); }
                        errors.push(format!("UPnP: {}", soap_code(&e).and_then(upnp_hint).map(String::from).unwrap_or_else(|| e.to_string())));
                    }
                },
            }
        }
        let Some(mut info) = result else {
            crate::bail!("Your router didn't accept automatic port forwarding. Turn on UPnP (or NAT-PMP) in your router's settings, or use playit.gg or manual port forwarding. ({})", errors.join("; "));
        };
        info["port"] = json!(port); info["protocol"] = json!(if udp { "udp" } else { "tcp" });
        info["gateway"] = json!(gw.to_string()); info["lanIp"] = json!(lan); info["at"] = json!(crate::now_ms());
        let life = info["lifetime"].as_u64().unwrap_or(0);
        let renew = (life > 0).then(|| self.renew_later(port, desc, udp, (life / 2).max(30)));
        if let Some(old) = self.maps.lock().unwrap().insert((port, udp), Mapping { info: info.clone(), renew }) {
            // A renewal replaces its own mapping from inside the task: only abort timers of earlier mappings.
            if let Some(h) = old.renew { if !h.is_finished() && tokio::task::try_id() != Some(h.id()) { h.abort(); } }
        }
        Ok(info)
    }

    /// Renew a mapping before its lease runs out (a plain fn so the recursive future stays `Send`).
    fn renew_later(self: &Arc<Self>, port: u16, desc: &str, udp: bool, secs: u64) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        let desc = desc.to_string();
        let fut: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            if let Err(e) = me.map(port, &desc, udp).await {
                if let Some(cb) = me.on_error.lock().unwrap().as_ref() { cb(port, e.to_string()); }
            }
        });
        tokio::spawn(fut)
    }

    pub fn info(&self, port: u16, udp: bool) -> Option<Value> { self.maps.lock().unwrap().get(&(port, udp)).map(|m| m.info.clone()) }

    pub async fn unmap(&self, port: u16, udp: bool) {
        let Some(m) = self.maps.lock().unwrap().remove(&(port, udp)) else { return };
        if let Some(h) = m.renew { h.abort(); }
        let gw = m.info["gateway"].as_str().and_then(ip4);
        if m.info["via"] == "NAT-PMP" {
            if let Some(gw) = gw { let _ = pmp_map(gw, port, 0, 0, udp, &self.opts).await; }
        } else if let Some(svc) = self.igd.lock().await.clone() {
            let _ = soap(&svc, "DeletePortMapping", &[("NewRemoteHost", String::new()), ("NewExternalPort", port.to_string()), ("NewProtocol", (if udp { "UDP" } else { "TCP" }).into())]).await;
        }
    }

    pub async fn unmap_all(&self) {
        let keys: Vec<(u16, bool)> = self.maps.lock().unwrap().keys().copied().collect();
        futures_util::future::join_all(keys.into_iter().map(|(p, u)| self.unmap(p, u))).await;
    }

    /// What does the network look like? Used by the Public Access check.
    pub async fn diagnose(&self) -> Value {
        let (gw, lan) = self.route();
        let pmp = async { match gw { Some(g) => pmp_external_ip(g, &self.opts).await.ok(), None => None } };
        let (public, pmp_ip, svc, fw) = tokio::join!(public_ip(), pmp, self.find_igd(), firewall_state());
        let mut router_ip = pmp_ip.clone();
        if let Some(s) = &svc {
            if router_ip.is_none() { router_ip = soap(s, "GetExternalIPAddress", &[]).await.ok().and_then(|t| tag(&t, "NewExternalIPAddress")); }
        }
        let nat = match router_ip.as_deref() {
            None => "unknown",
            Some(r) if is_cgnat(r) => "cgnat",
            Some(r) if is_private(r) => "double",
            Some(r) if public.as_deref().is_some_and(|p| p != r) => "cgnat",
            Some(_) => "ok",
        };
        json!({
            "gateway": gw.map(|g| g.to_string()), "lanIp": lan, "publicIP": public, "routerIP": router_ip,
            "natpmp": pmp_ip.is_some(), "upnp": svc.is_some(), "nat": nat, "tailscale": tailscale_address(), "firewall": fw,
            "os": std::env::consts::OS,
        })
    }
}

/// Is the OS firewall on? ("on" | "off" | "unknown")
pub async fn firewall_state() -> &'static str {
    let out = if cfg!(target_os = "macos") {
        proc::output("/usr/libexec/ApplicationFirewall/socketfilterfw", &["--getglobalstate"], 5).await
    } else if cfg!(windows) {
        proc::output("netsh", &["advfirewall", "show", "currentprofile", "state"], 5).await
    } else { return "unknown" };
    let l = out.to_lowercase();
    if l.contains("enabled") || Regex::new(r"state\s+on").unwrap().is_match(&l) { "on" }
    else if l.contains("disabled") || Regex::new(r"state\s+off").unwrap().is_match(&l) { "off" }
    else { "unknown" }
}

/// Windows: add an inbound firewall rule for this Java (asks for administrator permission).
pub async fn allow_through_windows_firewall(java: &str) -> Result<()> {
    if !cfg!(windows) { crate::bail!("Only needed on Windows."); }
    let java = java.replace('\'', "''");
    let rule = format!("advfirewall firewall add rule name=\"Blockyard (Minecraft server)\" dir=in action=allow program=\"{java}\" enable=yes profile=any");
    let ps = format!("Start-Process -FilePath netsh -ArgumentList '{}' -Verb RunAs -Wait -WindowStyle Hidden", rule.replace('\'', "''"));
    let out = proc::command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps]).output().await?;
    if !out.status.success() { crate::bail!("Windows didn't add the rule (permission was probably declined)."); }
    Ok(())
}

/// Ask a public service to connect to the server from the internet.
pub async fn test_reachable(host: &str, port: u16) -> Result<Value> {
    let target = if port != 25565 { format!("{host}:{port}") } else { host.to_string() };
    let enc: String = url::form_urlencoded::byte_serialize(target.as_bytes()).collect();
    match net::get_json::<Value>(&format!("https://api.mcsrvstat.us/3/{enc}")).await {
        Ok(r) => Ok(json!({ "online": r["online"] == true, "via": "mcsrvstat.us", "players": r["players"], "version": r["version"], "target": target })),
        Err(_) => {
            let r: Value = net::get_json(&format!("https://api.mcstatus.io/v2/status/java/{enc}")).await?;
            Ok(json!({ "online": r["online"] == true, "via": "mcstatus.io", "players": r["players"], "version": r["version"]["name_clean"], "target": target }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_addresses() {
        assert!(is_cgnat("100.72.1.9") && !is_cgnat("101.0.0.1"));
        assert!(is_private("192.168.1.1") && is_private("10.2.3.4") && is_private("172.20.0.1") && !is_private("172.32.0.1") && !is_private("8.8.8.8"));
        assert_eq!(tag("<a:NewExternalIPAddress>1.2.3.4</a:NewExternalIPAddress>", "NewExternalIPAddress").as_deref(), Some("1.2.3.4"));
    }
}
