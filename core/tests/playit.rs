//! playit.gg: install, start the daemon, link an account, create tunnels, stop. Uses a fake daemon
//! (Unix socket on macOS/Linux, named pipe on Windows) and a mocked playit API.
mod common;
use blockyard_core::playit::{Playit, PlayitOpts};
use common::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn package_daemon(t: &std::path::Path) -> (Vec<u8>, String) {
    let bin = std::fs::read(env!("CARGO_BIN_EXE_fake-playitd")).unwrap();
    if cfg!(windows) { return (bin, "https://github.com/playit-cloud/playit-agent/releases/latest/download/playitd-windows-x86_64.exe".into()); }
    // Like the real macOS download: a .tar.gz with playit + playitd inside a folder.
    let p = t.join("p.tar.gz");
    let gz = flate2::write::GzEncoder::new(std::fs::File::create(&p).unwrap(), flate2::Compression::default());
    let mut tb = tar::Builder::new(gz);
    for name in ["playitd", "playit"] {
        let mut h = tar::Header::new_gnu();
        h.set_size(bin.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        tb.append_data(&mut h, format!("playit-macos-universal/{name}"), &bin[..]).unwrap();
    }
    tb.into_inner().unwrap().finish().unwrap();
    (std::fs::read(&p).unwrap(), "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-macos-universal.tar.gz".into())
}

#[tokio::test]
async fn install_start_link_tunnel_stop() {
    let _g = lock().await;
    mock_http().await;
    let t = tempfile::tempdir().unwrap();
    let (bytes, url) = package_daemon(t.path());
    route_bytes(&url, bytes);
    let socket = if cfg!(windows) { format!(r"\\.\pipe\blockyard-test-{}", std::process::id()) } else { t.path().join("p.sock").to_string_lossy().into_owned() };
    let dir = t.path().join("playit");
    let p = Playit::new(dir.clone(), PlayitOpts { daemon_path: None, socket_path: Some(socket), download_url: Some(url) });
    let changes = Arc::new(Mutex::new(0usize));
    let c2 = changes.clone();
    p.set_on_change(move |_| *c2.lock().unwrap() += 1);
    assert!(!p.installed());
    assert!(p.start().await.unwrap_err().to_string().contains("Install the playit agent first"));
    p.install(|_, _| {}).await.unwrap();
    assert!(p.installed());

    p.start().await.unwrap();
    let s = p.snapshot();
    assert_eq!(s["daemon"], "running");
    assert_eq!(s["needsLink"], true);

    // Linking: the browser flow goes waiting → approval → accepted, then the code is swapped for a key.
    let setup_calls = Arc::new(Mutex::new(0));
    let sc = setup_calls.clone();
    route_fn("https://api.playit.gg/claim/setup", move |_, body| {
        let b: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(b["agent_type"], "assignable");
        let mut n = sc.lock().unwrap(); *n += 1;
        let state = match *n { 1 => "WaitingForUserVisit", 2 => "WaitingForUser", _ => "UserAccepted" };
        (200, json!({ "status": "success", "data": state }).to_string().into_bytes())
    });
    let ex = Arc::new(Mutex::new(0));
    let e2 = ex.clone();
    route_fn("https://api.playit.gg/claim/exchange", move |_, _| {
        let mut n = e2.lock().unwrap(); *n += 1;
        if *n == 1 { (200, json!({ "status": "fail", "data": "NotAccepted" }).to_string().into_bytes()) }
        else { (200, json!({ "status": "success", "data": { "secret_key": "ab".repeat(32) } }).to_string().into_bytes()) }
    });
    let opened = Arc::new(Mutex::new(vec![]));
    let o2 = opened.clone();
    p.link(move |u| o2.lock().unwrap().push(u.to_string()), 20, 10_000).await.unwrap();
    assert!(opened.lock().unwrap()[0].starts_with("https://playit.gg/claim/"));
    assert_eq!(p.secret(), Some("ab".repeat(32)));
    wait_for("agent running", 5, || p.snapshot()["agentId"] == "11111111-2222-3333-4444-555555555555").await;
    assert_eq!(p.snapshot()["claim"]["status"], "done");

    // Creating a tunnel: the API call, then the daemon reports the address.
    let tunnels = dir.join("tunnels.json");
    let tf = tunnels.clone();
    route_fn("https://api.playit.gg/tunnels/create", move |_, body| {
        let b: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(b["origin"]["data"]["local_port"], 25570);
        assert_eq!(b["tunnel_type"], "minecraft-java");
        std::fs::write(&tf, json!([{ "id": "t1", "display_address": "fun-cat.gl.joinmc.link", "destination": "127.0.0.1:25570", "is_disabled": false }]).to_string()).unwrap();
        (200, json!({ "status": "success", "data": { "id": "t1" } }).to_string().into_bytes())
    });
    let t1 = p.create_tunnel("My Server ✨", 25570, false).await.unwrap();
    assert_eq!(t1["address"], "fun-cat.gl.joinmc.link");
    assert_eq!(p.tunnel_for_port(25570).unwrap()["id"], "t1");
    assert!(p.tunnel_for_port(2557).is_none());
    // An existing tunnel is reused; API errors are explained.
    assert_eq!(p.create_tunnel("x", 25570, false).await.unwrap()["id"], "t1");
    route_json("https://api.playit.gg/tunnels/create", json!({ "status": "fail", "data": "RequiresVerifiedAccount" }));
    assert!(p.create_tunnel("x", 19132, true).await.unwrap_err().to_string().contains("verified account"));

    assert!(*changes.lock().unwrap() > 3);
    p.stop();
    p.wait_stopped().await;
    assert_eq!(p.snapshot()["daemon"], "stopped");
    assert_eq!(p.snapshot()["error"], serde_json::Value::Null, "a requested stop isn't an error");
}

#[tokio::test]
async fn declined_link_is_reported() {
    let _g = lock().await;
    mock_http().await;
    let t = tempfile::tempdir().unwrap();
    let socket = if cfg!(windows) { format!(r"\\.\pipe\blockyard-test2-{}", std::process::id()) } else { t.path().join("q.sock").to_string_lossy().into_owned() };
    let p = Playit::new(t.path().join("pl"), PlayitOpts { daemon_path: Some(env!("CARGO_BIN_EXE_fake-playitd").into()), socket_path: Some(socket), download_url: None });
    route_json("https://api.playit.gg/claim/setup", json!({ "status": "success", "data": "UserRejected" }));
    let e = p.link(|_| {}, 20, 5000).await.unwrap_err().to_string();
    assert!(e.contains("declined"), "{e}");
    assert_eq!(p.snapshot()["claim"]["status"], "failed");
    p.stop();
    p.wait_stopped().await;
}
