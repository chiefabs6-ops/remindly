//! Suggestions: items from Chrome / Claude Code / AI that wait in the Inbox for approval.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    model::{
        Actor, NewSuggestion, NoteInput, Origin, SuggestedTask, SuggestedUpdate, Suggestion,
        SuggestionKind, SuggestionStatus, TaskFilter, TaskInput, TaskOrigin, TaskStatus,
        clean_date, clean_time, clean_title, new_id, now_utc,
    },
    repo::{code_projects, notes, projects, similarity, tasks},
};

const COLS: &str = "id, kind, origin, target_task_id, payload_json, context_json, confidence_json,
    dedupe_key, possible_duplicate_of, status, resulting_id, created_at, decided_at";

/// Max size of any JSON blob in a suggestion (payload/context/confidence).
const MAX_JSON: usize = 64 * 1024;

fn parse_json(s: Option<String>) -> rusqlite::Result<Option<Value>> {
    s.map(|s| {
        serde_json::from_str(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    })
    .transpose()
}

fn from_row(r: &Row) -> rusqlite::Result<Suggestion> {
    Ok(Suggestion {
        id: r.get(0)?,
        kind: r.get(1)?,
        origin: r.get(2)?,
        target_task_id: r.get(3)?,
        payload: parse_json(r.get(4)?)?.unwrap_or(Value::Null),
        context: parse_json(r.get(5)?)?,
        confidence: parse_json(r.get(6)?)?,
        dedupe_key: r.get(7)?,
        possible_duplicate_of: r.get(8)?,
        status: r.get(9)?,
        resulting_id: r.get(10)?,
        created_at: r.get(11)?,
        decided_at: r.get(12)?,
    })
}

fn to_json(field: &str, v: &Option<Value>) -> AppResult<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let s = serde_json::to_string(v)?;
            if s.len() > MAX_JSON {
                return Err(AppError::invalid(format!("{field} is too large")));
            }
            Ok(Some(s))
        }
    }
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Suggestion> {
    conn.query_row(
        &format!("SELECT {COLS} FROM suggestions WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("suggestion".into()))
}

pub fn list(
    conn: &Connection,
    status: Option<SuggestionStatus>,
    limit: u32,
) -> AppResult<Vec<Suggestion>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM suggestions WHERE (?1 IS NULL OR status = ?1)
         ORDER BY created_at DESC LIMIT {limit}"
    ))?;
    let rows = stmt.query_map([status], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn pending_counts(conn: &Connection) -> AppResult<Vec<(Origin, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT origin, count(*) FROM suggestions WHERE status = 'pending' GROUP BY origin ORDER BY origin",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Best open task whose title looks like `title`, if any scores above the threshold.
pub fn find_similar_task(conn: &Connection, title: &str) -> AppResult<Option<String>> {
    // Narrow with FTS on the longest word, then score in Rust. Falls back to recent open tasks.
    let norm = similarity::normalize(title);
    let probe = norm
        .split_whitespace()
        .filter(|w| w.chars().count() >= 3)
        .max_by_key(|w| w.chars().count())
        .map(str::to_string);
    let candidates = tasks::list(
        conn,
        &TaskFilter {
            query: probe,
            statuses: vec![
                TaskStatus::Inbox,
                TaskStatus::NotStarted,
                TaskStatus::InProgress,
                TaskStatus::Waiting,
            ],
            limit: Some(200),
            ..Default::default()
        },
    )?;
    Ok(candidates
        .into_iter()
        .map(|t| (similarity::dice(title, &t.title), t.id))
        .filter(|(score, _)| *score >= similarity::DUPLICATE_THRESHOLD)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id))
}

/// A client's capture time, normalised to UTC; must be within the last 60 days and not in the
/// future (5 minutes of clock skew allowed). Absent means "now".
fn captured_time(v: &Option<String>) -> AppResult<String> {
    let Some(raw) = v.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(now_utc());
    };
    let t = chrono::DateTime::parse_from_rfc3339(raw)
        .map_err(|_| AppError::invalid("capturedAt must be an RFC 3339 time"))?
        .with_timezone(&chrono::Utc);
    let now = chrono::Utc::now();
    if t > now + chrono::Duration::minutes(5) || t < now - chrono::Duration::days(60) {
        return Err(AppError::invalid("capturedAt is out of range"));
    }
    Ok(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Only web links may come from outside clients (no `javascript:`, `file:` ...).
fn check_url(url: &Option<String>) -> AppResult<()> {
    match url.as_deref().map(str::trim) {
        None | Some("") => Ok(()),
        Some(u) if (u.starts_with("https://") || u.starts_with("http://")) && u.len() <= 2048 => {
            Ok(())
        }
        Some(_) => Err(AppError::invalid("sourceUrl must be an http(s) link")),
    }
}

fn check_update(u: &SuggestedUpdate) -> AppResult<()> {
    if let Some(t) = &u.title {
        clean_title(t)?;
    }
    if let Some(d) = &u.due_date {
        clean_date("due date", d)?;
    }
    if let Some(t) = &u.due_time {
        clean_time("due time", t)?;
    }
    if u.priority.is_some_and(|p| p > 3) {
        return Err(AppError::invalid("priority must be 0-3"));
    }
    if u.add_subtasks.len() > 15 {
        return Err(AppError::invalid("at most 15 subtasks at once"));
    }
    for st in &u.add_subtasks {
        clean_title(st)?;
    }
    if u.append_note.as_ref().is_some_and(|n| n.len() > 20_000) {
        return Err(AppError::invalid("appendNote is too long"));
    }
    let empty = u.title.is_none()
        && u.status.is_none()
        && u.due_date.is_none()
        && u.due_time.is_none()
        && u.priority.is_none()
        && u.append_note.as_deref().is_none_or(|n| n.trim().is_empty())
        && u.add_subtasks.is_empty();
    if empty {
        return Err(AppError::invalid("task_update changes nothing"));
    }
    Ok(())
}

/// Validate a payload for its kind; returns the title used for duplicate checks.
fn validate_payload(conn: &Connection, s: &NewSuggestion) -> AppResult<Option<String>> {
    match s.kind {
        SuggestionKind::Task => {
            let t: SuggestedTask = serde_json::from_value(s.payload.clone())
                .map_err(|e| AppError::invalid(format!("invalid task payload: {e}")))?;
            let title = clean_title(&t.title)?;
            check_url(&t.source_url)?;
            clean_date("due date", &t.due_date)?;
            clean_time("due time", &t.due_time)?;
            if t.priority.is_some_and(|p| p > 3) {
                return Err(AppError::invalid("priority must be 0-3"));
            }
            Ok(Some(title))
        }
        SuggestionKind::Note => {
            let n: NoteInput = serde_json::from_value(s.payload.clone())
                .map_err(|e| AppError::invalid(format!("invalid note payload: {e}")))?;
            check_url(&n.source_url)?;
            if n.title.trim().is_empty() && n.body_md.trim().is_empty() {
                return Err(AppError::invalid("a note needs a title or some text"));
            }
            Ok(None)
        }
        SuggestionKind::TaskUpdate => {
            let target = s
                .target_task_id
                .as_deref()
                .ok_or_else(|| AppError::invalid("task_update needs targetTaskId"))?;
            let t = tasks::get(conn, target)?;
            let u: SuggestedUpdate = serde_json::from_value(s.payload.clone())
                .map_err(|e| AppError::invalid(format!("invalid task_update payload: {e}")))?;
            check_update(&u)?;
            let date_after = match &u.due_date {
                Some(d) => d.clone(),
                None => t.due_date.clone(),
            };
            if matches!(u.due_time, Some(Some(_))) && date_after.is_none() {
                return Err(AppError::invalid("a due time needs a due date"));
            }
            Ok(None)
        }
    }
}

/// A Claude task spooled while Tether was closed carries `repo: {rootDir, name, gitRemote}`
/// instead of `codeProjectId`; resolve it now so the task links to its repo.
fn attach_repo(conn: &Connection, s: &NewSuggestion) -> AppResult<serde_json::Value> {
    let mut payload = s.payload.clone();
    if s.kind != SuggestionKind::Task {
        return Ok(payload);
    }
    if let Some(obj) = payload.as_object_mut() {
        if let Some(repo) = obj.remove("repo")
            && !obj.contains_key("codeProjectId")
        {
            let input: code_projects::ResolveInput = serde_json::from_value(repo)
                .map_err(|e| AppError::invalid(format!("invalid repo: {e}")))?;
            let cp = code_projects::resolve(conn, &input)?;
            obj.insert("codeProjectId".into(), serde_json::Value::from(cp.id));
        }
        if let Some(id) = obj.get("codeProjectId").and_then(|v| v.as_str()) {
            code_projects::get(conn, id).map_err(|_| AppError::invalid("unknown codeProjectId"))?;
        }
    }
    Ok(payload)
}

/// Store a suggestion. Idempotent on `dedupe_key` whatever the earlier one's status, so a client
/// retrying after a timeout, or an offline queue replaying, never re-creates a decided item.
pub fn create(conn: &Connection, s: &NewSuggestion) -> AppResult<Suggestion> {
    let dedupe_key = s
        .dedupe_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    if let Some(k) = &dedupe_key {
        if k.len() > 200 {
            return Err(AppError::invalid("dedupeKey is too long"));
        }
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM suggestions WHERE dedupe_key = ?1 ORDER BY created_at DESC LIMIT 1",
                [k],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return get(conn, &id);
        }
    }
    let payload = attach_repo(conn, s)?;
    let s = &NewSuggestion {
        payload,
        ..s.clone()
    };
    let title = validate_payload(conn, s)?;
    let possible_dup = match &title {
        Some(t) => find_similar_task(conn, t)?,
        None => None,
    };
    let id = new_id();
    let created_at = captured_time(&s.captured_at)?;
    conn.execute(
        "INSERT INTO suggestions(id, kind, origin, target_task_id, payload_json, context_json,
            confidence_json, dedupe_key, possible_duplicate_of, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)",
        params![
            id,
            s.kind,
            s.origin,
            s.target_task_id,
            to_json("payload", &Some(s.payload.clone()))?,
            to_json("context", &s.context)?,
            to_json("confidence", &s.confidence)?,
            dedupe_key,
            possible_dup,
            created_at
        ],
    )?;
    get(conn, &id)
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    pub kind: SuggestionKind,
    /// Id of the task or note that was created/changed.
    pub id: String,
}

