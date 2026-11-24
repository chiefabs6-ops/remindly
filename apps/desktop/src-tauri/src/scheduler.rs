//! Runs reminder planning every 30 s and turns notices into Windows toasts with buttons.
//! The last tick is stored, so reminders missed while the PC slept or Tether was closed are
//! caught up once (as one summary when there are several).

use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Local, Utc};
use tauri::{AppHandle, Emitter, Manager};
use tauri_winrt_notification::Toast;

use crate::{
    DATA_CHANGED,
    model::{Actor, TaskStatus},
    reminders::{self, Action, Notice, ReminderSettings},
    repo::{settings, tasks},
    state::AppState,
};

const LAST_TICK_KEY: &str = "scheduler.lastTick";
/// How far back to look on start-up after a long gap.
const MAX_CATCH_UP: i64 = 24;
pub const NAVIGATE: &str = "navigate";

fn aumid(app: &AppHandle) -> String {
    // Installed builds: the Start Menu shortcut registers the identifier (proven in Phase 0).
    if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

pub fn start(app: AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(StdDuration::from_secs(30));
        loop {
            tick.tick().await;
            let (app2, st) = (app.clone(), state.clone());
            let _ = tokio::task::spawn_blocking(move || run_once(&app2, &st)).await;
        }
    });
}

/// Daily automatic backup, only when the user switched it on.
fn auto_backup(app: &AppHandle, state: &AppState) {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let Ok(cfg) = state.db.read(crate::backup::BackupSettings::load) else {
        return;
    };
    if !cfg.auto_daily || cfg.last_auto.as_deref() == Some(today.as_str()) {
        return;
    }
    let folder = cfg.folder(&crate::commands::default_backup_dir(app));
    let outcome = crate::backup::backup_now(&state.db, &folder, "auto");
    match &outcome {
        Ok(b) => {
            log::info!("automatic backup {}", b.name);
            let _ = crate::backup::prune(&folder, cfg.keep_daily, cfg.keep_weekly);
        }
        // One attempt per day: a lasting problem (full disk, damaged database) must not retry
        // every 30 s. The error is shown in Settings > Backups.
        Err(e) => log::warn!("automatic backup failed: {e}"),
    }
    // Re-read so a settings change made during the backup is not overwritten.
    let _ = state.db.write(|c| {
        let mut fresh = crate::backup::BackupSettings::load(c)?;
        fresh.last_auto = Some(today.clone());
        fresh.last_error = outcome.as_ref().err().map(|e| e.to_string());
        fresh.save(c)
    });
}

fn run_once(app: &AppHandle, state: &AppState) {
    auto_backup(app, state);
    let now = Local::now();
    let mut gap = Duration::zero();
    let result = state.db.write(|c| {
        let cfg = ReminderSettings::load(c)?;
        let last = settings::get(c, LAST_TICK_KEY)?
            .and_then(|v| v.as_str().map(str::to_string))
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| t.with_timezone(&Local))
            .unwrap_or(now - Duration::seconds(30));
        let from = last.max(now - Duration::hours(MAX_CATCH_UP));
        gap = now - from;
        let notices = reminders::due_notices(c, &cfg, from, now)?;
        settings::set(
            c,
            LAST_TICK_KEY,
            &serde_json::Value::from(now.with_timezone(&Utc).to_rfc3339()),
        )?;
        Ok(notices)
    });
    let notices = match result {
        Ok(n) => n,
        Err(e) => return log::warn!("reminder tick failed: {e}"),
    };
    // After a gap (sleep, Tether closed) show one catch-up, not a burst.
    let missed = gap > Duration::minutes(2);
    let notices = if missed {
        reminders::collapse_missed(notices)
    } else {
        notices
    };
    match notices.len() {
        0 => {}
        1 if !missed => notices.into_iter().for_each(|n| show(app, n, false)),
        1 => notices.into_iter().for_each(|n| show(app, n, true)),
        n if missed || n > 5 => show_summary(app, &notices, missed),
        _ => notices.into_iter().for_each(|n| show(app, n, false)),
    }
}

fn notice_title(n: &Notice) -> String {
    match n {
        Notice::DueSoon { task }
        | Notice::Due { task }
        | Notice::Overdue { task }
        | Notice::Snooze { task }
        | Notice::Nudge { task } => task.title.clone(),
        Notice::Briefing { .. } => "Morning briefing".into(),
        Notice::Review { .. } => "End of day review".into(),
    }
}

fn show_summary(app: &AppHandle, notices: &[Notice], missed: bool) {
    let mut names: Vec<String> = notices.iter().take(3).map(notice_title).collect();
    if notices.len() > 3 {
        names.push(format!("and {} more", notices.len() - 3));
    }
    let title = if missed {
        format!("{} reminders while you were away", notices.len())
    } else {
        format!("{} reminders", notices.len())
    };
    toast(
        app,
        "Tether",
        &title,
        &names.join(" · "),
        &[("Open Today", "open:today"), ("Review", "open:review")],
    );
}

