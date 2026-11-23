//! Tether desktop core: owns the SQLite database, serves the local API, hosts the tray.

pub mod ai;
pub mod api;
pub mod backup;
pub mod commands;
pub mod db;
pub mod error;
pub mod model;
pub mod reminders;
pub mod repo;
pub mod scheduler;
pub mod spool;
pub mod state;

use std::sync::Arc;

use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::{api::ApiState, state::AppState};

/// Event the UI listens to; emitted when data changes outside the UI (API writes).
pub const DATA_CHANGED: &str = "data-changed";

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // The window was closed (webview destroyed to free RAM); build a fresh one.
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Tether")
        .inner_size(1240.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .build();
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Tether", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Tether", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Tether")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                log::info!("quit from tray");
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
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first (Tauri docs).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::open(&data_dir).map_err(|e| {
                log::error!("could not open database in {}: {e}", data_dir.display());
                Box::new(e) as Box<dyn std::error::Error>
            })?;
            app.manage(state.clone());
            app.manage(scheduler::PendingRoute::default());
            match backup::quick_check(&state.db) {
                Ok(r) if r == "ok" => {}
                Ok(r) => log::error!("database health check failed: {r}"),
                Err(e) => log::error!("database health check could not run: {e}"),
            }
            if let Ok(n) = state.db.write(|c| reminders::prune(c, 60))
                && n > 0
            {
                log::info!("pruned {n} old reminder rows");
            }

            // Soft-deleted tasks are kept 30 days, then purged (proposal section 7).
            let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            match state.db.write(|c| repo::tasks::purge_deleted(c, &cutoff)) {
                Ok(n) if n > 0 => log::info!("purged {n} deleted tasks"),
                Ok(_) => {}
                Err(e) => log::warn!("purge failed: {e}"),
            }

            // Import suggestions the MCP server spooled to disk while Tether was closed.
            {
                let state = state.clone();
                let notify = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                    loop {
                        tick.tick().await;
                        let (db, dir) = (state.db.clone(), state.data_dir.clone());
                        let r = tokio::task::spawn_blocking(move || spool::import(&db, &dir))
                            .await
                            .unwrap_or_default();
                        if r.imported > 0 {
                            log::info!("imported {} spooled suggestions", r.imported);
                            let _ = notify.emit(DATA_CHANGED, ());
                        }
                    }
                });
            }

            let handle = app.handle().clone();
            let opener = app.handle().clone();
            tauri::async_runtime::spawn(api::serve(ApiState {
                app: state,
                on_change: Arc::new(move || {
                    let _ = handle.emit(DATA_CHANGED, ());
                }),
                on_open: Arc::new(move || {
                    // Window work must happen on the main thread.
                    let h = opener.clone();
                    let _ = opener.run_on_main_thread(move || show_main_window(&h));
                }),
            }));

            scheduler::start(
                app.handle().clone(),
                app.state::<AppState>().inner().clone(),
            );

            build_tray(app)?;

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
        .invoke_handler(tauri::generate_handler![
            commands::dashboard_get,
            commands::search_all,
            commands::tasks_list,
            commands::task_get,
            commands::task_create,
            commands::task_update,
            commands::task_set_status,
            commands::task_reschedule,
            commands::task_schedule,
            commands::task_duplicate,
            commands::task_delete,
            commands::task_restore,
            commands::projects_list,
            commands::project_create,
            commands::project_update,
            commands::project_set_archived,
            commands::project_delete,
            commands::projects_reorder,
            commands::tags_list,
            commands::tag_delete,
            commands::notes_list,
            commands::note_get,
            commands::note_create,
            commands::note_update,
            commands::note_delete,
            commands::note_convert_to_tasks,
            commands::suggestions_list,
            commands::suggestion_approve,
            commands::suggestion_dismiss,
            commands::settings_get_all,
            commands::settings_set,
            commands::api_info,
            commands::pairing_start,
            commands::paired_browsers,
            commands::unpair_all,
            commands::code_projects_list,
            commands::code_project_set_project,
            commands::reminders_get,
            commands::reminders_set,
            commands::reminder_test,
            commands::reminder_snooze,
            commands::take_pending_route,
            commands::backup_settings_get,
            commands::backup_settings_set,
            commands::backups_list,
            commands::backup_now,
            commands::backup_restore,
            commands::export_json,
            commands::db_health,
            commands::reveal_path,
            commands::ai_settings_get,
            commands::ai_settings_set,
            commands::ai_status,
            commands::ai_extract,
            commands::ai_breakdown,
            commands::ai_summary,
            commands::autostart_get,
            commands::autostart_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // Closing the last window destroys its webview (frees RAM) but keeps the app in the tray.
        // `code == None` means "last window closed"; Some(_) means an explicit app.exit().
        if let RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
            log::info!("window closed, staying in tray");
        }
    });
}
