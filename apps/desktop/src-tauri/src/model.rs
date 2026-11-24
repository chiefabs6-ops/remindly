//! Domain types shared by commands and the HTTP API. JSON uses camelCase.

use chrono::{NaiveDate, NaiveTime, SecondsFormat, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Declares a string-backed enum that round-trips through JSON (snake_case) and SQLite (TEXT).
macro_rules! str_enum {
    ($name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $s),+ }
            }
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some($name::$variant),)+ _ => None }
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(ToSqlOutput::from(self.as_str()))
            }
        }

        impl FromSql for $name {
            fn column_result(v: ValueRef<'_>) -> FromSqlResult<Self> {
                let s = v.as_str()?;
                $name::parse(s).ok_or_else(|| FromSqlError::Other(
                    format!("invalid {} value {s:?}", stringify!($name)).into()))
            }
        }
    };
}

str_enum!(TaskStatus {
    Inbox => "inbox",
    NotStarted => "not_started",
    InProgress => "in_progress",
    Waiting => "waiting",
    Completed => "completed",
    Archived => "archived",
});

str_enum!(Source {
    Manual => "manual",
    Chrome => "chrome",
    Claude => "claude",
    Note => "note",
    Ai => "ai",
});

str_enum!(NoteKind {
    General => "general",
    Meeting => "meeting",
    Idea => "idea",
    Research => "research",
    Work => "work",
});

str_enum!(SuggestionKind {
    Task => "task",
    TaskUpdate => "task_update",
    Note => "note",
});

str_enum!(Origin {
    Chrome => "chrome",
    Claude => "claude",
    Ai => "ai",
    Note => "note",
});

str_enum!(SuggestionStatus {
    Pending => "pending",
    Approved => "approved",
    Dismissed => "dismissed",
});

str_enum!(Actor {
    User => "user",
    Claude => "claude",
    Chrome => "chrome",
    System => "system",
    Ai => "ai",
});

impl Origin {
    pub fn source(self) -> Source {
        match self {
            Origin::Chrome => Source::Chrome,
            Origin::Claude => Source::Claude,
            Origin::Ai => Source::Ai,
            Origin::Note => Source::Note,
        }
    }

    pub fn actor(self) -> Actor {
        match self {
            Origin::Chrome => Actor::Chrome,
            Origin::Claude => Actor::Claude,
            Origin::Ai => Actor::Ai,
            Origin::Note => Actor::System,
        }
    }
}

// ---------- entities ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub parent_id: Option<String>,
    pub project_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub status: TaskStatus,
    pub priority: u8,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub scheduled_date: Option<String>,
    pub source: Source,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub source_selection: Option<String>,
    pub code_project_id: Option<String>,
    pub note_id: Option<String>,
    pub sort_order: f64,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub tags: Vec<String>,
    pub subtask_count: i64,
    pub subtask_done: i64,
    /// None = the app default; minutes before the due time; -1 = the morning of the due day.
    pub reminder_lead: Option<i64>,
    /// Once overdue, remind every working day at the start of work until done.
    pub reminder_repeat: bool,
    /// Context from an approved Claude suggestion (said / completed / remaining / why / resumeHint).
    pub claude_context: Option<serde_json::Value>,
    /// One-off "remind me at…" time set on the task, not yet shown (RFC 3339 UTC). Extra to the others.
    pub next_reminder: Option<String>,
    /// Snoozed from a notification until this time (RFC 3339 UTC): the task's other reminders wait until then.
    pub snoozed_until: Option<String>,
    /// Repeats: completing it creates the next copy, due `every` x `unit` after the completion date.
    pub repeat: Option<Repeat>,
    /// The copy made when this task was last completed (if any).
    pub repeat_next_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RepeatUnit {
    Day,
    /// Working day (Monday to Friday).
    Weekday,
    Week,
    Month,
}

impl RepeatUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            RepeatUnit::Day => "day",
            RepeatUnit::Weekday => "weekday",
            RepeatUnit::Week => "week",
            RepeatUnit::Month => "month",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "day" => Some(RepeatUnit::Day),
            "weekday" => Some(RepeatUnit::Weekday),
            "week" => Some(RepeatUnit::Week),
            "month" => Some(RepeatUnit::Month),
            _ => None,
        }
    }
}

