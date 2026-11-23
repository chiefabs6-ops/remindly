//! Tauri commands for the React UI. `async` so SQLite work runs off the main (UI) thread.
//! Argument names are camelCase on the JS side (Tauri converts them).

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    api::ALLOWED_ORIGINS_KEY,
    error::{AppError, AppResult},
    model::{
        Actor, Note, NoteFilter, NoteInput, Project, ProjectInput, Source, Suggestion,
        SuggestionStatus, Tag, Task, TaskDetail, TaskFilter, TaskInput, TaskOrigin, TaskStatus,
    },
    repo::{
        dashboard::{self, Clock, Dashboard},
        notes, projects,
        search::{self, SearchResults},
        settings,
        suggestions::{self, Approved},
        tags, tasks,
    },
    state::{API_PORT, AppState},
};

type Db<'a> = State<'a, AppState>;

// ---------- dashboard & search ----------

#[tauri::command(async)]
pub fn dashboard_get(s: Db) -> AppResult<Dashboard> {
    s.db.read(|c| dashboard::build(c, &Clock::now()))
}

#[tauri::command(async)]
pub fn search_all(s: Db, query: String) -> AppResult<SearchResults> {
    s.db.read(|c| search::search_all(c, &query, 50))
}

// ---------- tasks ----------

#[tauri::command(async)]
pub fn tasks_list(s: Db, filter: TaskFilter) -> AppResult<Vec<Task>> {
    s.db.read(|c| tasks::list(c, &filter))
}

#[tauri::command(async)]
pub fn task_get(s: Db, id: String) -> AppResult<TaskDetail> {
    s.db.read(|c| tasks::detail(c, &id))
}

/// Manual creation from the UI. Only `parentId` is taken from the origin; source is always manual.
#[tauri::command(async)]
pub fn task_create(s: Db, input: TaskInput, parent_id: Option<String>) -> AppResult<Task> {
    let origin = TaskOrigin {
        parent_id,
        source: Some(Source::Manual),
        ..Default::default()
    };
    s.db.write(|c| tasks::create(c, &input, &origin, Actor::User))
}

#[tauri::command(async)]
pub fn task_update(s: Db, id: String, input: TaskInput) -> AppResult<Task> {
    s.db.write(|c| tasks::update(c, &id, &input, Actor::User))
}

#[tauri::command(async)]
pub fn task_set_status(s: Db, id: String, status: TaskStatus, cascade: bool) -> AppResult<Task> {
    s.db.write(|c| tasks::set_status(c, &id, status, cascade, Actor::User))
}

#[tauri::command(async)]
pub fn task_reschedule(
    s: Db,
    id: String,
    due_date: Option<String>,
    due_time: Option<String>,
) -> AppResult<Task> {
    s.db.write(|c| tasks::reschedule(c, &id, due_date, due_time, Actor::User))
}

#[tauri::command(async)]
pub fn task_schedule(s: Db, id: String, scheduled_date: Option<String>) -> AppResult<Task> {
    s.db.write(|c| tasks::schedule(c, &id, scheduled_date, Actor::User))
}

#[tauri::command(async)]
pub fn task_duplicate(s: Db, id: String) -> AppResult<Task> {
    s.db.write(|c| tasks::duplicate(c, &id, Actor::User))
}

#[tauri::command(async)]
pub fn task_delete(s: Db, id: String) -> AppResult<()> {
    s.db.write(|c| tasks::soft_delete(c, &id, Actor::User))
}

#[tauri::command(async)]
pub fn task_restore(s: Db, id: String) -> AppResult<Task> {
    s.db.write(|c| tasks::restore(c, &id, Actor::User))
}

// ---------- projects & tags ----------

#[tauri::command(async)]
pub fn projects_list(s: Db, include_archived: bool) -> AppResult<Vec<Project>> {
    s.db.read(|c| projects::list(c, include_archived))
}

#[tauri::command(async)]
pub fn project_create(s: Db, input: ProjectInput) -> AppResult<Project> {
    s.db.write(|c| projects::create(c, &input))
}

