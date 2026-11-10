//! Talks to the real services Blockyard depends on, to catch API changes early.
//! Skipped by default; CI runs them with `cargo test -p blockyard-core --test live -- --ignored`.
use blockyard_core::{modrinth, net, providers};
use serde_json::{json, Value};

#[tokio::test]
#[ignore]
async fn server_software_version_lists() {
    for id in ["paper", "purpur", "vanilla", "fabric", "forge", "neoforge"] {
        let v = providers::versions(id).await.unwrap_or_else(|e| panic!("{id}: {e}"));
        assert!(v.len() > 5, "{id} returned {} versions", v.len());
        println!("{id}: newest {}", v[0]);
    }
    assert!(providers::java_major_for("1.21.4").await >= 21);
}

#[tokio::test]
#[ignore]
async fn downloads_resolve() {
    // Paper's newest stable build has a download URL; Adoptium has a JRE for this OS; playit and Geyser answer.
    let mc = providers::versions("paper").await.unwrap()[0].clone();
    let builds: Value = net::get_json(&format!("https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds")).await.unwrap();
    assert!(builds[0]["downloads"]["server:default"]["url"].is_string(), "{builds}");
    let os = if cfg!(target_os = "macos") { "mac" } else if cfg!(windows) { "windows" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    let r = net::client().head(blockyard_core::java::adoptium_url(21, os, arch)).send().await.unwrap();
    assert!(r.status().is_success() || r.status().is_redirection(), "adoptium {}", r.status());
    if let Some((url, _)) = blockyard_core::playit::download_for_os() {
        let r = net::client().head(url).send().await.unwrap();
        assert!(r.status().is_success(), "playit download {}", r.status());
    }
    let g: Value = net::get_json(&format!("{}/floodgate/versions/latest/builds/latest", blockyard_core::geyser::GEYSER_API)).await.unwrap();
    assert!(g["downloads"]["spigot"]["sha256"].is_string());
}

#[tokio::test]
#[ignore]
async fn modrinth_search_and_versions() {
    let cfg = json!({ "software": "paper", "kind": "plugins", "mcVersion": "1.21.4", "dir": "." });
    let r = modrinth::search(&cfg, &json!({ "query": "luckperms" })).await.unwrap();
    assert!(r["total"].as_u64().unwrap() > 0);
    let v = modrinth::best_version(&cfg, "geyser").await.unwrap();
    assert!(v.is_some());
    let packs = modrinth::search_raw("", &json!([["project_type:modpack"]]), "downloads", 0, 5).await.unwrap();
    assert!(packs["hits"].as_array().unwrap().len() == 5);
}

#[tokio::test]
#[ignore]
async fn mojang_profile_lookup() {
    let p = blockyard_core::worlds::lookup_player("jeb_").await.unwrap();
    assert_eq!(p["uuid"], "853c80ef-3c37-49fd-aa49-938b674adae6");
}
