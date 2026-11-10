//! Worlds: read singleplayer saves, copy them into servers (with the owner's inventory and position),
//! copy server worlds back to singleplayer, and list server worlds. Originals are never modified.
use crate::nbt::{self, Tag};
use crate::{files, net, props, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const GAMEMODES: [&str; 4] = ["survival", "creative", "adventure", "spectator"];
const DIFFICULTIES: [&str; 4] = ["peaceful", "easy", "normal", "hard"];

/// The interesting bits of a world's level.dat.
pub fn read_level(world: &Path) -> Result<Value> {
    let (_, root) = nbt::read_file(&world.join("level.dat"))?;
    let d = |k: &[&str]| { let mut p = vec!["Data"]; p.extend_from_slice(k); root.path(&p).cloned() };
    let brands: Vec<String> = match d(&["ServerBrands"]) { Some(Tag::List(_, v)) => v.iter().filter_map(|t| t.as_str().map(String::from)).collect(), _ => vec![] };
    let game_mode = d(&["GameType"]).and_then(|t| t.as_i64()).map(|n| GAMEMODES.get(n as usize).copied().unwrap_or("survival"));
    let difficulty = match d(&["Difficulty"]).or_else(|| d(&["difficulty_settings", "difficulty"])) {
        Some(Tag::String(s)) => Some(s),
        Some(t) => t.as_i64().map(|n| DIFFICULTIES.get(n as usize).copied().unwrap_or("normal").to_string()),
        None => None,
    };
    let truthy = |k: &str| d(&[k]).and_then(|t| t.as_i64()).unwrap_or(0) != 0;
    Ok(json!({
        "name": d(&["LevelName"]).and_then(|t| t.as_str().map(String::from)).unwrap_or_else(|| world.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        "version": d(&["Version", "Name"]).and_then(|t| t.as_str().map(String::from)),
        "dataVersion": d(&["DataVersion"]).or_else(|| d(&["Version", "Id"])).and_then(|t| t.as_i64()),
        "lastPlayed": d(&["LastPlayed"]).and_then(|t| t.as_i64()),
        "gameMode": game_mode, "difficulty": difficulty,
        "hardcore": truthy("hardcore"), "cheats": truthy("allowCommands"),
        "brands": brands.clone(),
        "modded": truthy("WasModded") || brands.iter().any(|b| !b.eq_ignore_ascii_case("vanilla")),
        "hasPlayer": d(&["Player"]).is_some(),
    }))
}

/// Singleplayer worlds in a saves folder, newest first.
pub fn list_saves(saves: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    let Ok(rd) = std::fs::read_dir(saves) else { return out };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() || !dir.join("level.dat").exists() { continue; }
        let folder = e.file_name().to_string_lossy().into_owned();
        let icon = dir.join("icon.png");
        let mut v = match read_level(&dir) {
            Ok(v) => v,
            Err(err) => json!({ "name": folder, "error": format!("Couldn't read level.dat ({err})") }),
        };
        v["dir"] = json!(dir.to_string_lossy());
        v["folder"] = json!(folder);
        v["icon"] = if icon.exists() { json!(icon.to_string_lossy()) } else { Value::Null };
        out.push(v);
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["lastPlayed"].as_i64().unwrap_or(0)));
    out
}