/// "Every 2 weeks" = `Repeat { every: 2, unit: Week }`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    pub every: u32,
    pub unit: RepeatUnit,
}

impl Repeat {
    pub const MAX_EVERY: u32 = 365;

    /// Plain words for history: "every day", "every 2 weeks", "every working day".
    pub fn label(self) -> String {
        let unit = match self.unit {
            RepeatUnit::Weekday => "working day",
            u => u.as_str(),
        };
        if self.every == 1 {
            format!("every {unit}")
        } else {
            format!("every {} {unit}s", self.every)
        }
    }

    /// The due date of the next copy, counted from `from` (the completion date).
    pub fn next_due(self, from: NaiveDate) -> NaiveDate {
        use chrono::{Datelike, Days, Months, Weekday};
        let n = self.every.clamp(1, Self::MAX_EVERY);
        match self.unit {
            RepeatUnit::Day => from + Days::new(n as u64),
            RepeatUnit::Week => from + Days::new(7 * n as u64),
            // Adds months and keeps the day where it can (31 Jan + 1 month = 28/29 Feb).
            RepeatUnit::Month => from
                .checked_add_months(Months::new(n))
                .unwrap_or(from + Days::new(30 * n as u64)),
            RepeatUnit::Weekday => {
                let mut d = from;
                let mut left = n;
                while left > 0 {
                    d = d + Days::new(1);
                    if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                        left -= 1;
                    }
                }
                d
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    #[serde(flatten)]
    pub task: Task,
    pub subtasks: Vec<Task>,
    pub history: Vec<HistoryEntry>,
    pub links: Vec<TaskLink>,
}

/// A web link the user attached to a task (http/https only).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    pub id: String,
    pub task_id: String,
    pub url: String,
    pub title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub at: String,
    pub actor: Actor,
    pub action: String,
    pub field: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
}

/// Fields the user (or an approved suggestion) can set on a task.
/// Used for both create and full update (PUT semantics: absent optional = cleared).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskInput {
    pub title: String,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: u8,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub scheduled_date: Option<String>,
    pub project_id: Option<String>,
    pub tags: Vec<String>,
}

