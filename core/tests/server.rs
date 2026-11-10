//! Real processes: the fake Minecraft server (a Java program that prints what a server prints).
mod common;
use blockyard_core::instance::{Event, Instance};
use common::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn server_dir(port: u16) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::copy(fake("server.jar"), d.path().join("server.jar")).unwrap();
    std::fs::write(d.path().join("server.properties"), format!("server-port={port}\n")).unwrap();
    d
}

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }

type Seen = Arc<Mutex<Vec<Event>>>;
fn inst(dir: &std::path::Path, extra: Value) -> (Arc<Instance>, Seen) {
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let s = seen.clone();
    let mut cfg = json!({ "id": "t", "name": "Test", "dir": dir, "memoryMB": 512, "launchArgs": ["-jar", "server.jar"] });
    if let (Some(o), Some(e)) = (cfg.as_object_mut(), extra.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
    (Instance::new(cfg, move |e| s.lock().unwrap().push(e)), seen)
}

fn state_of(i: &Instance) -> String { i.snapshot()["state"].as_str().unwrap().to_string() }

#[tokio::test]
async fn finds_java() {
    needs_java!();
    let j = java().await;
    let (v, major) = blockyard_core::java::version_of(std::path::Path::new(&j)).await.expect("java -version");
    assert!(major >= 17, "{v}");
}

#[tokio::test]
async fn lifecycle_players_commands_metrics_stop() {
    needs_java!();
    let port = free_port();
    let d = server_dir(port);
    let (i, seen) = inst(d.path(), json!({ "software": "paper" }));
    i.start(&java().await, false).await.unwrap();
    assert!(i.is_running());
    assert!(i.start(&java().await, false).await.is_err(), "can't start twice");
    wait_for("online", 30, || state_of(&i) == "online").await;
    // ANSI colours and the ">" prompt are cleaned up.
    assert!(i.log().iter().any(|l| l["text"].as_str().unwrap().starts_with("[") && l["text"].as_str().unwrap().contains("Done (1.234s)!")));
    assert!(!blockyard_core::instance::port_free(port).await, "server holds its port");

    i.send("join Steve").unwrap();
    i.send("/join .BedrockPal").unwrap();
    wait_for("2 players", 10, || i.player_count() == 2).await;
    assert_eq!(i.player_uuid("Steve").as_deref(), Some("069a79f4-44e9-4726-a5be-fca90e38aaf5"));
    i.send("leave Steve").unwrap();
    wait_for("1 player", 10, || i.player_count() == 1).await;
    i.send("list").unwrap();
    wait_for("list parsed", 10, || i.snapshot()["maxPlayers"] == 20).await;
    assert_eq!(i.player_names(), vec![".BedrockPal"]);
    {
        let ev = seen.lock().unwrap();
        let players: Vec<(bool, String)> = ev.iter().filter_map(|e| if let Event::Player { join, name } = e { Some((*join, name.clone())) } else { None }).collect();
        assert_eq!(players, vec![(true, "Steve".into()), (true, ".BedrockPal".into()), (false, "Steve".into())]);
    }
    // "chat" prints a line that only *looks* like a join inside chat: must not count.
    i.send("chat").unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(i.player_count(), 1);

    // Background TPS/MSPT probes are parsed and hidden from the console.
    let before = i.log().len();
    assert!(i.probe("tps", blockyard_core::instance::probe_answers("paper"), 3000));
    assert!(i.probe("mspt", blockyard_core::instance::probe_answers("paper"), 3000));
    wait_for("metrics", 10, || i.metrics().0 == Some(20.0) && i.metrics().1 == Some(3.1)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(i.log().len(), before, "probe answers stay out of the console");

    // waitForLine sees a command's answer.
    let re = regex::Regex::new("Saved the game").unwrap();
    let w = i.wait_for_line(&re, 5000);
    i.send("save-all").unwrap();
    assert!(w.await.unwrap().contains("Saved the game"));

    i.stop();
    assert_eq!(state_of(&i), "stopping");
    i.wait_for_exit().await;
    assert_eq!(state_of(&i), "stopped");
    assert!(i.log().iter().any(|l| l["text"] == "Server stopped."));
    let exit = seen.lock().unwrap().iter().find_map(|e| if let Event::Exit { code, expected } = e { Some((*code, *expected)) } else { None });
    assert_eq!(exit, Some((Some(0), true)));
    assert!(blockyard_core::instance::port_free(port).await);
}

#[tokio::test]
async fn crash_kill_and_hung_server() {
    needs_java!();
    let d = server_dir(free_port());
    let (i, seen) = inst(d.path(), json!({}));
    let j = java().await;
    i.start(&j, false).await.unwrap();
    wait_for("online", 30, || state_of(&i) == "online").await;
    i.send("crash").unwrap();
    i.wait_for_exit().await;
    assert!(i.log().iter().any(|l| l["text"].as_str().unwrap().contains("stopped unexpectedly (exit 3)")));
    assert!(seen.lock().unwrap().iter().any(|e| matches!(e, Event::Exit { code: Some(3), expected: false })));

    i.start(&j, false).await.unwrap();
    wait_for("online", 30, || state_of(&i) == "online").await;
    i.kill();
    i.wait_for_exit().await;
    assert!(!i.is_running());

    // A server that ignores "stop" is force-closed after the timeout.
    std::env::set_var("BLOCKYARD_STOP_TIMEOUT_MS", "1500");
    i.start(&j, false).await.unwrap();
    wait_for("online", 30, || state_of(&i) == "online").await;
    i.send("hang").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    i.stop();
    tokio::time::timeout(Duration::from_secs(10), i.wait_for_exit()).await.expect("force-closed");
    assert!(i.log().iter().any(|l| l["text"].as_str().unwrap().contains("force-closed")));
}

#[tokio::test]
async fn port_in_use_and_missing_folder() {
    needs_java!();
    let blocker = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = blocker.local_addr().unwrap().port();
    let d = server_dir(port);
    let (i, _) = inst(d.path(), json!({}));
    let e = i.start(&java().await, false).await.unwrap_err().to_string();
    assert!(e.contains(&format!("Port {port} is already in use")), "{e}");
    let (i2, _) = inst(std::path::Path::new("/definitely/not/here"), json!({}));
    assert!(i2.start(&java().await, false).await.unwrap_err().to_string().contains("folder is missing"));
}

#[tokio::test]
async fn vanilla_tick_query_and_unknown_command_disables_probe() {
    needs_java!();
    let d = server_dir(free_port());
    let (i, _) = inst(d.path(), json!({ "software": "vanilla" }));
    i.start(&java().await, false).await.unwrap();
    wait_for("online", 30, || state_of(&i) == "online").await;
    assert!(i.probe("tick query", blockyard_core::instance::probe_answers("vanilla"), 3000));
    wait_for("mspt", 10, || i.metrics().1 == Some(62.5)).await;
    assert_eq!(i.metrics().0, Some(16.0)); // 1000 / 62.5
    assert!(!i.log().iter().any(|l| l["text"].as_str().unwrap().contains("Average time per tick")));
    // An unknown command answer turns the probe off for this run.
    assert!(i.probe("frobnicate", vec![], 3000));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!i.probe("frobnicate", vec![], 3000));
    i.stop();
    i.wait_for_exit().await;
}

#[tokio::test]
async fn build_args() {
    let (i, _) = inst(std::path::Path::new("."), json!({ "memoryMB": 4096, "optimizedFlags": true, "jvmArgs": "-Dfoo=\"a b\" -Dx=1", "launchArgs": ["@libraries/x/win_args.txt"], "noGui": false }));
    let a = i.build_args();
    assert_eq!(&a[..2], &["-Xms4096M", "-Xmx4096M"]);
    assert!(a.contains(&"-XX:+UseG1GC".to_string()));
    assert!(a.contains(&"-Dfoo=a b".to_string()));
    assert_eq!(a.last().unwrap(), "@libraries/x/win_args.txt");
    let (i2, _) = inst(std::path::Path::new("."), json!({ "memoryMB": 4096 }));
    let b = i2.build_args();
    assert_eq!(&b[..2], &["-Xms1024M", "-Xmx4096M"]);
    assert_eq!(&b[b.len() - 3..], &["-jar", "server.jar", "nogui"]);
}
