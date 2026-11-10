//! Blockyard's desktop app: a window showing the web UI (ui/), wired to the engine (blockyard-core),
//! plus native dialogs, notifications, the tray / menu bar icon and the app menu.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use blockyard_core::{Ask, Core, CoreOpts, Host};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const IS_MAC: bool = cfg!(target_os = "macos");

// ---------- the host: what the engine asks of the app ----------
struct AppHost {
    app: OnceLock<AppHandle>,
    tray_gen: AtomicU64,
}

impl AppHost {
    fn app(&self) -> Option<&AppHandle> { self.app.get() }
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> { app.get_webview_window("main") }

fn ask_blocking(app: &AppHandle, a: &Ask) -> usize {
    let b = &a.buttons;
    let buttons = match b.len() {
        0 | 1 => MessageDialogButtons::OkCustom(b.first().cloned().unwrap_or_else(|| "OK".into())),
        2 => MessageDialogButtons::OkCancelCustom(b[0].clone(), b[1].clone()),
        _ => MessageDialogButtons::YesNoCancelCustom(b[0].clone(), b[1].clone(), b[2].clone()),
    };
    let kind = match a.kind { "warning" => MessageDialogKind::Warning, "error" => MessageDialogKind::Error, _ => MessageDialogKind::Info };
    let mut d = app.dialog().message(a.detail.clone()).title(a.message.clone()).kind(kind).buttons(buttons);
    if let Some(w) = main_window(app) { if w.is_visible().unwrap_or(false) { d = d.parent(&w); } }
    let r = d.blocking_show_with_result();
    let idx = |label: &str| b.iter().position(|x| x == label);
    match r {
        MessageDialogResult::Custom(label) => idx(&label).unwrap_or(b.len().saturating_sub(1)),
        MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
        MessageDialogResult::No => 1,
        MessageDialogResult::Cancel => b.len().saturating_sub(1),
    }
}

impl Host for AppHost {
    fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app() { let _ = app.emit(event, payload); }
    }
    fn notify(&self, title: &str, body: &str, always: bool) {
        let Some(app) = self.app() else { return };
        if !always && main_window(app).is_some_and(|w| w.is_focused().unwrap_or(false)) { return; }
        let _ = app.notification().builder().title(title).body(body).show();
    }
    fn ask(&self, a: Ask) -> BoxFuture<'static, usize> {
        let app = self.app().cloned();
        Box::pin(async move {
            let Some(app) = app else { return a.buttons.len().saturating_sub(1) };
            tokio::task::spawn_blocking(move || ask_blocking(&app, &a)).await.unwrap_or(0)
        })
    }
    fn open_url(&self, url: &str) {
        if url.starts_with("https://") { if let Some(app) = self.app() { let _ = app.opener().open_url(url, None::<&str>); } }
    }
    fn tray_changed(&self) {
        // Coalesce bursts of changes into one rebuild.
        let n = self.tray_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(app) = self.app().cloned() else { return };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let st = app.state::<AppState>();
            if st.host.tray_gen.load(Ordering::SeqCst) == n { update_tray(&app); }
        });
    }
}

struct AppState {
    core: Arc<Core>,
    host: Arc<AppHost>,
    quitting: AtomicBool,
}

// ---------- the one command the UI calls ----------
fn core_of(app: &AppHandle) -> Arc<Core> { app.state::<AppState>().core.clone() }

fn s(v: &Value) -> String { v.as_str().unwrap_or_default().to_string() }

async fn path_from_core(app: &AppHandle, channel: &str, args: Vec<Value>) -> Result<PathBuf, String> {
    let v = core_of(app).call(channel, args).await.map_err(|e| e.to_string())?;
    Ok(PathBuf::from(s(&v)))
}

