//! The whole engine through its UI channels, like the app uses it.
mod common;
use blockyard_core::protocol;
use common::*;
use serde_json::{json, Value};
use std::time::Duration;

async fn call(c: &blockyard_core::Core, ch: &str, a: Value) -> Value {
    c.call(ch, a.as_array().cloned().unwrap_or_default()).await.unwrap_or_else(|e| panic!("{ch}: {e}"))
}

#[tokio::test]
async fn create_start_invite_go_public_sleep_and_wake() {
    needs_java!();
    let _g = lock().await;
    mock_http().await;
    blockyard_core::providers::reset_caches();
    route_paper("1.21.4");
    route_json("https://api.mojang.com/users/profiles/minecraft/steve", json!({ "id": "069a79f444e94726a5befca90e38aaf5", "name": "Steve" }));
    std::env::set_var("JAVA_HOME", std::path::Path::new(&java().await).parent().unwrap().parent().unwrap());
    let t = tempfile::tempdir().unwrap();
    let router = start_router("203.0.113.7", true, true, false, &[]).await;
    let host = TestHost::new();
    let c = new_core(host.clone(), &t.path().join("data"), Some(router.opts()), None);
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

    let s = call(&c, "servers:create", json!([{ "name": "Friends SMP", "software": "paper", "mcVersion": "1.21.4", "parentDir": t.path().join("srv"), "port": port, "memoryMB": 512, "eula": true }, "task1"])).await;
    let id = s["id"].as_str().unwrap().to_string();
    assert!(!host.events("task:progress").is_empty());
    assert_eq!(call(&c, "servers:list", json!([])).await.as_array().unwrap().len(), 1);
    assert_eq!(call(&c, "settings:get", json!([])).await["defaultParent"], t.path().join("srv").to_string_lossy().as_ref());

    // Invite while stopped: whitelist.json gets the real account name + UUID.
    let inv = call(&c, "players:invite", json!([id, "steve"])).await;
    assert_eq!(inv["name"], "Steve");
    assert!(inv["text"].as_str().unwrap().contains("Join my Minecraft server (Java Edition 1.21.4)"));
    assert_eq!(call(&c, "players:lists", json!([id])).await["whitelist"], json!(["Steve"]));

    // Going public turns the whitelist on (once) and reports the risk status.
    let v = call(&c, "access:set", json!([id, { "method": "upnp" }])).await;
    assert_eq!(v["secured"]["whitelistOn"], true);
    assert_eq!(v["safety"]["whitelist"], true);
    assert_eq!(v["safety"]["public"], true);
    assert!(v["safety"]["warnings"].as_array().unwrap().is_empty());
    // Turning it off brings the warning back.
    let v = call(&c, "access:setWhitelist", json!([id, false])).await;
    assert!(v["safety"]["warnings"][0].as_str().unwrap().contains("whitelist is off"));
    call(&c, "access:setWhitelist", json!([id, true])).await;

    // Start: the router port opens automatically once it's online.
    call(&c, "server:start", json!([id])).await;
    wait_for("online", 30, || host.events("server:state").iter().any(|e| e["id"] == id && e["state"] == "online")).await;
    wait_for("port opened", 10, || router.state.lock().unwrap().pmp_maps.contains_key(&(port, 2))).await;
    let v = call(&c, "access:get", json!([id])).await;
    assert_eq!(v["publicAddress"], format!("203.0.113.7:{port}"));
    call(&c, "server:command", json!([id, "join Steve"])).await;
    wait_for("Steve online", 10, || host.notes.lock().unwrap().iter().any(|n| n.1.contains("Steve joined"))).await;
    call(&c, "server:command", json!([id, "leave Steve"])).await;

    // Sleep mode: empty for (here) a moment → the server stops but keeps the port, and answers pings.
    call(&c, "servers:update", json!([id, { "automation": { "sleepWhenEmpty": 0.002 } }])).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.run_timers_now();
    wait_for("sleeping", 30, || c.is_sleeping(&id)).await;
    assert!(router.state.lock().unwrap().pmp_maps.contains_key(&(port, 2)), "router port stays open while sleeping");
    let st = protocol::status("127.0.0.1", port, Duration::from_secs(5)).await.unwrap();
    assert!(st["description"]["text"].as_str().unwrap().contains("asleep"));
    assert_eq!(call(&c, "servers:list", json!([])).await[0]["snapshot"]["state"], "sleeping");
    // A stranger can't wake it; a whitelisted player can.
    let msg = protocol::login_attempt("127.0.0.1", port, "Griefer", Duration::from_secs(5)).await.unwrap();
    assert!(msg.contains("whitelist"));
    assert!(c.is_sleeping(&id));
    let msg = protocol::login_attempt("127.0.0.1", port, "Steve", Duration::from_secs(5)).await.unwrap();
    assert!(msg.contains("starting"));
    wait_for("awake and online again", 30, || !c.is_sleeping(&id) && host.events("server:state").iter().rev().find(|e| e["id"] == id).is_some_and(|e| e["state"] == "online")).await;
    assert!(host.notes.lock().unwrap().iter().any(|n| n.1.contains("Waking up because Steve")));

    // Backups through the engine (live, with save-off/save-all).
    let b = call(&c, "backups:create", json!([id, "full"])).await;
    assert!(b["file"].as_str().unwrap().starts_with("full-"));
    assert!(host.lines(&id).iter().any(|l| l.contains("Automatic saving is now disabled")));
    wait_for("save-on", 5, || host.lines(&id).iter().any(|l| l.contains("Automatic saving is now enabled"))).await;

    // Stop: the port closes, stats were recorded.
    call(&c, "servers:update", json!([id, { "automation": { "sleepWhenEmpty": 0 } }])).await;
    call(&c, "server:stop", json!([id])).await;
    wait_for("stopped", 30, || host.events("server:state").iter().rev().find(|e| e["id"] == id).is_some_and(|e| e["state"] == "stopped")).await;
    wait_for("port closed", 10, || !router.state.lock().unwrap().pmp_maps.contains_key(&(port, 2))).await;
    let stats = call(&c, "stats:get", json!([id])).await;
    assert_eq!(stats["starts"], 2);
    assert_eq!(stats["players"][0]["name"], "Steve");
    assert!(c.call("server:start", vec![json!("nope")]).await.is_err());
    c.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test]