/// Render the free-form context object (completed / remaining / why / resume hint...) as Markdown.
pub fn context_markdown(ctx: &Value) -> Option<String> {
    let obj = ctx.as_object()?;
    let mut out = String::new();
    for (k, v) in obj {
        let label = {
            let spaced: String = k
                .chars()
                .flat_map(|c| {
                    if c.is_uppercase() {
                        vec![' ', c.to_ascii_lowercase()]
                    } else if c == '_' {
                        vec![' ']
                    } else {
                        vec![c]
                    }
                })
                .collect();
            let mut cs = spaced.trim().chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
                None => continue,
            }
        };
        match v {
            Value::Array(items) if !items.is_empty() => {
                out.push_str(&format!("**{label}**\n"));
                for i in items {
                    let s = i
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| i.to_string());
                    out.push_str(&format!("- {s}\n"));
                }
                out.push('\n');
            }
            Value::String(s) if !s.trim().is_empty() => {
                out.push_str(&format!("**{label}:** {}\n\n", s.trim()));
            }
            Value::Number(n) => out.push_str(&format!("**{label}:** {n}\n\n")),
            Value::Bool(b) => out.push_str(&format!("**{label}:** {b}\n\n")),
            _ => {}
        }
    }
    let out = out.trim_end().to_string();
    (!out.is_empty()).then_some(out)
}