fn open_path(app: &AppHandle, p: &std::path::Path) -> Result<Value, String> {
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}
fn reveal(app: &AppHandle, p: &std::path::Path) -> Result<Value, String> {
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

#[tauri::command]
async fn call(app: AppHandle, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    match channel.as_str() {
        "dialog:pickFolder" => {
            let o = a(0);
            let mut d = app.dialog().file();
            if let Some(t) = o["title"].as_str() { d = d.set_title(t); }
            if let Some(p) = o["defaultPath"].as_str() { d = d.set_directory(p); }
            if let Some(w) = main_window(&app) { d = d.set_parent(&w); }
            let r = tokio::task::spawn_blocking(move || d.blocking_pick_folder()).await.map_err(|e| e.to_string())?;
            Ok(r.and_then(|p| p.into_path().ok()).map(|p| json!(p)).unwrap_or(Value::Null))
        }
        "dialog:pickFiles" => {
            let o = a(0);
            let mut d = app.dialog().file();
            if let Some(t) = o["title"].as_str() { d = d.set_title(t); }
            for f in o["filters"].as_array().cloned().unwrap_or_default() {
                let exts: Vec<String> = f["extensions"].as_array().cloned().unwrap_or_default().iter().map(s).collect();
                let refs: Vec<&str> = exts.iter().map(|x| x.as_str()).collect();
                d = d.add_filter(s(&f["name"]), &refs);
            }
            if let Some(w) = main_window(&app) { d = d.set_parent(&w); }
            let r = tokio::task::spawn_blocking(move || d.blocking_pick_files()).await.map_err(|e| e.to_string())?;
            Ok(json!(r.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect::<Vec<_>>()))
        }
        "dialog:confirm" => {
            let o = a(0);
            let mut buttons: Vec<String> = o["buttons"].as_array().cloned().unwrap_or_default().iter().map(s).collect();
            if buttons.is_empty() { buttons = vec!["OK".into(), "Cancel".into()]; }
            let ask = Ask { kind: if o["danger"] == true { "warning" } else { "question" }, message: s(&o["message"]), detail: s(&o["detail"]), buttons };
            let app2 = app.clone();
            Ok(json!(tokio::task::spawn_blocking(move || ask_blocking(&app2, &ask)).await.map_err(|e| e.to_string())?))
        }
        "shell:external" => {
            let u = s(&a(0));
            if u.starts_with("https://") { app.opener().open_url(u, None::<&str>).map_err(|e| e.to_string())?; }
            Ok(Value::Null)
        }
        "clipboard:write" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard().write_text(s(&a(0))).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "files:reveal" => {
            let rel = s(&a(1));
            let p = path_from_core(&app, "files:path", vec![a(0), json!(rel)]).await?;
            if rel.is_empty() { open_path(&app, &p) } else { reveal(&app, &p) }
        }
        "files:open" => { let p = path_from_core(&app, "files:path", vec![a(0), a(1)]).await?; open_path(&app, &p) }
        "addons:openFolder" => { let p = path_from_core(&app, "addons:path", vec![a(0)]).await?; open_path(&app, &p) }
        "backups:reveal" => {
            let file = s(&a(1));
            let p = path_from_core(&app, "backups:path", vec![a(0), json!(file)]).await?;
            if file.is_empty() { open_path(&app, &p) } else { reveal(&app, &p) }
        }
        "worlds:openSaves" => { let p = path_from_core(&app, "worlds:savesPath", vec![]).await?; open_path(&app, &p) }
        "app:openLogs" => { let p = path_from_core(&app, "app:logDir", vec![]).await?; open_path(&app, &p) }
        "app:openRelease" => {
            let u = s(&a(0));
            let url = if u.starts_with(blockyard_core::updates::REPO_URL) { u } else { blockyard_core::updates::RELEASES_URL.to_string() };
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "app:reportIssue" => {
            let u = core_of(&app).call("app:issueUrl", vec![]).await.map_err(|e| e.to_string())?;
            app.opener().open_url(s(&u), None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "icon:set" => {
            let mut d = app.dialog().file().set_title("Choose a server icon").add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"]);
            if let Some(w) = main_window(&app) { d = d.set_parent(&w); }
            let r = tokio::task::spawn_blocking(move || d.blocking_pick_file()).await.map_err(|e| e.to_string())?;
            let Some(p) = r.and_then(|p| p.into_path().ok()) else { return Ok(Value::Null) };
            core_of(&app).call("icon:setFrom", vec![a(0), json!(p)]).await.map_err(|e| e.to_string())
        }
        "tray:set" => {
            let on = a(0) == true;
            core_of(&app).store.set_settings(json!({ "menuBar": on })).map_err(|e| e.to_string())?;
            if on { create_tray(&app); } else { let _ = app.remove_tray_by_id("main"); }
            Ok(json!(on))
        }
        "app:autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let m = app.autolaunch();
            match a(0).as_bool() {
                Some(true) => m.enable().map_err(|e| e.to_string())?,
                Some(false) => m.disable().map_err(|e| e.to_string())?,
                None => {}
            }
            Ok(json!(m.is_enabled().unwrap_or(false)))
        }
        _ => core_of(&app).call(&channel, args).await.map_err(|e| e.to_string()),
    }
}

// ---------- window ----------
fn show_window(app: &AppHandle, select: Option<String>) {
    let w = match main_window(app) { Some(w) => w, None => match create_window(app) { Ok(w) => w, Err(_) => return } };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if let Some(id) = select { let _ = app.emit("app:select", json!(id)); }
}

fn create_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Blockyard")
        .inner_size(1200.0, 780.0)
        .min_inner_size(920.0, 580.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).transparent(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0));
    }
    let w = b.build()?;
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        let _ = apply_vibrancy(&w, NSVisualEffectMaterial::Sidebar, None, None);
    }
    let w2 = w.clone();
    tauri::async_runtime::spawn(async move {
        // Show once the page has had a moment to paint (avoids a white flash).
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let _ = w2.show();
        let _ = w2.set_focus();
    });
    Ok(w)
}

