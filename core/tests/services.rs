//! Server software, Java, Modrinth, Geyser, modpacks and updates, against mocked web services.
mod common;
use blockyard_core::java::Log;
use blockyard_core::{installer, modrinth, mrpack, providers, updates, worlds};
use common::*;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};

fn logger() -> (Log, Arc<Mutex<Vec<String>>>) {
    let l = Arc::new(Mutex::new(vec![]));
    let l2 = l.clone();
    (Arc::new(move |m: String, _| l2.lock().unwrap().push(m)), l)
}

#[tokio::test]
async fn version_lists() {
    let _g = lock().await;
    mock_http().await;
    providers::reset_caches();
    route_paper("1.21.4");
    route_json("https://api.purpurmc.org/v2/purpur", json!({ "versions": ["1.20.6", "1.21.4", "1.21.4-rc"] }));
    route_json("https://meta.fabricmc.net/v2/versions/game", json!([{ "version": "1.21.4", "stable": true }, { "version": "25w01a", "stable": false }]));
    route_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json", json!({ "promos": { "1.20.1-recommended": "47.3.0", "1.20.1-latest": "47.3.10", "1.7.10-latest": "x", "1.21.4-latest": "54.0.1" } }));
    route_bytes("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
        b"<versions><version>21.1.76</version><version>21.1.77</version><version>21.4.1-beta</version><version>26.1.2.76</version><version>21.1.80+snapshot</version></versions>".to_vec());
    assert_eq!(providers::versions("paper").await.unwrap(), vec!["1.21.4", "1.20.6"]);
    assert_eq!(providers::versions("purpur").await.unwrap(), vec!["1.21.4", "1.20.6"]);
    assert_eq!(providers::versions("fabric").await.unwrap(), vec!["1.21.4"]);
    assert_eq!(providers::versions("vanilla").await.unwrap(), vec!["1.21.4"]);
    assert_eq!(providers::versions("forge").await.unwrap(), vec!["1.21.4", "1.20.1"]);
    assert_eq!(providers::versions("neoforge").await.unwrap(), vec!["26.1.2", "1.21.4", "1.21.1"]);
    assert_eq!(providers::java_major_for("1.21.4").await, 17);
    assert_eq!(providers::java_major_for("1.99").await, 21, "offline/unknown falls back to a guess");
    assert!(providers::versions("bukkit").await.is_err());
}

#[tokio::test]
async fn create_paper_server_then_failed_create_cleans_up() {
    needs_java!();
    let _g = lock().await;
    mock_http().await;
    providers::reset_caches();
    route_paper("1.21.4");
    std::env::set_var("JAVA_HOME", std::path::Path::new(&java().await).parent().unwrap().parent().unwrap());
    let parent = tempfile::tempdir().unwrap();
    let (log, lines) = logger();
    let o = installer::CreateOpts { name: "My: SMP".into(), software: "paper".into(), mc_version: "1.21.4".into(), parent_dir: parent.path().into(), port: 25600, memory_mb: 1024, eula: true, loader: None };
    let cfg = installer::create(&o, log.clone()).await.unwrap();
    let dir = parent.path().join("My SMP");
    assert_eq!(cfg["dir"], dir.to_string_lossy().as_ref());
    assert_eq!(cfg["launchArgs"], json!(["-jar", "server.jar"]));
    assert_eq!(std::fs::read(dir.join("server.jar")).unwrap(), std::fs::read(fake("server.jar")).unwrap());
    assert!(std::fs::read_to_string(dir.join("eula.txt")).unwrap().contains("eula=true"));
    assert_eq!(blockyard_core::props::port(&dir), 25600);
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("Using Paper build #232 (stable)")));
    // Same name again: refused, existing files untouched.
    assert!(installer::create(&o, log.clone()).await.unwrap_err().to_string().contains("already exists"));
    assert!(dir.join("server.jar").exists());
    // A failing download removes the new folder.
    route_status("https://fill-data.papermc.io/paper-232.jar", 503);
    let o2 = installer::CreateOpts { name: "Broken".into(), ..o };
    assert!(installer::create(&o2, log).await.is_err());
    assert!(!parent.path().join("Broken").exists());
    let o3 = installer::CreateOpts { name: "NoEula".into(), software: "paper".into(), mc_version: "1.21.4".into(), parent_dir: parent.path().into(), port: 1, memory_mb: 1, eula: false, loader: None };
    assert!(installer::create(&o3, logger().0).await.unwrap_err().to_string().contains("EULA"));
}