fn show(app: &AppHandle, n: Notice, missed: bool) {
    // Windows allows five buttons. A custom time is set from the task in the app.
    let snooze = |id: &str| -> Vec<(String, String)> {
        vec![
            ("15 min".into(), format!("snooze:15:{id}")),
            ("30 min".into(), format!("snooze:30:{id}")),
            ("1 hour".into(), format!("snooze:60:{id}")),
            ("Tomorrow".into(), format!("snooze:tomorrow:{id}")),
            ("Done".into(), format!("done:{id}")),
        ]
    };
    let (title, body, buttons): (String, String, Vec<(String, String)>) = match &n {
        Notice::DueSoon { task } => (
            task.title.clone(),
            format!("Due at {}", task.due_time.clone().unwrap_or_default()),
            snooze(&task.id),
        ),
        Notice::Due { task } if missed => (
            task.title.clone(),
            format!("Was due at {}", task.due_time.clone().unwrap_or_default()),
            snooze(&task.id),
        ),
        Notice::Due { task } => (task.title.clone(), "Due now".into(), snooze(&task.id)),
        Notice::Overdue { task } => (
            task.title.clone(),
            "Still open and now overdue".into(),
            snooze(&task.id),
        ),
        Notice::Snooze { task } => (
            task.title.clone(),
            "Snoozed reminder".into(),
            snooze(&task.id),
        ),
        Notice::Nudge { task } => (
            task.title.clone(),
            "Worth doing next?".into(),
            snooze(&task.id),
        ),
        Notice::Briefing {
            due_today,
            overdue,
            carried_over,
            upcoming,
            suggestions,
        } => {
            let mut parts = vec![format!("{due_today} due today")];
            if *overdue > 0 {
                parts.push(format!("{overdue} overdue"));
            }
            if *carried_over > 0 {
                parts.push(format!("{carried_over} carried over"));
            }
            if *upcoming > 0 {
                parts.push(format!("{upcoming} due in the next 3 days"));
            }
            if *suggestions > 0 {
                parts.push(format!("{suggestions} suggestions to review"));
            }
            let mut buttons = vec![("Open Today".to_string(), "open:today".to_string())];
            if *suggestions > 0 {
                buttons.push(("Review suggestions".into(), "open:inbox".into()));
            }
            ("Good morning".into(), parts.join(" · "), buttons)
        }
        Notice::Review { open } => (
            "End of day review".into(),
            format!("{open} task(s) still open for today. Move, reschedule or finish them."),
            vec![("Review now".into(), "open:review".into())],
        ),
    };
    let refs: Vec<(&str, &str)> = buttons
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    toast(app, "Tether", &title, &body, &refs);
}

/// Toasts are shown from the main thread (WinRT COM apartment).
fn toast(app: &AppHandle, _app_name: &str, title: &str, body: &str, buttons: &[(&str, &str)]) {
    let (id, title, body) = (aumid(app), title.to_string(), body.to_string());
    let buttons: Vec<(String, String)> = buttons
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut t = Toast::new(&id).title(&title).text1(&body);
        // Windows shows at most 5 buttons.
        for (label, action) in buttons.iter().take(5) {
            t = t.add_button(label, action);
        }
        let on_click = handle.clone();
        let result = t
            .on_activated(move |action| {
                handle_action(&on_click, action.as_deref());
                Ok(())
            })
            .show();
        if let Err(e) = result {
            log::warn!("toast failed: {e}");
        }
    });
}

pub fn handle_action(app: &AppHandle, action: Option<&str>) {
    let state = app.state::<AppState>().inner().clone();
    let act = reminders::parse_action(action);
    let today = Local::now().date_naive();
    let r = match &act {
        Action::Snooze { task, minutes } => state
            .db
            .write(|c| reminders::snooze(c, task, Local::now() + Duration::minutes(*minutes))),
        Action::SnoozeTomorrow { task } => state.db.write(|c| {
            let cfg = ReminderSettings::load(c)?;
            reminders::snooze(c, task, reminders::next_work_start(&cfg, Local::now()))
        }),
        Action::Tomorrow { task } => state
            .db
            .write(|c| reminders::move_to_tomorrow(c, task, today).map(|_| ())),
        Action::Done { task } => state.db.write(|c| {
            tasks::set_status(c, task, TaskStatus::Completed, false, Actor::User).map(|_| ())
        }),
        Action::Open { path } => {
            open_at(app, path.clone());
            Ok(())
        }
    };
    if let Err(e) = r {
        log::warn!("reminder action {action:?} failed: {e}");
    }
    let _ = app.emit(DATA_CHANGED, ());
}

/// Route to show once the window's page loads (a closed window has no listener yet).
#[derive(Default)]
pub struct PendingRoute(pub std::sync::Mutex<Option<String>>);

fn open_at(app: &AppHandle, path: String) {
    let has_window = app.get_webview_window("main").is_some();
    if has_window {
        // Only the main window navigates; pop-out task windows stay on their task.
        let _ = app.emit_to("main", NAVIGATE, path);
    } else if let Some(p) = app.try_state::<PendingRoute>() {
        *p.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }
    let h = app.clone();
    let _ = app.run_on_main_thread(move || crate::show_main_window(&h));
}

/// Settings > Reminders "Send a test" button.
pub fn test_toast(app: &AppHandle) {
    toast(
        app,
        "Tether",
        "Test reminder",
        "Buttons here snooze, move to tomorrow or finish a task.",
        &[("Open Today", "open:today")],
    );
}