/// Extra fields that can only be set when a task is created.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskOrigin {
    pub parent_id: Option<String>,
    pub source: Option<Source>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub source_selection: Option<String>,
    pub code_project_id: Option<String>,
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFilter {
    pub statuses: Vec<TaskStatus>,
    pub project_id: Option<String>,
    /// Only tasks without a project.
    pub no_project: bool,
    pub tag: Option<String>,
    pub parent_id: Option<String>,
    /// Exclude subtasks (default for lists).
    pub top_level_only: bool,
    pub due_from: Option<String>,
    pub due_to: Option<String>,
    pub query: Option<String>,
    pub source: Option<Source>,
    pub include_deleted: bool,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub sort_order: f64,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub open_tasks: i64,
    /// Top-level tasks completed in the last 30 days.
    pub done_recent: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectInput {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub usage: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub title: String,
    pub body_md: String,
    pub kind: NoteKind,
    pub source: Source,
    pub source_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteInput {
    pub title: String,
    pub body_md: String,
    pub kind: Option<NoteKind>,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub tags: Vec<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteFilter {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub kind: Option<NoteKind>,
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub kind: SuggestionKind,
    pub origin: Origin,
    pub target_task_id: Option<String>,
    pub payload: serde_json::Value,
    pub context: Option<serde_json::Value>,
    pub confidence: Option<serde_json::Value>,
    pub dedupe_key: Option<String>,
    pub possible_duplicate_of: Option<String>,
    pub status: SuggestionStatus,
    pub resulting_id: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSuggestion {
    pub kind: SuggestionKind,
    pub origin: Origin,
    #[serde(default)]
    pub target_task_id: Option<String>,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    #[serde(default)]
    pub confidence: Option<serde_json::Value>,
    /// Client-chosen idempotency key: re-sending the same pending suggestion returns the original.
    #[serde(default)]
    pub dedupe_key: Option<String>,
    /// When the user captured it (RFC 3339). Queued captures keep their real time.
    #[serde(default)]
    pub captured_at: Option<String>,
}

/// Payload of a `task` suggestion.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SuggestedTask {
    pub title: String,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub priority: Option<u8>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub tags: Vec<String>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub source_selection: Option<String>,
    /// Set by the Claude Code integration (from /v1/code-projects/resolve).
    pub code_project_id: Option<String>,
}

/// Payload of a `task_update` suggestion: only the fields present are changed.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestedUpdate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    /// `Some(None)` clears the date; absent leaves it.
    #[serde(default, deserialize_with = "some_or_null")]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_or_null")]
    pub due_time: Option<Option<String>>,
    #[serde(default)]
    pub priority: Option<u8>,
    /// Progress note appended to the task's notes.
    #[serde(default)]
    pub append_note: Option<String>,
    /// Subtasks to create under the task (e.g. a breakdown from Claude Code).
    #[serde(default)]
    pub add_subtasks: Vec<String>,
}

fn some_or_null<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

// ---------- helpers ----------

pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// UTC timestamp, fixed format so strings sort chronologically.
pub fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub const MAX_TITLE: usize = 500;
pub const MAX_TEXT: usize = 100_000;

pub fn clean_title(title: &str) -> AppResult<String> {
    let t = title.trim();
    if t.is_empty() {
        return Err(AppError::invalid("title is required"));
    }
    if t.chars().count() > MAX_TITLE {
        return Err(AppError::invalid(format!(
            "title is longer than {MAX_TITLE} characters"
        )));
    }
    Ok(t.to_string())
}

/// Trims; empty becomes None; enforces a size cap.
pub fn clean_text(field: &str, v: &Option<String>) -> AppResult<Option<String>> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if s.len() > MAX_TEXT => Err(AppError::invalid(format!("{field} is too long"))),
        Some(s) => Ok(Some(s.to_string())),
    }
}

pub fn clean_date(field: &str, v: &Option<String>) -> AppResult<Option<String>> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .map_err(|_| AppError::invalid(format!("{field} must be YYYY-MM-DD"))),
    }
}

pub fn clean_time(field: &str, v: &Option<String>) -> AppResult<Option<String>> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => NaiveTime::parse_from_str(s, "%H:%M")
            .map(|t| Some(t.format("%H:%M").to_string()))
            .map_err(|_| AppError::invalid(format!("{field} must be HH:MM"))),
    }
}

pub fn clean_priority(p: u8) -> AppResult<u8> {
    if p > 3 {
        return Err(AppError::invalid("priority must be 0-3"));
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_round_trip() {
        for s in [
            "inbox",
            "not_started",
            "in_progress",
            "waiting",
            "completed",
            "archived",
        ] {
            assert_eq!(TaskStatus::parse(s).unwrap().as_str(), s);
        }
        assert_eq!(
            serde_json::to_string(&TaskStatus::NotStarted).unwrap(),
            "\"not_started\""
        );
        assert!(TaskStatus::parse("done").is_none());
    }

    #[test]
    fn validation_helpers() {
        assert!(clean_title("   ").is_err());
        assert_eq!(clean_title("  hi ").unwrap(), "hi");
        assert!(clean_title(&"x".repeat(501)).is_err());
        assert_eq!(
            clean_date("d", &Some("2026-02-03".into())).unwrap(),
            Some("2026-02-03".into())
        );
        assert!(clean_date("d", &Some("2026-02-30".into())).is_err());
        assert!(clean_date("d", &Some("tomorrow".into())).is_err());
        assert_eq!(clean_date("d", &Some(" ".into())).unwrap(), None);
        assert_eq!(
            clean_time("t", &Some("9:05".into())).unwrap(),
            Some("09:05".into())
        );
        assert!(clean_time("t", &Some("25:00".into())).is_err());
        assert!(clean_priority(4).is_err());
        assert!(now_utc().ends_with('Z'));
    }
}