#[tokio::test]
async fn neoforge_runs_its_installer_and_launches_via_the_args_file() {
    needs_java!();
    let _g = lock().await;
    mock_http().await;
    providers::reset_caches();
    route_bytes("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml", b"<version>21.1.77</version>".to_vec());
    route_bytes("https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar", std::fs::read(fake("installer.jar")).unwrap());
    let d = tempfile::tempdir().unwrap();
    let (log, lines) = logger();
    let args = providers::install("neoforge", "1.21.1", d.path(), None, &log, &java().await).await.unwrap();
    let want = if cfg!(windows) { "win_args.txt" } else { "unix_args.txt" };
    assert_eq!(args, vec![format!("@libraries/net/neoforged/neoforge/21.1.77/{want}")]);
    assert!(!d.path().join("neoforge-21.1.77-installer.jar").exists(), "installer removed");
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("installed successfully")), "installer output is streamed (verbose)");
    // And the server actually launches with those args.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    std::fs::write(d.path().join("server.properties"), format!("server-port={port}\n")).unwrap();
    let i = blockyard_core::instance::Instance::new(json!({ "id": "n", "dir": d.path(), "memoryMB": 512, "launchArgs": args }), |_| {});
    i.start(&java().await, false).await.unwrap();
    wait_for("online", 30, || i.state() == "online").await;
    i.stop();
    i.wait_for_exit().await;
    // A pinned loader version (modpacks) skips the version lookup.
    route_bytes("https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.50/neoforge-21.1.50-installer.jar", std::fs::read(fake("installer.jar")).unwrap());
    let d2 = tempfile::tempdir().unwrap();
    providers::install("neoforge", "1.21.1", d2.path(), Some("21.1.50"), &log, &java().await).await.unwrap();
}

fn modrinth_version(id: &str, file: &str, bytes: &[u8], deps: Value, kind: &str, date: &str) -> Value {
    json!({ "id": id, "version_number": id, "name": id, "version_type": kind, "date_published": date, "dependencies": deps,
        "files": [{ "primary": true, "filename": file, "url": format!("https://cdn.modrinth.com/data/{file}"), "hashes": { "sha512": sha512(bytes) } }] })
}