/// Approve a pending suggestion. `edited` (same shape as the payload) replaces the payload when
/// the user changed fields in the review form.
pub fn approve(conn: &Connection, id: &str, edited: Option<Value>) -> AppResult<Approved> {
    let s = get(conn, id)?;
    if s.status != SuggestionStatus::Pending {
        return Err(AppError::Conflict(format!(
            "suggestion is already {}",
            s.status.as_str()
        )));
    }
    let payload = edited.unwrap_or_else(|| s.payload.clone());
    let actor = Actor::User; // the user approves; origin is kept on the task's `source`
    let result = match s.kind {
        SuggestionKind::Task => {
            let t: SuggestedTask = serde_json::from_value(payload)
                .map_err(|e| AppError::invalid(format!("invalid task payload: {e}")))?;
            let code_project = match &t.code_project_id {
                Some(id) => Some(code_projects::get(conn, id)?),
                None => None,
            };
            let project_id = match (&t.project_id, &t.project_name) {
                (Some(pid), _) => Some(projects::get(conn, pid)?.id),
                (None, Some(name)) => projects::find_by_name(conn, name)?.map(|p| p.id),
                (None, None) => None,
            }
            .or_else(|| code_project.as_ref().and_then(|c| c.project_id.clone()));
            // Learn the repo -> project link the first time the user files a Claude task.
            if let (Some(cp), Some(pid)) = (&code_project, &project_id)
                && cp.project_id.is_none()
            {
                code_projects::set_project(conn, &cp.id, Some(pid))?;
            }
            let ctx_md = s.context.as_ref().and_then(context_markdown);
            let notes = match (t.notes.clone(), ctx_md) {
                (Some(n), Some(c)) => Some(format!("{n}\n\n{c}")),
                (n, c) => n.or(c),
            };
            let input = TaskInput {
                title: t.title,
                description: t.description,
                notes,
                status: Some(TaskStatus::NotStarted),
                priority: t.priority.unwrap_or(0),
                due_date: t.due_date,
                due_time: t.due_time,
                scheduled_date: None,
                project_id,
                tags: t.tags,
            };
            let origin = TaskOrigin {
                source: Some(s.origin.source()),
                source_url: t.source_url,
                source_title: t.source_title,
                source_selection: t.source_selection,
                code_project_id: code_project.map(|c| c.id),
                ..Default::default()
            };
            let task = tasks::create(conn, &input, &origin, actor)?;
            crate::repo::history::record(
                conn,
                &task.id,
                s.origin.actor(),
                "suggested",
                None,
                None,
                Some(&s.id),
            )?;
            Approved {
                kind: s.kind,
                id: task.id,
            }
        }
        SuggestionKind::Note => {
            let n: NoteInput = serde_json::from_value(payload)
                .map_err(|e| AppError::invalid(format!("invalid note payload: {e}")))?;
            let note = notes::create(conn, &n, s.origin.source())?;
            Approved {
                kind: s.kind,
                id: note.id,
            }
        }
        SuggestionKind::TaskUpdate => {
            let target = s
                .target_task_id
                .clone()
                .ok_or_else(|| AppError::invalid("task_update needs targetTaskId"))?;
            let u: SuggestedUpdate = serde_json::from_value(payload)
                .map_err(|e| AppError::invalid(format!("invalid task_update payload: {e}")))?;
            check_update(&u)?;
            apply_update(conn, &target, &u, s.origin)?;
            Approved {
                kind: s.kind,
                id: target,
            }
        }
    };
    conn.execute(
        "UPDATE suggestions SET status = 'approved', resulting_id = ?2, decided_at = ?3 WHERE id = ?1",
        params![id, result.id, now_utc()],
    )?;
    Ok(result)
}