/// Minecraft accounts signed in to the official launcher on this computer.
pub fn launcher_accounts(mc_dir: &Path) -> Vec<Value> {
    let mut found: Vec<Value> = vec![];
    for f in ["launcher_accounts_microsoft_store.json", "launcher_accounts.json"] {
        let Some(j) = std::fs::read_to_string(mc_dir.join(f)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        for a in j["accounts"].as_object().map(|o| o.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
            let p = &a["minecraftProfile"];
            if let (Some(id), Some(name)) = (p["id"].as_str(), p["name"].as_str()) {
                let uuid = nbt::dash_uuid(id);
                if !found.iter().any(|x| x["uuid"] == uuid.as_str()) { found.push(json!({ "uuid": uuid, "name": name })); }
            }
        }
    }
    found
}

pub fn valid_username(n: &str) -> bool { (3..=16).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') }

/// Look up a Java username's UUID with Mojang.
pub async fn lookup_player(name: &str) -> Result<Value> {
    let clean = name.trim();
    if !valid_username(clean) { crate::bail!("That isn’t a valid Minecraft username (3–16 letters, numbers or _)."); }
    let r: Value = match net::get_json(&format!("https://api.mojang.com/users/profiles/minecraft/{clean}")).await {
        Ok(v) => v,
        Err(e) if e.to_string().contains("HTTP 204") || e.to_string().contains("HTTP 404") || e.to_string().contains("unexpected") => crate::bail!("No Minecraft account is called \"{clean}\"."),
        Err(e) => return Err(e),
    };
    match r["id"].as_str() {
        Some(id) => Ok(json!({ "uuid": nbt::dash_uuid(id), "name": r["name"].as_str().unwrap_or(clean) })),
        None => crate::bail!("No Minecraft account is called \"{clean}\"."),
    }
}

fn skip_lock(p: &Path) -> bool { p.file_name().is_some_and(|n| n == "session.lock") }

pub fn add_op(server: &Path, uuid: &str, name: &str) -> Result<()> {
    let mut ops = files::read_json_list(server, "ops.json");
    if !ops.iter().any(|o| o["uuid"] == uuid) { ops.push(json!({ "uuid": uuid, "name": name, "level": 4, "bypassesPlayerLimit": false })); }
    std::fs::write(server.join("ops.json"), serde_json::to_string_pretty(&ops)?)?;
    Ok(())
}

/// Copy a singleplayer world into a server folder as `target`. The owner's singleplayer data (stored in
/// level.dat) becomes playerdata/<uuid>.dat so they keep their inventory and position.
pub fn copy_save_to_server(world: &Path, server: &Path, target: &str, player: Option<(&str, &str)>, make_op: bool) -> Result<Value> {
    if target.is_empty() || !target.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-')) || target.starts_with('.') {
        crate::bail!("World folder names can only use letters, numbers, spaces, dots, dashes and underscores.");
    }
    let info = read_level(world)?;
    let dest = server.join(target);
    if dest.exists() { crate::bail!("This server already has a world called \"{target}\". Pick another name."); }
    std::fs::create_dir_all(server)?;
    files::copy_recursive(world, &dest, &skip_lock)?;
    let mut done = json!({ "info": info, "dest": target, "playerMoved": false, "opped": false });
    if let Some((uuid, name)) = player {
        let (_, root) = nbt::read_file(&dest.join("level.dat"))?;
        let target_file = dest.join("playerdata").join(format!("{uuid}.dat"));
        if let Some(p) = root.path(&["Data", "Player"]) {
            if !target_file.exists() {
                std::fs::create_dir_all(target_file.parent().unwrap())?;
                std::fs::write(&target_file, nbt::write("", p)?)?;
                done["playerMoved"] = json!(true);
            }
        }
        if make_op { add_op(server, uuid, name)?; done["opped"] = json!(true); }
    }
    Ok(done)
}

/// server.properties values that make the server play like the singleplayer world did.
pub fn props_for_world(info: &Value, level: &str) -> Vec<(String, String)> {
    let mut p = vec![("level-name".to_string(), level.to_string())];
    if let Some(gm) = info["gameMode"].as_str() { p.push(("gamemode".into(), if gm == "spectator" { "survival".into() } else { gm.into() })); }
    if let Some(d) = info["difficulty"].as_str() { p.push(("difficulty".into(), d.into())); }
    p.push(("hardcore".into(), info["hardcore"].as_bool().unwrap_or(false).to_string()));
    p
}

/// Worlds inside a server folder. Paper keeps the Nether/End in "<name>_nether" / "<name>_the_end".
pub fn list_server_worlds(server: &Path) -> Value {
    let active = props::level_name(server);
    let names: Vec<String> = std::fs::read_dir(server).map(|rd| rd.flatten().filter(|e| e.path().join("level.dat").exists()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let is_dim = |n: &str| ["_nether", "_the_end"].iter().any(|s| n.strip_suffix(s).is_some_and(|b| names.iter().any(|x| x == b)));
    let mut mains: Vec<&String> = names.iter().filter(|n| !is_dim(n)).collect();
    mains.sort();
    let mut worlds: Vec<Value> = mains.iter().map(|n| {
        let mut info = read_level(&server.join(n)).unwrap_or_else(|e| json!({ "error": e.to_string() }));
        let dims: Vec<String> = ["_nether", "_the_end"].iter().map(|s| format!("{n}{s}")).filter(|d| names.contains(d)).collect();
        info["folder"] = json!(n); info["active"] = json!(**n == active); info["dims"] = json!(dims);
        info
    }).collect();
    if !worlds.iter().any(|w| w["active"] == true) { worlds.insert(0, json!({ "folder": active, "active": true, "dims": [], "missing": true })); }
    json!({ "active": active, "worlds": worlds })
}

/// Copy a server world back into the singleplayer saves folder (merging Paper's split dimensions).
pub fn copy_server_world_to_saves(server: &Path, folder: &str, saves: &Path, new_name: Option<&str>, player_uuid: Option<&str>) -> Result<Value> {
    let src = files::safe(server, folder)?;
    if !src.join("level.dat").exists() { crate::bail!("\"{folder}\" isn't a world."); }
    std::fs::create_dir_all(saves)?;
    let base: String = new_name.map(String::from).unwrap_or_else(|| format!("{folder} (from server)")).replace(['/', '\\', ':'], "-").trim().to_string();
    let mut dest_name = base.clone();
    let mut n = 2;
    while saves.join(&dest_name).exists() { dest_name = format!("{base} ({n})"); n += 1; }
    let dest = saves.join(&dest_name);
    files::copy_recursive(&src, &dest, &skip_lock)?;
    for (sfx, dim) in [("_nether", "DIM-1"), ("_the_end", "DIM1")] {
        let d = server.join(format!("{folder}{sfx}")).join(dim);
        if d.exists() && !dest.join(dim).exists() { files::copy_recursive(&d, &dest.join(dim), &skip_lock)?; }
    }
    for f in ["uid.dat", "paper-world.yml"] { let _ = std::fs::remove_file(dest.join(f)); }
    let level = dest.join("level.dat");
    let (name, mut root) = nbt::read_file(&level)?;
    if let Some(data) = root.get_mut("Data") {
        data.set("LevelName", Tag::String(dest_name.clone()));
        if let Some(uuid) = player_uuid {
            let pf = src.join("playerdata").join(format!("{uuid}.dat"));
            if let Ok((_, p)) = nbt::read_file(&pf) { data.set("Player", p); }
        }
    }
    std::fs::write(&level, nbt::write(&name, &root)?)?;
    Ok(json!({ "dest": dest.to_string_lossy(), "name": dest_name }))
}

pub fn world_dir_size(server: &Path, folders: &[String]) -> u64 { folders.iter().map(|f| files::dir_size(&server.join(f))).sum() }

pub fn saves_or_world(dir: &Path) -> (PathBuf, Option<PathBuf>) {
    // A world folder itself (has level.dat) or a saves folder full of worlds.
    if dir.join("level.dat").exists() { (dir.parent().map(Path::to_path_buf).unwrap_or_default(), Some(dir.to_path_buf())) } else { (dir.to_path_buf(), None) }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    /// A small singleplayer world like the game writes.
    pub fn make_world(dir: &Path, name: &str, with_player: bool) {
        std::fs::create_dir_all(dir.join("region")).unwrap();
        let mut data = vec![
            ("LevelName".to_string(), Tag::String(name.into())), ("GameType".into(), Tag::Int(1)), ("Difficulty".into(), Tag::Byte(3)),
            ("hardcore".into(), Tag::Byte(0)), ("LastPlayed".into(), Tag::Long(1_700_000_000_000)), ("DataVersion".into(), Tag::Int(4189)),
            ("Version".into(), Tag::Compound(vec![("Name".into(), Tag::String("1.21.4".into())), ("Id".into(), Tag::Int(4189))])),
            ("ServerBrands".into(), Tag::List(8, vec![Tag::String("vanilla".into())])),
        ];
        if with_player { data.push(("Player".into(), Tag::Compound(vec![("Health".into(), Tag::Float(17.0)), ("Pos".into(), Tag::List(6, vec![Tag::Double(1.5), Tag::Double(70.0), Tag::Double(-3.5)]))]))); }
        let root = Tag::Compound(vec![("Data".into(), Tag::Compound(data))]);
        std::fs::write(dir.join("level.dat"), nbt::write("", &root).unwrap()).unwrap();
        std::fs::write(dir.join("session.lock"), b"x").unwrap();
        std::fs::write(dir.join("region/r.0.0.mca"), b"chunks").unwrap();
    }

    #[test]
    fn saves_import_and_export() {
        let t = tempfile::tempdir().unwrap();
        let saves = t.path().join("saves");
        make_world(&saves.join("Island"), "Survival Island", true);
        std::fs::create_dir_all(saves.join("junk")).unwrap();
        let l = list_saves(&saves);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["name"], "Survival Island");
        assert_eq!(l[0]["gameMode"], "creative");
        assert_eq!(l[0]["difficulty"], "hard");
        assert_eq!(l[0]["version"], "1.21.4");
        assert_eq!(l[0]["modded"], false);

        let server = t.path().join("srv");
        let uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
        let done = copy_save_to_server(&saves.join("Island"), &server, "world", Some((uuid, "Notch")), true).unwrap();
        assert_eq!(done["playerMoved"], true);
        assert!(!server.join("world/session.lock").exists());
        let (_, p) = nbt::read_file(&server.join(format!("world/playerdata/{uuid}.dat"))).unwrap();
        assert_eq!(p.get("Health"), Some(&Tag::Float(17.0)));
        assert_eq!(files::player_lists(&server)["ops"][0], "Notch");
        assert!(copy_save_to_server(&saves.join("Island"), &server, "world", None, false).is_err());
        assert!(copy_save_to_server(&saves.join("Island"), &server, "../x", None, false).is_err());
        let pr = props_for_world(&done["info"], "world");
        assert!(pr.contains(&("gamemode".into(), "creative".into())) && pr.contains(&("difficulty".into(), "hard".into())));

        // Paper splits dimensions; copying back merges them and renames the world.
        std::fs::create_dir_all(server.join("world_nether/DIM-1/region")).unwrap();
        std::fs::write(server.join("world_nether/level.dat"), std::fs::read(server.join("world/level.dat")).unwrap()).unwrap();
        std::fs::write(server.join("world_nether/DIM-1/region/r.0.0.mca"), b"nether").unwrap();
        let w = list_server_worlds(&server);
        assert_eq!(w["worlds"].as_array().unwrap().len(), 1);
        assert_eq!(w["worlds"][0]["dims"][0], "world_nether");
        let back = copy_server_world_to_saves(&server, "world", &saves, None, Some(uuid)).unwrap();
        assert_eq!(back["name"], "world (from server)");
        assert!(saves.join("world (from server)/DIM-1/region/r.0.0.mca").exists());
        assert_eq!(read_level(&saves.join("world (from server)")).unwrap()["name"], "world (from server)");
        assert_eq!(copy_server_world_to_saves(&server, "world", &saves, None, None).unwrap()["name"], "world (from server) (2)");
    }

    #[test]
    fn launcher_accounts_file() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("launcher_accounts.json"), r#"{"accounts":{"a":{"minecraftProfile":{"id":"069a79f444e94726a5befca90e38aaf5","name":"Notch"}}}}"#).unwrap();
        assert_eq!(launcher_accounts(t.path()), vec![json!({ "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "name": "Notch" })]);
        assert!(valid_username("jeb_") && !valid_username("a b") && !valid_username("ab"));
    }
}