#[tokio::test]
async fn modrinth_search_and_install_with_dependencies_and_checksums() {
    let _g = lock().await;
    mock_http().await;
    let d = tempfile::tempdir().unwrap();
    let cfg = json!({ "dir": d.path(), "software": "fabric", "kind": "mods", "mcVersion": "1.21.4" });
    route_fn("https://api.modrinth.com/v2/search*", |path, _| {
        assert!(path.contains("categories%3Afabric") && path.contains("versions%3A1.21.4") && path.contains("server_side%3Arequired") && path.contains("project_type%3Amod"), "{path}");
        (200, json!({ "total_hits": 1, "hits": [{ "project_id": "P1", "slug": "lithium", "title": "Lithium", "description": "fast", "downloads": 9, "author": "x", "display_categories": ["optimization"] }] }).to_string().into_bytes())
    });
    let r = modrinth::search(&cfg, &json!({ "query": "lith" })).await.unwrap();
    assert_eq!(r["hits"][0]["title"], "Lithium");
    let (a, b) = (b"mod-a-bytes".to_vec(), b"fabric-api-bytes".to_vec());
    route_json("https://api.modrinth.com/v2/project/A/version*", json!([
        modrinth_version("a-beta", "a-2.jar", b"zzz", json!([]), "beta", "2026-02-01T00:00:00Z"),
        modrinth_version("a-1", "a-1.jar", &a, json!([{ "project_id": "FAPI", "dependency_type": "required" }, { "project_id": "OPT", "dependency_type": "optional" }]), "release", "2026-01-01T00:00:00Z"),
    ]));
    route_json("https://api.modrinth.com/v2/project/FAPI/version*", json!([modrinth_version("f-1", "fabric-api.jar", &b, json!([{ "project_id": "A", "dependency_type": "required" }]), "release", "2026-01-01T00:00:00Z")]));
    route_json("https://api.modrinth.com/v2/project/A", json!({ "title": "Mod A" }));
    route_json("https://api.modrinth.com/v2/project/FAPI", json!({ "title": "Fabric API" }));
    route_bytes("https://cdn.modrinth.com/data/a-1.jar", a.clone());
    route_bytes("https://cdn.modrinth.com/data/fabric-api.jar", b.clone());
    let mut installed = serde_json::Map::new();
    let (log, lines) = logger();
    let res = modrinth::install(&cfg, "A", &mut installed, &log, 0, &mut vec![]).await.unwrap();
    assert_eq!(res.iter().map(|r| r["file"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a-1.jar", "fabric-api.jar"], "release preferred over newer beta; deps resolved; cycles stop");
    assert!(d.path().join("mods/a-1.jar").exists() && d.path().join("mods/fabric-api.jar").exists());
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("Installing required dependency Fabric API")));
    assert_eq!(installed["A"]["title"], "Mod A");
    // Again: already up to date, nothing downloaded.
    let n = hits("https://cdn.modrinth.com/data/a-1.jar");
    modrinth::install(&cfg, "A", &mut installed, &log, 0, &mut vec![]).await.unwrap();
    assert_eq!(hits("https://cdn.modrinth.com/data/a-1.jar"), n);
    // A tampered file is rejected and leaves nothing behind.
    route_json("https://api.modrinth.com/v2/project/BAD/version*", json!([modrinth_version("bad-1", "bad.jar", b"expected", json!([]), "release", "2026-01-01T00:00:00Z")]));
    route_bytes("https://cdn.modrinth.com/data/bad.jar", b"tampered".to_vec());
    let e = modrinth::install(&cfg, "BAD", &mut installed, &log, 0, &mut vec![]).await.unwrap_err().to_string();
    assert!(e.contains("checksum"), "{e}");
    assert!(!std::fs::read_dir(d.path().join("mods")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("bad")));
    // Nothing compatible.
    route_json("https://api.modrinth.com/v2/project/NONE/version*", json!([]));
    assert!(modrinth::install(&cfg, "NONE", &mut installed, &log, 0, &mut vec![]).await.unwrap_err().to_string().contains("No version of this mod supports fabric 1.21.4"));
    // Updating replaces the old file.
    let a2 = b"mod-a-v2".to_vec();
    route_json("https://api.modrinth.com/v2/project/A/version*", json!([modrinth_version("a-2", "a-2.jar", &a2, json!([]), "release", "2026-03-01T00:00:00Z")]));
    route_bytes("https://cdn.modrinth.com/data/a-2.jar", a2);
    modrinth::install(&cfg, "A", &mut installed, &log, 0, &mut vec![]).await.unwrap();
    assert!(d.path().join("mods/a-2.jar").exists() && !d.path().join("mods/a-1.jar").exists());
    let mut cfg2 = cfg.clone();
    cfg2["modrinth"] = Value::Object(installed);
    assert_eq!(modrinth::installed_map(&cfg2).len(), 2);
}

#[tokio::test]
async fn geyser_paper_gets_floodgate_spigot_verified_and_fabric_gets_both_from_modrinth() {
    let _g = lock().await;
    mock_http().await;
    let d = tempfile::tempdir().unwrap();
    let cfg = json!({ "dir": d.path(), "software": "paper", "kind": "plugins", "mcVersion": "1.21.4" });
    let (g, f) = (b"geyser-spigot".to_vec(), b"floodgate-spigot".to_vec());
    route_json("https://api.modrinth.com/v2/project/geyser/version*", json!([modrinth_version("g1", "Geyser-Spigot.jar", &g, json!([]), "release", "2026-01-01T00:00:00Z")]));
    route_json("https://api.modrinth.com/v2/project/geyser", json!({ "title": "Geyser" }));
    route_bytes("https://cdn.modrinth.com/data/Geyser-Spigot.jar", g);
    route_json("https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest", json!({ "downloads": { "spigot": { "name": "floodgate-spigot.jar", "sha256": sha256(&f) } } }));
    route_bytes("https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot", f);
    let mut installed = serde_json::Map::new();
    let r = blockyard_core::geyser::install(&cfg, &mut installed, 19133, &logger().0).await.unwrap();
    assert_eq!(r["files"], json!(["Geyser-Spigot.jar", "floodgate-spigot.jar"]));
    assert_eq!(blockyard_core::geyser::detect(&cfg)["floodgate"], "floodgate-spigot.jar");
    // Floodgate with a bad checksum is refused.
    route_bytes("https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot", b"evil".to_vec());
    assert!(blockyard_core::geyser::install(&cfg, &mut installed, 19133, &logger().0).await.unwrap_err().to_string().contains("checksum"));
    // Vanilla/Forge can't load Geyser.
    assert!(blockyard_core::geyser::install(&json!({ "dir": d.path(), "software": "forge" }), &mut installed, 1, &logger().0).await.is_err());
    let fd = tempfile::tempdir().unwrap();
    let fcfg = json!({ "dir": fd.path(), "software": "fabric", "kind": "mods", "mcVersion": "1.21.4" });
    let (gf, ff) = (b"geyser-fabric".to_vec(), b"floodgate-fabric".to_vec());
    route_json("https://api.modrinth.com/v2/project/geyser/version*", json!([modrinth_version("gf", "Geyser-Fabric.jar", &gf, json!([]), "release", "2026-01-01T00:00:00Z")]));
    route_json("https://api.modrinth.com/v2/project/floodgate/version*", json!([modrinth_version("ff", "floodgate-fabric.jar", &ff, json!([]), "release", "2026-01-01T00:00:00Z")]));
    route_json("https://api.modrinth.com/v2/project/floodgate", json!({ "title": "Floodgate" }));
    route_bytes("https://cdn.modrinth.com/data/Geyser-Fabric.jar", gf);
    route_bytes("https://cdn.modrinth.com/data/floodgate-fabric.jar", ff);
    let r = blockyard_core::geyser::install(&fcfg, &mut serde_json::Map::new(), 19132, &logger().0).await.unwrap();
    assert_eq!(r["files"], json!(["Geyser-Fabric.jar", "floodgate-fabric.jar"]));
}

fn make_mrpack(dir: &std::path::Path, files: &[(&str, &[u8], &str)]) -> std::path::PathBuf {
    let p = dir.join("pack.mrpack");
    let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    let entries: Vec<Value> = files.iter().map(|(path, bytes, server)| json!({ "path": path, "hashes": { "sha1": sha1(bytes), "sha512": sha512(bytes) }, "env": { "client": "required", "server": server }, "downloads": [format!("https://cdn.modrinth.com/pack/{}", path.rsplit('/').next().unwrap())], "fileSize": bytes.len() })).collect();
    z.start_file("modrinth.index.json", opts).unwrap();
    z.write_all(json!({ "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "Cozy Pack", "dependencies": { "minecraft": "1.21.1", "neoforge": "21.1.77" }, "files": entries }).to_string().as_bytes()).unwrap();
    z.start_file("overrides/config/cozy.toml", opts).unwrap(); z.write_all(b"client = true").unwrap();
    z.start_file("server-overrides/config/cozy.toml", opts).unwrap(); z.write_all(b"server = true").unwrap();
    z.start_file("overrides/../../escape.txt", opts).unwrap(); z.write_all(b"nope").unwrap();
    z.finish().unwrap();
    p
}

#[tokio::test]
async fn modpack_files_overrides_and_safety() {
    let _g = lock().await;
    mock_http().await;
    let t = tempfile::tempdir().unwrap();
    let (m1, m2, shader) = (b"mod one".to_vec(), b"mod two".to_vec(), b"shader".to_vec());
    let pack_file = make_mrpack(t.path(), &[("mods/one.jar", &m1, "required"), ("mods/two.jar", &m2, "optional"), ("shaderpacks/s.zip", &shader, "unsupported")]);
    let pack = mrpack::read(&pack_file).unwrap();
    assert_eq!((pack.name.as_str(), pack.software.as_str(), pack.loader.as_deref(), pack.mc_version.as_str()), ("Cozy Pack", "neoforge", Some("21.1.77"), "1.21.1"));
    assert_eq!((pack.files.len(), pack.skipped_client_only), (2, 1));
    route_bytes("https://cdn.modrinth.com/pack/one.jar", m1);
    route_bytes("https://cdn.modrinth.com/pack/two.jar", m2);
    let server = t.path().join("srv");
    std::fs::create_dir_all(&server).unwrap();
    mrpack::install(&pack, &pack_file, &server, &logger().0).await.unwrap();
    assert_eq!(std::fs::read(server.join("mods/one.jar")).unwrap(), b"mod one");
    assert!(!server.join("shaderpacks").exists(), "client-only files skipped");
    assert_eq!(std::fs::read_to_string(server.join("config/cozy.toml")).unwrap(), "server = true", "server-overrides win");
    assert!(!t.path().join("escape.txt").exists());
    // A file whose download doesn't match its hash stops the install.
    route_bytes("https://cdn.modrinth.com/pack/two.jar", b"changed".to_vec());
    let server2 = t.path().join("srv2");
    std::fs::create_dir_all(&server2).unwrap();
    assert!(mrpack::install(&pack, &pack_file, &server2, &logger().0).await.unwrap_err().to_string().contains("checksum"));
}

#[tokio::test]
async fn updates_and_player_lookup() {
    let _g = lock().await;
    mock_http().await;
    route_json(updates::API_LATEST, json!({ "tag_name": "v2.1.0", "html_url": "https://github.com/Ek2100/blockyard/releases/tag/v2.1.0", "body": "notes", "assets": [{ "name": "Blockyard_2.1.0_x64-setup.exe", "browser_download_url": "https://x/win" }] }));
    let r = updates::check("2.0.0").await.unwrap();
    assert_eq!((r["available"].as_bool(), r["latest"].as_str()), (Some(true), Some("2.1.0")));
    assert!(!updates::check("2.1.0").await.unwrap()["available"].as_bool().unwrap());
    route_json(updates::API_LATEST, json!({ "tag_name": "v9.0.0", "prerelease": true }));
    assert!(!updates::check("2.0.0").await.unwrap()["available"].as_bool().unwrap());
    route_status(updates::API_LATEST, 404);
    assert_eq!(updates::check("2.0.0").await.unwrap()["latest"], Value::Null);
    route_status(updates::API_LATEST, 500);
    assert!(updates::check("2.0.0").await.is_err());

    route_json("https://api.mojang.com/users/profiles/minecraft/jeb_", json!({ "id": "853c80ef3c3749fdaa49938b674adae6", "name": "jeb_" }));
    assert_eq!(worlds::lookup_player("jeb_").await.unwrap(), json!({ "uuid": "853c80ef-3c37-49fd-aa49-938b674adae6", "name": "jeb_" }));
    route_status("https://api.mojang.com/users/profiles/minecraft/nobodyhere", 404);
    assert!(worlds::lookup_player("nobodyhere").await.unwrap_err().to_string().contains("No Minecraft account"));
    assert!(worlds::lookup_player("bad name!").await.is_err());
}