#[tauri::command(async)]
pub fn project_update(s: Db, id: String, input: ProjectInput) -> AppResult<Project> {
    s.db.write(|c| projects::update(c, &id, &input))
}

#[tauri::command(async)]
pub fn project_set_archived(s: Db, id: String, archived: bool) -> AppResult<Project> {
    s.db.write(|c| projects::set_archived(c, &id, archived))
}

#[tauri::command(async)]
pub fn project_delete(s: Db, id: String) -> AppResult<()> {
    s.db.write(|c| projects::delete(c, &id))
}

#[tauri::command(async)]
pub fn projects_reorder(s: Db, ids: Vec<String>) -> AppResult<()> {
    s.db.write(|c| projects::reorder(c, &ids))
}

#[tauri::command(async)]
pub fn tags_list(s: Db) -> AppResult<Vec<Tag>> {
    s.db.read(tags::list)
}

#[tauri::command(async)]
pub fn tag_delete(s: Db, id: String) -> AppResult<()> {
    s.db.write(|c| tags::delete(c, &id))
}

// ---------- notes ----------

#[tauri::command(async)]
pub fn notes_list(s: Db, filter: NoteFilter) -> AppResult<Vec<Note>> {
    s.db.read(|c| notes::list(c, &filter))
}

#[tauri::command(async)]
pub fn note_get(s: Db, id: String) -> AppResult<Note> {
    s.db.read(|c| notes::get(c, &id))
}

#[tauri::command(async)]
pub fn note_create(s: Db, input: NoteInput) -> AppResult<Note> {
    s.db.write(|c| notes::create(c, &input, Source::Manual))
}

#[tauri::command(async)]
pub fn note_update(s: Db, id: String, input: NoteInput) -> AppResult<Note> {
    s.db.write(|c| notes::update(c, &id, &input))
}

#[tauri::command(async)]
pub fn note_delete(s: Db, id: String) -> AppResult<()> {
    s.db.write(|c| notes::soft_delete(c, &id))
}

#[tauri::command(async)]
pub fn note_convert_to_tasks(s: Db, id: String) -> AppResult<Vec<Task>> {
    s.db.write(|c| notes::convert_to_tasks(c, &id, Actor::User))
}

// ---------- suggestions ----------

#[tauri::command(async)]
pub fn suggestions_list(s: Db, status: Option<SuggestionStatus>) -> AppResult<Vec<Suggestion>> {
    s.db.read(|c| suggestions::list(c, status, 200))
}

#[tauri::command(async)]
pub fn suggestion_approve(s: Db, id: String, edited: Option<Value>) -> AppResult<Approved> {
    s.db.write(|c| suggestions::approve(c, &id, edited))
}

#[tauri::command(async)]
pub fn suggestion_dismiss(s: Db, id: String) -> AppResult<Suggestion> {
    s.db.write(|c| suggestions::dismiss(c, &id))
}

// ---------- settings ----------

/// Keys the UI may write. Security-relevant keys (allowed origins) are managed by pairing only.
const UI_SETTINGS: &[&str] = &["theme", "onboarded", "sidebarCollapsed", "defaultProjectId"];

#[tauri::command(async)]
pub fn settings_get_all(s: Db) -> AppResult<serde_json::Map<String, Value>> {
    let mut all = s.db.read(settings::all)?;
    all.remove(ALLOWED_ORIGINS_KEY);
    Ok(all)
}

#[tauri::command(async)]
pub fn settings_set(s: Db, key: String, value: Value) -> AppResult<()> {
    if !UI_SETTINGS.contains(&key.as_str()) {
        return Err(AppError::invalid(format!("unknown setting {key}")));
    }
    s.db.write(|c| settings::set(c, &key, &value))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInfo {
    pub url: String,
    /// Last 4 characters only; the full token never goes to the webview.
    pub token_hint: String,
    pub data_dir: String,
}

#[tauri::command(async)]
pub fn api_info(s: Db) -> ApiInfo {
    let token = s.token();
    let t = token.as_str();
    ApiInfo {
        url: format!("http://127.0.0.1:{API_PORT}"),
        token_hint: t[t.len().saturating_sub(4)..].to_string(),
        data_dir: s.data_dir.display().to_string(),
    }
}

// ---------- browser pairing ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub expires_in_secs: u64,
}