/// Apply an approved update. History records the suggesting client as the actor.
fn apply_update(conn: &Connection, id: &str, u: &SuggestedUpdate, origin: Origin) -> AppResult<()> {
    let actor = origin.actor();
    let t = tasks::get(conn, id)?;
    let mut input = tasks::to_input(&t);
    if let Some(title) = &u.title {
        input.title = title.clone();
    }
    if let Some(d) = &u.due_date {
        input.due_date = d.clone();
        if d.is_none() {
            input.due_time = None;
        }
    }
    if let Some(tm) = &u.due_time {
        input.due_time = tm.clone();
    }
    if let Some(p) = u.priority {
        input.priority = p;
    }
    if let Some(note) = u
        .append_note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
        let block = format!("**Update ({stamp}):** {note}");
        input.notes = Some(match input.notes.take() {
            Some(n) if !n.trim().is_empty() => format!("{n}\n\n{block}"),
            _ => block,
        });
    }
    tasks::update(conn, id, &input, actor)?;
    for title in &u.add_subtasks {
        let sub = TaskInput {
            title: title.clone(),
            ..Default::default()
        };
        let origin = TaskOrigin {
            parent_id: Some(id.to_string()),
            source: Some(origin.source()),
            ..Default::default()
        };
        tasks::create(conn, &sub, &origin, actor)?;
    }
    if let Some(status) = u.status {
        tasks::set_status(conn, id, status, false, actor)?;
    }
    Ok(())
}

