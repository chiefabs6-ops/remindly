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

fn run_once(app: &AppHandle, state: &AppState) {
    let now = Local::now();
    let result = state.db.write(|c| {
        let cfg = ReminderSettings::load(c)?;
        let last = settings::get(c, LAST_TICK_KEY)?
            .and_then(|v| v.as_str().map(str::to_string))
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| t.with_timezone(&Local))
            .unwrap_or(now - Duration::seconds(30));
        let from = last.max(now - Duration::hours(MAX_CATCH_UP));
        let notices = reminders::due_notices(c, &cfg, from, now)?;
        settings::set(
            c,
            LAST_TICK_KEY,
            &serde_json::Value::from(now.with_timezone(&Utc).to_rfc3339()),
        )?;
        Ok(notices)
    });
    match result {
        Ok(notices) if notices.len() > 3 => show_summary(app, notices.len()),
        Ok(notices) => notices.into_iter().for_each(|n| show(app, n)),
        Err(e) => log::warn!("reminder tick failed: {e}"),
    }
}

fn show_summary(app: &AppHandle, count: usize) {
    toast(
        app,
        "Tether",
        &format!("{count} reminders while you were away"),
        "Open Today to see what is due.",
        &[("Open", "open:today")],
    );
}

fn show(app: &AppHandle, n: Notice) {
    let snooze = |id: &str| -> Vec<(String, String)> {
        vec![
            ("Snooze 15 min".into(), format!("snooze:15:{id}")),
            ("Snooze 1 h".into(), format!("snooze:60:{id}")),
            ("Tomorrow".into(), format!("tomorrow:{id}")),
            ("Done".into(), format!("done:{id}")),
        ]
    };
    let (title, body, buttons): (String, String, Vec<(String, String)>) = match &n {
        Notice::DueSoon { task } => (
            task.title.clone(),
            format!("Due at {}", task.due_time.clone().unwrap_or_default()),
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
            suggestions,
        } => (
            "Good morning".into(),
            format!(
                "{due_today} due today · {overdue} overdue{}",
                if *suggestions > 0 {
                    format!(" · {suggestions} suggestions to review")
                } else {
                    String::new()
                }
            ),
            vec![("Open Today".into(), "open:today".into())],
        ),
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
        Action::Tomorrow { task } => state
            .db
            .write(|c| reminders::move_to_tomorrow(c, task, today).map(|_| ())),
        Action::Done { task } => state.db.write(|c| {
            tasks::set_status(c, task, TaskStatus::Completed, false, Actor::User).map(|_| ())
        }),
        Action::Open { path } => {
            let path = path.clone();
            let h = app.clone();
            let _ = app.run_on_main_thread(move || crate::show_main_window(&h));
            let _ = app.emit(NAVIGATE, path);
            Ok(())
        }
    };
    if let Err(e) = r {
        log::warn!("reminder action {action:?} failed: {e}");
    }
    let _ = app.emit(DATA_CHANGED, ());
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
