//! Phase 0 spike: proves tray, single instance, close-to-tray (window destroyed),
//! a token-protected localhost API, SQLite in WAL mode and actionable Windows toasts.
//! Throwaway-quality code; findings go to docs/spike.md.

pub mod db;
pub mod error;
pub mod model;
pub mod repo;

use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_winrt_notification::Toast;

const API_PORT: u16 = 47821;

#[derive(Clone)]
struct Core {
    db: Arc<Mutex<Connection>>,
    token: Arc<String>,
    log_path: Arc<PathBuf>,
}

impl Core {
    fn log(&self, line: &str) {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&*self.log_path)
        {
            let _ = writeln!(f, "{} {}", now_secs(), line);
        }
    }

    fn event(&self, kind: &str, detail: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO spike_events(kind, detail, at) VALUES (?1, ?2, ?3)",
            (kind, detail, now_secs() as i64),
        );
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn open_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS spike_events(
            id INTEGER PRIMARY KEY, kind TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL)",
    )?;
    if !mode.eq_ignore_ascii_case("wal") {
        // Not fatal: SQLite still works in rollback-journal mode, just with less concurrency.
        eprintln!("warning: WAL mode not enabled (journal_mode={mode})");
    }
    Ok(conn)
}

// ---------- local API ----------

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

#[derive(Serialize)]
struct Status {
    events: i64,
    journal_mode: String,
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn status(State(core): State<Core>, headers: HeaderMap) -> Result<Json<Status>, StatusCode> {
    let expected = format!("Bearer {}", core.token);
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == expected);
    if !ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let db = core.db.lock().unwrap();
    let events: i64 = db
        .query_row("SELECT COUNT(*) FROM spike_events", [], |r| r.get(0))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let journal_mode: String = db
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(Status {
        events,
        journal_mode,
    }))
}

fn start_api(core: Core) {
    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/status", get(status))
            .with_state(core.clone());
        match tokio::net::TcpListener::bind(("127.0.0.1", API_PORT)).await {
            Ok(listener) => {
                core.log(&format!("api listening on 127.0.0.1:{API_PORT}"));
                if let Err(e) = axum::serve(listener, app).await {
                    core.log(&format!("api stopped: {e}"));
                }
            }
            Err(e) => core.log(&format!("api bind failed: {e}")),
        }
    });
}

// ---------- window + toast ----------

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Tether")
        .inner_size(1000.0, 700.0)
        .build();
}

fn app_user_model_id(app: &AppHandle) -> String {
    // Installed builds get the identifier as AUMID via the Start Menu shortcut (to be proven by the spike).
    // `tauri dev` has no shortcut, so fall back to PowerShell's id there.
    if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

fn send_test_toast(app: &AppHandle) {
    let core = app.state::<Core>().inner().clone();
    let aumid = app_user_model_id(app);
    core.log(&format!("toast: showing with AUMID {aumid}"));
    let on_click = core.clone();
    let on_dismiss = core.clone();
    let result = Toast::new(&aumid)
        .title("Tether spike")
        .text1("Test reminder: buttons should call back into the app")
        .add_button("Snooze 15m", "snooze_15m")
        .add_button("Done", "done")
        .on_activated(move |action| {
            let action = action.unwrap_or_else(|| "body".into());
            on_click.log(&format!("toast: activated action={action}"));
            on_click.event("toast_activated", &action);
            Ok(())
        })
        .on_dismissed(move |reason| {
            on_dismiss.log(&format!("toast: dismissed reason={reason:?}"));
            Ok(())
        })
        .show();
    if let Err(e) = result {
        core.log(&format!("toast: show failed: {e}"));
    }
}

// ---------- commands for the spike UI ----------

#[derive(Serialize)]
struct SpikeInfo {
    api: String,
    token: String,
    events: i64,
    log_path: String,
    aumid: String,
}

#[tauri::command]
fn spike_info(app: AppHandle, core: tauri::State<'_, Core>) -> Result<SpikeInfo, String> {
    let events: i64 = core
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM spike_events", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(SpikeInfo {
        api: format!("http://127.0.0.1:{API_PORT}"),
        token: core.token.to_string(),
        events,
        log_path: core.log_path.display().to_string(),
        aumid: app_user_model_id(&app),
    })
}

#[tauri::command]
fn spike_toast(app: AppHandle) {
    send_test_toast(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first (Tauri docs).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = open_db(&dir.join("spike.db"))?;
            let core = Core {
                db: Arc::new(Mutex::new(conn)),
                token: Arc::new(new_token()),
                log_path: Arc::new(dir.join("spike.log")),
            };
            core.log("app start");
            core.event("start", "");
            app.manage(core.clone());
            start_api(core);

            let open = MenuItem::with_id(app, "open", "Open Tether", true, None::<&str>)?;
            let toast = MenuItem::with_id(app, "toast", "Test notification", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &toast, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Tether")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "toast" => send_test_toast(app),
                    "quit" => {
                        app.state::<Core>().log("quit from tray");
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // The config window starts hidden (`visible: false`) so nothing flashes at login.
            // Started by Windows at login: stay in the tray and drop the webview; otherwise show it.
            if let Some(w) = app.get_webview_window("main") {
                if std::env::args().any(|a| a == "--autostart") {
                    let _ = w.destroy();
                } else {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![spike_info, spike_toast])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // Closing the last window destroys its webview (frees RAM) but keeps the app in the tray.
        // `code == None` means "last window closed"; Some(_) means an explicit app.exit().
        if let RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
            app.state::<Core>().log("window closed, staying in tray");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_db_enables_wal_and_creates_table() {
        let dir = std::env::temp_dir().join(format!("tether-spike-{}", new_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open_db(&dir.join("t.db")).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        conn.execute(
            "INSERT INTO spike_events(kind, detail, at) VALUES ('t', '', 0)",
            [],
        )
        .unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tokens_are_64_hex_chars_and_unique() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