async fn eula_and_java_prompts_files_worlds_logs() {
    needs_java!();
    let t = tempfile::tempdir().unwrap();
    let host = TestHost::new();
    let c = new_core(host.clone(), &t.path().join("data"), None, None);
    let dir = t.path().join("Imported");
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::copy(fake("server.jar"), dir.join("server.jar")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    std::fs::write(dir.join("server.properties"), format!("server-port={port}\nlevel-name=world\n")).unwrap();
    std::fs::write(dir.join("logs/latest.log"), "\x1b[32mhello\x1b[0m\n").unwrap();
    let det = call(&c, "servers:detect", json!([dir])).await;
    assert_eq!(det["launchArgs"], json!(["-jar", "server.jar"]));
    let s = call(&c, "servers:import", json!([{ "dir": dir, "software": "vanilla", "launchArgs": ["-jar", "server.jar"], "memoryMB": 512 }])).await;
    let id = s["id"].as_str().unwrap().to_string();
    assert!(c.call("servers:import", vec![json!({ "dir": dir, "software": "vanilla" })]).await.is_err(), "same folder twice");
    call(&c, "servers:update", json!([id, { "javaPath": java().await, "name": "Renamed", "dir": "/hacked" }])).await;
    assert_eq!(c.cfg_of(&id).unwrap()["dir"], dir.to_string_lossy().as_ref(), "dir can't be changed through update");

    // No EULA yet: asked; "Cancel" leaves it stopped, "I Agree" writes eula.txt.
    host.answers.lock().unwrap().push(2);
    assert_eq!(call(&c, "server:start", json!([id])).await["cancelled"], true);
    assert!(host.asked.lock().unwrap()[0].contains("EULA"));
    call(&c, "server:start", json!([id])).await;
    assert!(std::fs::read_to_string(dir.join("eula.txt")).unwrap().contains("eula=true"));
    wait_for("online", 30, || host.events("server:state").iter().any(|e| e["id"] == id && e["state"] == "online")).await;
    call(&c, "server:stop", json!([id])).await;
    wait_for("stopped", 30, || host.events("server:state").iter().rev().find(|e| e["id"] == id).is_some_and(|e| e["state"] == "stopped")).await;

    // Files, properties, logs.
    call(&c, "files:write", json!([id, "notes.txt", "hi"])).await;
    assert_eq!(call(&c, "files:read", json!([id, "notes.txt"])).await, "hi");
    assert!(c.call("files:read", vec![json!(id), json!("../../etc/passwd")]).await.is_err());
    call(&c, "props:set", json!([id, { "motd": "Hello: there", "max-players": 7 }])).await;
    let p = call(&c, "props:get", json!([id])).await;
    assert_eq!((p["values"]["motd"].as_str(), p["values"]["max-players"].as_str()), (Some("Hello: there"), Some("7")));
    let logs = call(&c, "logs:list", json!([id])).await;
    assert_eq!(logs[0]["name"], "latest.log");
    assert_eq!(call(&c, "logs:read", json!([id, "logs/latest.log"])).await, "hello\n");
    assert!(c.call("logs:read", vec![json!(id), json!("server.properties")]).await.is_err());
    // Version downgrades are refused before touching anything.
    call(&c, "servers:update", json!([id, { "mcVersion": "1.21.4", "software": "paper" }])).await;
    assert!(c.call("server:changeVersion", vec![json!(id), json!("1.20.1"), json!("t")]).await.unwrap_err().to_string().contains("downgrade"));
    // Unknown channel.
    assert!(c.call("nope:nope", vec![]).await.unwrap_err().to_string().contains("Unknown request"));
    // Removing (no trash) forgets it.
    call(&c, "servers:remove", json!([id, { "trash": false }])).await;
    assert!(dir.exists());
    assert_eq!(call(&c, "servers:list", json!([])).await, json!([]));
}

#[tokio::test]
async fn double_start_runs_one_server() {
    needs_java!();
    let t = tempfile::tempdir().unwrap();
    let host = TestHost::new();
    let c = new_core(host.clone(), &t.path().join("data"), None, None);
    let dir = t.path().join("S");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(fake("server.jar"), dir.join("server.jar")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    std::fs::write(dir.join("server.properties"), format!("server-port={port}\n")).unwrap();
    std::fs::write(dir.join("eula.txt"), "eula=true\n").unwrap();
    let s = call(&c, "servers:import", json!([{ "dir": dir, "software": "vanilla", "launchArgs": ["-jar", "server.jar"], "memoryMB": 512 }])).await;
    let id = s["id"].as_str().unwrap().to_string();
    call(&c, "servers:update", json!([id, { "javaPath": java().await }])).await;
    let (a, b) = tokio::join!(c.call("server:start", vec![json!(id)]), c.call("server:start", vec![json!(id)]));
    assert!(a.is_ok() && b.is_ok(), "{a:?} {b:?}");
    wait_for("online", 30, || host.events("server:state").iter().any(|e| e["id"] == id && e["state"] == "online")).await;
    assert_eq!(host.lines(&id).iter().filter(|l| l.starts_with("Starting server with")).count(), 1, "only one process");
    call(&c, "server:stop", json!([id])).await;
    wait_for("stopped", 30, || host.events("server:state").iter().rev().find(|e| e["id"] == id).is_some_and(|e| e["state"] == "stopped")).await;
}
