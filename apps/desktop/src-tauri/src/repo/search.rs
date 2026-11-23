//! Search helpers + combined task/note search.

use rusqlite::Connection;
use serde::Serialize;

use crate::{
    error::AppResult,
    model::{Note, NoteFilter, Task, TaskFilter},
    repo::{notes, tasks},
};

/// Trigram FTS needs at least 3 characters; shorter queries fall back to LIKE.
pub const FTS_MIN_CHARS: usize = 3;

/// Quote user text as one FTS5 phrase so operators/quotes in it are literal.
pub fn fts_phrase(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// `%q%` with LIKE wildcards escaped (use with `ESCAPE '\'`).
pub fn like_pattern(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn uses_fts(q: &str) -> bool {
    q.chars().count() >= FTS_MIN_CHARS
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub tasks: Vec<Task>,
    pub notes: Vec<Note>,
}

pub fn search_all(conn: &Connection, query: &str, limit: u32) -> AppResult<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults {
            tasks: vec![],
            notes: vec![],
        });
    }
    let tasks = tasks::list(
        conn,
        &TaskFilter {
            query: Some(q.to_string()),
            limit: Some(limit),
            ..Default::default()
        },
    )?;
    let notes = notes::list(
        conn,
        &NoteFilter {
            query: Some(q.to_string()),
            limit: Some(limit),
            ..Default::default()
        },
    )?;
    Ok(SearchResults { tasks, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping() {
        assert_eq!(fts_phrase(r#"say "hi" OR x"#), r#""say ""hi"" OR x""#);
        assert_eq!(like_pattern("50%_off"), r"%50\%\_off%");
        assert!(!uses_fts("ab"));
        assert!(uses_fts("abc"));
    }
}
