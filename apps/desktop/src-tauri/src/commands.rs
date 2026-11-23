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
