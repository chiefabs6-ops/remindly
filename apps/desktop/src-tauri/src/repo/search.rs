//! Search helpers + combined task/note search.

use rusqlite::Connection;
use serde::Serialize;

use crate::{
    error::AppResult,
    model::{Note, NoteFilter, Project, Task, TaskFilter},
    repo::{notes, projects, tasks},
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
    /// Projects whose name contains the query (not archived).
    pub projects: Vec<Project>,
}

pub fn search_all(conn: &Connection, query: &str, limit: u32) -> AppResult<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults {
            tasks: vec![],
            notes: vec![],
            projects: vec![],
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
    let needle = q.to_lowercase();
    let projects = projects::list(conn, false)?
        .into_iter()
        .filter(|p| p.name.to_lowercase().contains(&needle))
        .take(limit as usize)
        .collect();
    Ok(SearchResults {
        tasks,
        notes,
        projects,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_projects_by_name() {
        let db = crate::repo::test_util::db();
        db.write(|c| {
            crate::repo::projects::create(
                c,
                &crate::model::ProjectInput {
                    name: "Kinia Website".into(),
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let r = db.read(|c| search_all(c, "website", 10)).unwrap();
        assert_eq!(r.projects.len(), 1);
        assert_eq!(r.projects[0].name, "Kinia Website");
        assert!(
            db.read(|c| search_all(c, "zzz", 10))
                .unwrap()
                .projects
                .is_empty()
        );
    }

    #[test]
    fn escaping() {
        assert_eq!(fts_phrase(r#"say "hi" OR x"#), r#""say ""hi"" OR x""#);
        assert_eq!(like_pattern("50%_off"), r"%50\%\_off%");
        assert!(!uses_fts("ab"));
        assert!(uses_fts("abc"));
    }
}
