//! Router port forwarding against a fake home router (NAT-PMP + UPnP), diagnostics and reachability.
mod common;
use blockyard_core::portmap::{Mapper, MapperOpts};
use common::*;
use serde_json::json;

#[tokio::test]
async fn nat_pmp_map_info_unmap() {
    let r = start_router("203.0.113.7", true, true, false, &[]).await;
    let m = Mapper::new(r.opts());
    let info = m.map(25570, "Blockyard Test", false).await.unwrap();
    assert_eq!(info["via"], "NAT-PMP");
    assert_eq!(info["externalIP"], "203.0.113.7");
    assert_eq!(info["lifetime"], 3600);
    assert_eq!(r.state.lock().unwrap().pmp_maps.get(&(25570, 2)), Some(&(25570, 3600)));
    assert!(m.info(25570, false).is_some());
    m.unmap(25570, false).await;
    assert!(r.state.lock().unwrap().pmp_maps.is_empty());
    assert!(m.info(25570, false).is_none());
}

#[tokio::test]
async fn falls_back_to_upnp_and_permanent_only_routers() {
    let r = start_router("203.0.113.7", false, true, false, &[]).await;
    let m = Mapper::new(r.opts());
    let info = m.map(25571, "Blockyard", false).await.unwrap();
    assert_eq!((info["via"].as_str(), info["externalIP"].as_str(), info["lifetime"].as_u64()), (Some("UPnP"), Some("203.0.113.7"), Some(3600)));
    assert_eq!(r.state.lock().unwrap().upnp_maps.get(&(25571, "TCP".into())).map(|m| m.0.clone()), Some("192.168.1.50".into()));
    m.unmap(25571, false).await;
    assert!(r.state.lock().unwrap().upnp_maps.is_empty());

    let r = start_router("203.0.113.7", false, true, true, &[]).await;
    let m = Mapper::new(r.opts());
    let info = m.map(25572, "Blockyard", false).await.unwrap();
    assert_eq!(info["lifetime"], 0, "permanent mapping when the router refuses leases");
    assert_eq!(r.state.lock().unwrap().upnp_maps.get(&(25572, "TCP".into())).map(|m| m.1), Some(0));
}

#[tokio::test]
async fn upnp_conflicts() {
    let r = start_router("203.0.113.7", false, true, false, &[(25580, "192.168.1.50"), (25581, "192.168.1.99")]).await;
    let m = Mapper::new(r.opts());
    // A leftover rule pointing at us is replaced.
    assert_eq!(m.map(25580, "x", false).await.unwrap()["via"], "UPnP");
    assert_eq!(r.state.lock().unwrap().upnp_maps.get(&(25580, "TCP".into())).map(|m| m.0.clone()), Some("192.168.1.50".into()));
    // Another device's rule is reported, not stolen.
    let e = m.map(25581, "x", false).await.unwrap_err().to_string();
    assert!(e.contains("already forwarded to another device (192.168.1.99)"), "{e}");
}

#[tokio::test]
async fn router_with_nothing_enabled_gives_helpful_error() {
    let r = start_router("203.0.113.7", false, false, false, &[]).await;
    let m = Mapper::new(r.opts());
    let e = m.map(25590, "x", false).await.unwrap_err().to_string();
    assert!(e.contains("Turn on UPnP"), "{e}");
    assert!(e.contains("NAT-PMP: not authorized") && e.contains("UPnP: the router refused"), "{e}");
    // No router at all (nothing listening).
    let m = Mapper::new(MapperOpts::from_json(&json!({ "gateway": "127.0.0.1", "lanIp": "192.168.1.50", "pmpPort": 9, "locations": [], "firstTimeout": 30 })));
    assert!(m.map(25591, "x", false).await.unwrap_err().to_string().contains("no UPnP router answered"));
}

#[tokio::test]
async fn udp_for_bedrock_alongside_tcp() {
    let r = start_router("203.0.113.7", true, true, false, &[]).await;
    let m = Mapper::new(r.opts());
    m.map(25565, "java", false).await.unwrap();
    m.map(19132, "bedrock", true).await.unwrap();
    {
        let s = r.state.lock().unwrap();
        assert!(s.pmp_maps.contains_key(&(25565, 2)) && s.pmp_maps.contains_key(&(19132, 1)));
    }
    m.unmap_all().await;
    assert!(r.state.lock().unwrap().pmp_maps.is_empty());
    let r2 = start_router("203.0.113.7", false, true, false, &[]).await;
    let m2 = Mapper::new(r2.opts());
    m2.map(19133, "bedrock", true).await.unwrap();
    assert!(r2.state.lock().unwrap().upnp_maps.contains_key(&(19133, "UDP".into())));
}

#[tokio::test]
async fn diagnose_detects_cgnat_double_nat_and_ok() {
    let _g = lock().await;
    mock_http().await;
    route_json("https://api.ipify.org?format=json", json!({ "ip": "198.51.100.20" }));
    for (router_ip, pmp, want) in [("100.70.3.4", true, "cgnat"), ("192.168.0.2", false, "double"), ("198.51.100.20", true, "ok"), ("198.51.100.99", true, "cgnat")] {
        let r = start_router(router_ip, pmp, true, false, &[]).await;
        let d = Mapper::new(r.opts()).diagnose().await;
        assert_eq!(d["nat"], want, "{router_ip}: {d}");
        assert_eq!(d["publicIP"], "198.51.100.20");
        assert_eq!(d["routerIP"], router_ip);
        assert_eq!(d["natpmp"], pmp);
        assert_eq!(d["upnp"], true);
    }
}

#[tokio::test]
async fn reachability_falls_back_to_mcstatus() {
    let _g = lock().await;
    mock_http().await;
    route_json("https://api.mcsrvstat.us/3/198.51.100.20%3A25570", json!({ "online": true, "players": { "online": 1, "max": 20 }, "version": "1.21.4" }));
    let r = blockyard_core::portmap::test_reachable("198.51.100.20", 25570).await.unwrap();
    assert_eq!((r["online"].as_bool(), r["via"].as_str(), r["target"].as_str()), (Some(true), Some("mcsrvstat.us"), Some("198.51.100.20:25570")));
    route_status("https://api.mcsrvstat.us/3/198.51.100.21", 500);
    route_json("https://api.mcstatus.io/v2/status/java/198.51.100.21", json!({ "online": false, "version": null }));
    let r = blockyard_core::portmap::test_reachable("198.51.100.21", 25565).await.unwrap();
    assert_eq!((r["online"].as_bool(), r["via"].as_str()), (Some(false), Some("mcstatus.io")));
}