// ---------- quitting: stop servers cleanly first ----------
fn request_quit(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.quitting.load(Ordering::SeqCst) { return; }
    let core = st.core.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let running = core.running_count();
        if running > 0 {
            let names: Vec<String> = core.tray_items().iter().filter(|t| t["state"] != "stopped" && t["state"] != "sleeping").map(|t| s(&t["name"])).collect();
            let label = if running == 1 { names.first().cloned().unwrap_or_else(|| "1 server".into()) } else { format!("{running} servers") };
            let r = core.host.ask(Ask::new("warning", format!("Stop {label} and quit?"), "Running servers will be saved and stopped properly first. This can take a few seconds.", &["Stop & Quit", "Cancel"])).await;
            if r != 0 { return; }
        }
        app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
        if let Some(w) = main_window(&app) { let _ = w.hide(); }
        core.shutdown(std::time::Duration::from_secs(70)).await;
        app.exit(0);
    });
}

// ---------- menus ----------
fn menu_action(app: &AppHandle, action: &str) {
    show_window(app, None);
    let _ = app.emit("app:menu", json!(action));
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel { b = b.accelerator(a); }
        b.build(app)
    };
    let mut m = MenuBuilder::new(app);
    if IS_MAC {
        m = m.item(&SubmenuBuilder::new(app, "Blockyard")
            .item(&PredefinedMenuItem::about(app, Some("About Blockyard"), None)?)
            .item(&item("updates", "Check for Updates…", None)?)
            .separator()
            .item(&item("settings", "Settings…", Some("Cmd+,"))?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&item("quit", "Quit Blockyard", Some("Cmd+Q"))?)
            .build()?);
    }
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New Server…", Some("CmdOrCtrl+N"))?)
        .item(&item("new-world", "New Server from Singleplayer World…", Some("Shift+CmdOrCtrl+N"))?)
        .item(&item("new-modpack", "New Server from Modpack…", None)?)
        .item(&item("import", "Import Server Folder…", Some("CmdOrCtrl+O"))?)
        .separator();
    file = if IS_MAC { file.item(&PredefinedMenuItem::close_window(app, None)?) } else {
        file.item(&item("settings", "Settings…", Some("Ctrl+,"))?).separator().item(&item("quit", "Exit", Some("Alt+F4"))?)
    };
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?).item(&PredefinedMenuItem::redo(app, None)?).separator()
        .item(&PredefinedMenuItem::cut(app, None)?).item(&PredefinedMenuItem::copy(app, None)?).item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?);
    let mut server = SubmenuBuilder::new(app, "Server")
        .item(&item("start", "Start", Some("CmdOrCtrl+Enter"))?)
        .item(&item("stop", "Stop", Some("CmdOrCtrl+."))?)
        .item(&item("restart", "Restart", Some("Shift+CmdOrCtrl+R"))?)
        .item(&item("backup", "Back Up Now", Some("CmdOrCtrl+B"))?)
        .separator();
    for (i, (key, label)) in [("console", "Console"), ("players", "Players"), ("stats", "Stats"), ("files", "Files"), ("addons", "Plugins & Mods"), ("worlds", "Worlds"), ("access", "Public Access"), ("backups", "Backups"), ("settings", "Settings")].iter().enumerate() {
        server = server.item(&item(&format!("tab:{key}"), label, Some(&format!("CmdOrCtrl+{}", i + 1)))?);
    }
    let mut help = SubmenuBuilder::new(app, "Help");
    if !IS_MAC { help = help.item(&item("updates", "Check for Updates…", None)?).separator(); }
    help = help.item(&item("logs", "Show Blockyard Logs", None)?)
        .item(&item("report", "Report a Problem…", None)?)
        .item(&item("github", "Blockyard on GitHub", None)?)
        .separator()
        .item(&item("eula", "Minecraft EULA", None)?);
    let mut m = m.item(&file.build()?).item(&edit.build()?).item(&server.build()?);
    if IS_MAC {
        m = m.item(&SubmenuBuilder::new(app, "Window").item(&PredefinedMenuItem::minimize(app, None)?).item(&PredefinedMenuItem::maximize(app, None)?).item(&PredefinedMenuItem::fullscreen(app, None)?).build()?);
    }
    m.item(&help.build()?).build()
}