#[tauri::command(async)]
pub fn pairing_start(s: Db) -> PairingCode {
    PairingCode {
        code: s.start_pairing(),
        expires_in_secs: crate::state::PAIRING_TTL.as_secs(),
    }
}

/// Extension origins allowed to call the API (the Tether extension has one fixed ID).
#[tauri::command(async)]
pub fn paired_browsers(s: Db) -> AppResult<Vec<String>> {
    let v = s.db.read(|c| settings::get(c, ALLOWED_ORIGINS_KEY))?;
    Ok(v.and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect())
}

/// Forget every paired browser and issue a new token.
#[tauri::command(async)]
pub fn unpair_all(s: Db) -> AppResult<()> {
    s.db.write(|c| settings::set(c, ALLOWED_ORIGINS_KEY, &Value::Array(vec![])))?;
    s.rotate_token()
}

// ---------- Claude Code repos ----------

#[tauri::command(async)]
pub fn code_projects_list(s: Db) -> AppResult<Vec<crate::repo::code_projects::CodeProject>> {
    s.db.read(crate::repo::code_projects::list)
}

#[tauri::command(async)]
pub fn code_project_set_project(
    s: Db,
    id: String,
    project_id: Option<String>,
) -> AppResult<crate::repo::code_projects::CodeProject> {
    s.db.write(|c| crate::repo::code_projects::set_project(c, &id, project_id.as_deref()))
}

// ---------- reminders & startup ----------

#[tauri::command(async)]
pub fn reminders_get(s: Db) -> AppResult<crate::reminders::ReminderSettings> {
    s.db.read(crate::reminders::ReminderSettings::load)
}

#[tauri::command(async)]
pub fn reminders_set(
    s: Db,
    value: crate::reminders::ReminderSettings,
) -> AppResult<crate::reminders::ReminderSettings> {
    value.validate()?;
    s.db.write(|c| {
        settings::set(
            c,
            crate::reminders::SETTINGS_KEY,
            &serde_json::to_value(&value)?,
        )
    })?;
    Ok(value)
}

#[tauri::command(async)]
pub fn reminder_test(app: tauri::AppHandle) {
    crate::scheduler::test_toast(&app);
}

#[tauri::command(async)]
pub fn autostart_get(app: tauri::AppHandle) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Start Tether (hidden, in the tray) when you sign in to Windows. Per-user, no admin.
#[tauri::command(async)]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    let r = if enabled { m.enable() } else { m.disable() };
    r.map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    Ok(enabled)
}

/// "Remind me at" from the task panel: a custom snooze time (RFC 3339, in the future).
#[tauri::command(async)]
pub fn reminder_snooze(s: Db, id: String, until: String) -> AppResult<()> {
    let t = chrono::DateTime::parse_from_rfc3339(&until)
        .map_err(|_| AppError::invalid("pick a date and time"))?
        .with_timezone(&chrono::Local);
    if t <= chrono::Local::now() {
        return Err(AppError::invalid("pick a time in the future"));
    }
    s.db.write(|c| crate::reminders::snooze(c, &id, t))
}

/// A screen requested by a notification click before the window existed.
#[tauri::command]
pub fn take_pending_route(p: tauri::State<'_, crate::scheduler::PendingRoute>) -> Option<String> {
    p.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

// ---------- backups ----------

/// Documents\Tether\Backups (falls back to the app data folder).
pub fn default_backup_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .document_dir()
        .map(|d| d.join("Tether").join("Backups"))
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("backups")))
        .unwrap_or_else(|_| std::path::PathBuf::from("backups"))
}