pub fn dismiss(conn: &Connection, id: &str) -> AppResult<Suggestion> {
    let s = get(conn, id)?;
    if s.status != SuggestionStatus::Pending {
        return Err(AppError::Conflict(format!(
            "suggestion is already {}",
            s.status.as_str()
        )));
    }
    conn.execute(
        "UPDATE suggestions SET status = 'dismissed', decided_at = ?2 WHERE id = ?1",
        params![id, now_utc()],
    )?;
    get(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{ProjectInput, Source},
        repo::test_util::db,
    };
    use serde_json::json;

    fn chrome_task(title: &str, key: Option<&str>) -> NewSuggestion {
        NewSuggestion {
            kind: SuggestionKind::Task,
            origin: Origin::Chrome,
            target_task_id: None,
            payload: json!({
                "title": title,
                "description": "Request the updated SEPI teacher list",
                "dueDate": "2026-11-27",
                "sourceUrl": "https://mail.example.com/thread/1",
                "sourceTitle": "Inbox",
                "sourceSelection": "Follow up with Niamh about the updated SEPI teacher list before Friday."
            }),
            context: None,
            confidence: Some(json!({"dueDate": 0.6})),
            dedupe_key: key.map(str::to_string),
            captured_at: None,
        }
    }

    #[test]
    fn create_is_idempotent_on_dedupe_key() {
        let db = db();
        let a = db
            .write(|c| create(c, &chrome_task("Follow up with Niamh", Some("k1"))))
            .unwrap();
        let b = db
            .write(|c| create(c, &chrome_task("Follow up with Niamh", Some("k1"))))
            .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(db.read(|c| list(c, None, 50)).unwrap().len(), 1);
        assert_eq!(db.read(pending_counts).unwrap(), vec![(Origin::Chrome, 1)]);
        // Still idempotent after a decision (offline queue replay).
        db.write(|c| dismiss(c, &a.id)).unwrap();
        let c2 = db
            .write(|c| create(c, &chrome_task("Follow up with Niamh", Some("k1"))))
            .unwrap();
        assert_eq!(c2.id, a.id);
    }

    #[test]
    fn approve_creates_task_with_source_and_blocks_reapproval() {
        let db = db();
        let s = db
            .write(|c| create(c, &chrome_task("Follow up with Niamh", None)))
            .unwrap();
        let r = db.write(|c| approve(c, &s.id, None)).unwrap();
        let t = db.read(|c| tasks::get(c, &r.id)).unwrap();
        assert_eq!(t.source, Source::Chrome);
        assert_eq!(t.due_date.as_deref(), Some("2026-11-27"));
        assert_eq!(
            t.source_url.as_deref(),
            Some("https://mail.example.com/thread/1")
        );
        assert_eq!(t.status, TaskStatus::NotStarted);
        assert!(matches!(
            db.write(|c| approve(c, &s.id, None)),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(db.read(|c| get(c, &s.id)).unwrap().resulting_id, Some(r.id));
    }

    #[test]
    fn approve_with_edits_and_project_name() {
        let db = db();
        db.write(|c| {
            projects::create(
                c,
                &ProjectInput {
                    name: "Kinia – Administration".into(),
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let s = db
            .write(|c| create(c, &chrome_task("Follow up", None)))
            .unwrap();
        let edited =
            json!({"title": "Call Niamh", "projectName": "kinia – administration", "priority": 2});
        let r = db.write(|c| approve(c, &s.id, Some(edited))).unwrap();
        let t = db.read(|c| tasks::get(c, &r.id)).unwrap();
        assert_eq!(t.title, "Call Niamh");
        assert_eq!(t.priority, 2);
        assert!(t.project_id.is_some());
    }

    #[test]
    fn dismiss_creates_nothing() {
        let db = db();
        let s = db
            .write(|c| create(c, &chrome_task("Something", None)))
            .unwrap();
        db.write(|c| dismiss(c, &s.id)).unwrap();
        assert!(
            db.read(|c| tasks::list(c, &TaskFilter::default()))
                .unwrap()
                .is_empty()
        );
        assert!(db.write(|c| dismiss(c, &s.id)).is_err());
    }

    #[test]
    fn keeps_the_capture_time() {
        let db = db();
        let when = (chrono::Utc::now() - chrono::Duration::days(3))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let s = NewSuggestion {
            captured_at: Some(when.clone()),
            ..chrome_task("Queued on Friday", None)
        };
        assert_eq!(db.write(|c| create(c, &s)).unwrap().created_at, when);
        let future = NewSuggestion {
            captured_at: Some("2999-01-01T00:00:00Z".into()),
            ..chrome_task("x y", None)
        };
        assert!(db.write(|c| create(c, &future)).is_err());
    }

    #[test]
    fn rejects_bad_payloads() {
        let db = db();
        let mut bad = chrome_task(" ", None);
        assert!(db.write(|c| create(c, &bad)).is_err());
        bad = chrome_task("ok", None);
        bad.payload["dueDate"] = json!("Friday");
        assert!(db.write(|c| create(c, &bad)).is_err());
        bad = chrome_task("ok", None);
        bad.payload["sourceUrl"] = json!("javascript:alert(1)");
        assert!(db.write(|c| create(c, &bad)).is_err());
        let upd = NewSuggestion {
            kind: SuggestionKind::TaskUpdate,
            target_task_id: Some("missing".into()),
            payload: json!({}),
            ..chrome_task("x", None)
        };
        assert!(matches!(
            db.write(|c| create(c, &upd)),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn flags_possible_duplicate() {
        let db = db();
        let existing = db
            .write(|c| {
                tasks::create(
                    c,
                    &TaskInput {
                        title: "Follow up with Niamh about SEPI list".into(),
                        ..Default::default()
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let s = db
            .write(|c| {
                create(
                    c,
                    &chrome_task("Follow up with Niamh about the SEPI list", None),
                )
            })
            .unwrap();
        assert_eq!(s.possible_duplicate_of, Some(existing.id));
        let other = db
            .write(|c| create(c, &chrome_task("Book dentist", None)))
            .unwrap();
        assert_eq!(other.possible_duplicate_of, None);
    }

    #[test]
    fn approved_task_update_applies_only_given_fields() {
        let db = db();
        let t = db
            .write(|c| {
                tasks::create(
                    c,
                    &TaskInput {
                        title: "Finish educator profile".into(),
                        due_date: Some("2026-11-24".into()),
                        priority: 2,
                        ..Default::default()
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let upd = NewSuggestion {
            kind: SuggestionKind::TaskUpdate,
            origin: Origin::Claude,
            target_task_id: Some(t.id.clone()),
            payload: json!({ "dueDate": "2026-11-26", "appendNote": "Validation fixed; translations left." }),
            context: None,
            confidence: None,
            dedupe_key: None,
            captured_at: None,
        };
        let s = db.write(|c| create(c, &upd)).unwrap();
        // Nothing changes until approval.
        assert_eq!(
            db.read(|c| tasks::get(c, &t.id))
                .unwrap()
                .due_date
                .as_deref(),
            Some("2026-11-24")
        );
        db.write(|c| approve(c, &s.id, None)).unwrap();
        let after = db.read(|c| tasks::get(c, &t.id)).unwrap();
        assert_eq!(after.due_date.as_deref(), Some("2026-11-26"));
        assert_eq!(after.priority, 2);
        assert!(after.notes.unwrap().contains("Validation fixed"));
        let hist = db.read(|c| crate::repo::history::list(c, &t.id)).unwrap();
        assert!(
            hist.iter()
                .any(|h| h.actor == Actor::Claude && h.field.as_deref() == Some("due_date"))
        );

        let done = NewSuggestion {
            payload: json!({ "status": "completed" }),
            ..upd.clone()
        };
        let s = db.write(|c| create(c, &done)).unwrap();
        db.write(|c| approve(c, &s.id, None)).unwrap();
        assert_eq!(
            db.read(|c| tasks::get(c, &t.id)).unwrap().status,
            TaskStatus::Completed
        );

        let junk = NewSuggestion {
            payload: json!({ "delete": true }),
            ..upd.clone()
        };
        assert!(
            db.write(|c| create(c, &junk)).is_err(),
            "unknown fields refused"
        );
        let empty = NewSuggestion {
            payload: json!({}),
            ..upd
        };
        assert!(db.write(|c| create(c, &empty)).is_err());
    }

    #[test]
    fn spooled_claude_task_resolves_its_repo() {
        let db = db();
        let s = NewSuggestion {
            kind: SuggestionKind::Task,
            origin: Origin::Claude,
            target_task_id: None,
            payload: json!({ "title": "Finish profile page", "repo": { "rootDir": "C:\\Code\\Edu", "name": "edu" } }),
            context: None,
            confidence: None,
            dedupe_key: None,
            captured_at: None,
        };
        let created = db.write(|c| create(c, &s)).unwrap();
        assert!(created.payload.get("repo").is_none());
        let cp = created.payload["codeProjectId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(db.read(|c| code_projects::get(c, &cp)).unwrap().name, "edu");
        let bogus = NewSuggestion {
            payload: json!({ "title": "Finish profile page", "codeProjectId": "nope" }),
            ..s
        };
        assert!(db.write(|c| create(c, &bogus)).is_err());
    }

    #[test]
    fn approved_breakdown_adds_subtasks() {
        let db = db();
        let t = db
            .write(|c| {
                tasks::create(
                    c,
                    &TaskInput {
                        title: "Finish profile".into(),
                        ..Default::default()
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let s = NewSuggestion {
            kind: SuggestionKind::TaskUpdate,
            origin: Origin::Claude,
            target_task_id: Some(t.id.clone()),
            payload: json!({ "addSubtasks": ["Fix validation", "Test Irish translations"] }),
            context: None,
            confidence: None,
            dedupe_key: None,
            captured_at: None,
        };
        let s = db.write(|c| create(c, &s)).unwrap();
        assert_eq!(
            db.read(|c| tasks::get(c, &t.id)).unwrap().subtask_count,
            0,
            "nothing before approval"
        );
        db.write(|c| approve(c, &s.id, None)).unwrap();
        assert_eq!(db.read(|c| tasks::get(c, &t.id)).unwrap().subtask_count, 2);
    }

    #[test]
    fn claude_task_links_repo_and_learns_project() {
        let db = db();
        let p = db
            .write(|c| {
                projects::create(
                    c,
                    &ProjectInput {
                        name: "Educator platform".into(),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        let cp = db
            .write(|c| {
                code_projects::resolve(
                    c,
                    &code_projects::ResolveInput {
                        root_dir: r"C:\Code\Educator".into(),
                        name: None,
                        git_remote: None,
                    },
                )
            })
            .unwrap();
        let mk = |project: serde_json::Value| NewSuggestion {
            kind: SuggestionKind::Task,
            origin: Origin::Claude,
            target_task_id: None,
            payload: json!({ "title": "Finish profile", "codeProjectId": cp.id, "projectId": project }),
            context: None,
            confidence: None,
            dedupe_key: None,
            captured_at: None,
        };
        let s = db.write(|c| create(c, &mk(json!(p.id)))).unwrap();
        let r = db.write(|c| approve(c, &s.id, None)).unwrap();
        let t = db.read(|c| tasks::get(c, &r.id)).unwrap();
        assert_eq!(t.code_project_id.as_deref(), Some(cp.id.as_str()));
        // The repo now maps to the project, so the next task needs no project.
        let s2 = db
            .write(|c| create(c, &mk(serde_json::Value::Null)))
            .unwrap();
        let r2 = db.write(|c| approve(c, &s2.id, None)).unwrap();
        assert_eq!(
            db.read(|c| tasks::get(c, &r2.id)).unwrap().project_id,
            Some(p.id)
        );
    }

    #[test]
    fn context_renders_as_markdown_in_notes() {
        let db = db();
        let s = NewSuggestion {
            origin: Origin::Claude,
            context: Some(json!({
                "completed": ["Profile form"],
                "remaining": ["Fix validation", "Test Irish translations"],
                "resumeHint": "apps/web/src/profile.tsx"
            })),
            ..chrome_task("Finish educator profile", None)
        };
        let s = db.write(|c| create(c, &s)).unwrap();
        let r = db.write(|c| approve(c, &s.id, None)).unwrap();
        let t = db.read(|c| tasks::get(c, &r.id)).unwrap();
        let notes = t.notes.unwrap();
        assert!(notes.contains("**Remaining**\n- Fix validation"), "{notes}");
        assert!(
            notes.contains("**Resume hint:** apps/web/src/profile.tsx"),
            "{notes}"
        );
        assert_eq!(t.source, Source::Claude);
    }
}