fn on_menu(app: &AppHandle, id: &str) {
    let core = core_of(app);
    match id {
        "quit" => request_quit(app),
        "updates" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let r = core.call("app:checkUpdate", vec![json!(true)]).await;
                let ask = match &r {
                    Ok(v) if v["available"] == true => Ask::new("info", format!("Blockyard {} is available", s(&v["latest"])), format!("You have {}. Download the new version, then install it over this one. Your servers aren’t touched.", s(&v["current"])), &["Download", "Later"]),
                    Ok(v) => Ask::new("info", "Blockyard is up to date", format!("You have version {}.", s(&v["current"])), &["OK"]),
                    Err(e) => Ask::new("warning", "Couldn’t check for updates", e.to_string(), &["OK"]),
                };
                let choice = core.host.ask(ask).await;
                if let Ok(v) = r { if v["available"] == true && choice == 0 { let _ = app.opener().open_url(s(&v["url"]), None::<&str>); } }
            });
        }
        "logs" => { let app = app.clone(); tauri::async_runtime::spawn(async move { if let Ok(p) = path_from_core(&app, "app:logDir", vec![]).await { let _ = open_path(&app, &p); } }); }
        "report" => { let app = app.clone(); tauri::async_runtime::spawn(async move { if let Ok(u) = core.call("app:issueUrl", vec![]).await { let _ = app.opener().open_url(s(&u), None::<&str>); } }); }
        "github" => { let _ = app.opener().open_url(blockyard_core::updates::REPO_URL, None::<&str>); }
        "eula" => { let _ = app.opener().open_url("https://aka.ms/MinecraftEULA", None::<&str>); }
        "tray:open" => show_window(app, None),
        other if other.starts_with("tray:") => {
            let mut parts = other.splitn(3, ':');
            let (_, action, sid) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or("").to_string());
            match action {
                "show" => show_window(app, Some(sid)),
                "start" => {
                    show_window(app, Some(sid.clone()));
                    tauri::async_runtime::spawn(async move { if let Err(e) = core.start_server(&sid, false).await { if let Ok(i) = core.instance(&sid) { i.info(&format!("Couldn't start: {e}")); } } });
                }
                "stop" => { tauri::async_runtime::spawn(async move { let _ = core.stop_server(&sid).await; }); }
                "restart" => { tauri::async_runtime::spawn(async move { let _ = core.restart(&sid).await; }); }
                _ => {}
            }
        }
        action => menu_action(app, action),
    }
}

// ---------- tray / menu bar icon ----------
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let core = core_of(app);
    let items = core.tray_items();
    let running = items.iter().filter(|t| matches!(t["state"].as_str(), Some("online" | "starting" | "stopping"))).count();
    let mut m = MenuBuilder::new(app)
        .item(&MenuItem::with_id(app, "tray:none", if running > 0 { format!("{running} server{} running", if running == 1 { "" } else { "s" }) } else { "No servers running".into() }, false, None::<&str>)?)
        .separator();
    if items.is_empty() { m = m.item(&MenuItem::with_id(app, "tray:empty", "No servers yet", false, None::<&str>)?); }
    for t in &items {
        let id = s(&t["id"]);
        let st = s(&t["state"]);
        let dot = match st.as_str() { "online" => "🟢", "starting" | "stopping" => "🟡", "sleeping" => "💤", _ => "⚪️" };
        let detail = match st.as_str() { "online" => format!(" · {} online", t["players"]), "starting" => " · starting…".into(), "stopping" => " · stopping…".into(), "sleeping" => " · asleep".into(), _ => String::new() };
        let sub = SubmenuBuilder::new(app, format!("{dot}  {}{detail}", s(&t["name"])))
            .item(&MenuItem::with_id(app, format!("tray:start:{id}"), if st == "sleeping" { "Wake Up" } else { "Start" }, st == "stopped" || st == "sleeping", None::<&str>)?)
            .item(&MenuItem::with_id(app, format!("tray:stop:{id}"), "Stop", matches!(st.as_str(), "online" | "starting" | "sleeping"), None::<&str>)?)
            .item(&MenuItem::with_id(app, format!("tray:restart:{id}"), "Restart", st == "online", None::<&str>)?)
            .separator()
            .item(&MenuItem::with_id(app, format!("tray:show:{id}"), "Open in Blockyard", true, None::<&str>)?)
            .build()?;
        m = m.item(&sub);
    }
    m.separator()
        .item(&MenuItem::with_id(app, "tray:open", "Open Blockyard", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "quit", if IS_MAC { "Quit Blockyard" } else { "Exit Blockyard" }, true, None::<&str>)?)
        .build()
}