fn backup_folder(app: &tauri::AppHandle, s: &AppState) -> AppResult<std::path::PathBuf> {
    let cfg = s.db.read(crate::backup::BackupSettings::load)?;
    Ok(cfg.folder(&default_backup_dir(app)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettingsView {
    #[serde(flatten)]
    pub settings: crate::backup::BackupSettings,
    pub folder: String,
}

#[tauri::command(async)]
pub fn backup_settings_get(app: tauri::AppHandle, s: Db) -> AppResult<BackupSettingsView> {
    let settings = s.db.read(crate::backup::BackupSettings::load)?;
    let folder = settings
        .folder(&default_backup_dir(&app))
        .display()
        .to_string();
    Ok(BackupSettingsView { settings, folder })
}

#[tauri::command(async)]
pub fn backup_settings_set(
    app: tauri::AppHandle,
    s: Db,
    value: crate::backup::BackupSettings,
) -> AppResult<BackupSettingsView> {
    if !(1..=60).contains(&value.keep_daily) || value.keep_weekly > 52 {
        return Err(AppError::invalid("keep 1-60 daily and 0-52 weekly backups"));
    }
    let dir = value.dir.trim();
    if dir.starts_with("\\\\") {
        return Err(AppError::invalid(
            "backups stay on this PC: pick a local folder, not a network share",
        ));
    }
    if !dir.is_empty() && !std::path::Path::new(dir).is_absolute() {
        return Err(AppError::invalid(
            "the backup folder must be a full path, e.g. D:\\Backups\\Tether",
        ));
    }
    let mut v = value.clone();
    let stored = s.db.read(crate::backup::BackupSettings::load)?;
    v.last_auto = stored.last_auto;
    v.last_error = stored.last_error;
    s.db.write(|c| v.save(c))?;
    backup_settings_get(app, s)
}

#[tauri::command(async)]
pub fn backups_list(app: tauri::AppHandle, s: Db) -> AppResult<Vec<crate::backup::BackupFile>> {
    crate::backup::list(&backup_folder(&app, &s)?)
}

#[tauri::command(async)]
pub fn backup_now(app: tauri::AppHandle, s: Db) -> AppResult<crate::backup::BackupFile> {
    crate::backup::backup_now(&s.db, &backup_folder(&app, &s)?, "")
}

#[tauri::command(async)]
pub fn backup_restore(
    app: tauri::AppHandle,
    s: Db,
    name: String,
) -> AppResult<crate::backup::BackupFile> {
    use tauri::Emitter;
    let safety = crate::backup::restore(&s.db, &backup_folder(&app, &s)?, &name)?;
    let _ = app.emit(crate::DATA_CHANGED, ());
    Ok(safety)
}

/// Write everything as JSON to Documents\Tether\Exports; returns the file path.
#[tauri::command(async)]
pub fn export_json(app: tauri::AppHandle, s: Db) -> AppResult<String> {
    let dir = default_backup_dir(&app).with_file_name("Exports");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "tether-export-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    let v = crate::backup::export_json(&s.db)?;
    std::fs::write(&path, serde_json::to_string_pretty(&v)?)?;
    Ok(path.display().to_string())
}

#[tauri::command(async)]
pub fn db_health(s: Db) -> AppResult<String> {
    crate::backup::quick_check(&s.db)
}

/// Show a backup or export in Explorer (folders under the app's own backup/export locations only).
#[tauri::command(async)]
pub fn reveal_path(app: tauri::AppHandle, s: Db, path: String) -> AppResult<()> {
    let bad = || AppError::invalid("only backup and export files can be shown");
    let p = std::fs::canonicalize(&path).map_err(|_| bad())?;
    let backups = std::fs::canonicalize(backup_folder(&app, &s)?).ok();
    let exports = std::fs::canonicalize(default_backup_dir(&app).with_file_name("Exports")).ok();
    let parent = p.parent().map(|x| x.to_path_buf());
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let in_place = parent.is_some() && (parent == backups || parent == exports);
    let named = name.starts_with("tether-")
        && (name.ends_with(".db") || name.ends_with(".json"))
        && !name.contains(',');
    if !p.is_file() || !in_place || !named {
        return Err(bad());
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", p.display()))
        .spawn()?;
    Ok(())
}