fn create_tray(app: &AppHandle) {
    if app.tray_by_id("main").is_some() || core_of(app).store.settings()["menuBar"] == false { return; }
    let icon = if IS_MAC {
        app.path().resource_dir().ok().map(|d| d.join("trayTemplate@2x.png")).and_then(|p| tauri::image::Image::from_path(p).ok())
    } else { None }.or_else(|| app.default_window_icon().cloned());
    let Ok(menu) = tray_menu(app) else { return };
    let mut b = TrayIconBuilder::with_id("main").menu(&menu).tooltip("Blockyard").icon_as_template(IS_MAC).show_menu_on_left_click(IS_MAC);
    if let Some(i) = icon { b = b.icon(i); }
    let _ = b.on_tray_icon_event(|tray, ev| {
        // Windows/Linux: a left click opens the window; right click shows the menu.
        if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = ev {
            if !IS_MAC { show_window(tray.app_handle(), None); }
        }
    }).build(app);
}

fn update_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    if let Ok(m) = tray_menu(app) { let _ = tray.set_menu(Some(m)); }
    let running = core_of(app).running_count();
    let _ = tray.set_tooltip(Some(if running > 0 { format!("Blockyard: {running} running") } else { "Blockyard".into() }));
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(Some(if running > 0 { running.to_string() } else { String::new() }));
}

/// Blockyard 1 (Electron) kept its data in an "Blockyard" folder; bring the server list and stats over once.
fn migrate_from_v1(data_dir: &std::path::Path) {
    if data_dir.join("servers.json").exists() { return; }
    let Some(base) = dirs_next_data_dir() else { return };
    let old = base.join("Blockyard");
    if !old.join("servers.json").exists() || old == data_dir { return; }
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::copy(old.join("servers.json"), data_dir.join("servers.json"));
    if let Ok(rd) = std::fs::read_dir(old.join("stats")) {
        let _ = std::fs::create_dir_all(data_dir.join("stats"));
        for e in rd.flatten() { let _ = std::fs::copy(e.path(), data_dir.join("stats").join(e.file_name())); }
    }
}

/// ~/Library/Application Support, %APPDATA%, ~/.config (where Electron kept app data).
fn dirs_next_data_dir() -> Option<PathBuf> {
    let home = blockyard_core::paths::home();
    if cfg!(target_os = "macos") { Some(home.join("Library/Application Support")) }
    else if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) }
    else { Some(std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"))) }
}

fn main() {
    let host = Arc::new(AppHost { app: OnceLock::new(), tray_gen: AtomicU64::new(0) });
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app, None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![call])
        .setup({
            let host = host.clone();
            move |app| {
                let handle = app.handle().clone();
                let _ = host.app.set(handle.clone());
                let data_dir = app.path().app_data_dir().unwrap_or_else(|_| blockyard_core::paths::home().join(".blockyard"));
                migrate_from_v1(&data_dir);
                let core = Core::new(host.clone(), CoreOpts { data_dir, version: app.package_info().version.to_string(), mapper: None, playit: None });
                app.manage(AppState { core: core.clone(), host: host.clone(), quitting: AtomicBool::new(false) });
                core.start_background();
                let menu = build_menu(&handle)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, e| on_menu(app, e.id().as_ref()));
                create_window(&handle)?;
                create_tray(&handle);
                Ok(())
            }
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                let app = w.app_handle();
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) { return; }
                // macOS: closing the window keeps Blockyard (and servers) running. Elsewhere: quit (asking first).
                api.prevent_close();
                if IS_MAC { let _ = w.hide(); } else { request_quit(app); }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Blockyard");
    app.run(|app, e| match e {
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<AppState>().quitting.load(Ordering::SeqCst) { api.prevent_exit(); request_quit(app); }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app, None),
        _ => {}
    });
}
