//! Claude Code repositories ("code projects"): a folder on disk, optionally mapped to a Tether project.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    model::{Origin, Project, SuggestionStatus, Task, new_id, now_utc},
    repo::{projects, suggestions, tasks},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeProject {
    pub id: String,
    pub root_dir: String,
    pub name: String,
    pub git_remote: Option<String>,
    pub project_id: Option<String>,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    pub root_dir: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub git_remote: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub code_project: CodeProject,
    pub project: Option<Project>,
    pub open_tasks: Vec<Task>,
    pub pending_suggestions: Vec<crate::model::Suggestion>,
}

fn from_row(r: &Row) -> rusqlite::Result<CodeProject> {
    Ok(CodeProject {
        id: r.get(0)?,
        root_dir: r.get(1)?,
        name: r.get(2)?,
        git_remote: r.get(3)?,
        project_id: r.get(4)?,
        last_seen_at: r.get(5)?,
    })
}

const COLS: &str = "id, root_dir, name, git_remote, project_id, last_seen_at";

/// Folder paths compare case-insensitively on Windows and ignore a trailing separator.
pub fn normalize_dir(dir: &str) -> AppResult<String> {
    let d = dir.trim().trim_end_matches(['\\', '/']).replace('/', "\\");
    let looks_absolute = d.len() >= 2 && (d.as_bytes()[1] == b':' || d.starts_with("\\\\"));
    if !looks_absolute || d.len() > 1024 || d.contains('\0') {
        return Err(AppError::invalid("rootDir must be an absolute folder path"));
    }
    Ok(d)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<CodeProject> {
    conn.query_row(
        &format!("SELECT {COLS} FROM code_projects WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("code project".into()))
}

pub fn list(conn: &Connection) -> AppResult<Vec<CodeProject>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM code_projects ORDER BY last_seen_at DESC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Find or create the code project for a folder; refreshes its name, remote and last-seen time.
pub fn resolve(conn: &Connection, input: &ResolveInput) -> AppResult<CodeProject> {
    let dir = normalize_dir(&input.root_dir)?;
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(200).collect::<String>())
        .unwrap_or_else(|| dir.rsplit('\\').next().unwrap_or(&dir).to_string());
    let remote = input
        .git_remote
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| r.chars().take(500).collect::<String>());
    let now = now_utc();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM code_projects WHERE root_dir = ?1 COLLATE NOCASE",
            [&dir],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE code_projects SET name = ?2, git_remote = coalesce(?3, git_remote),
                    last_seen_at = ?4 WHERE id = ?1",
                params![id, name, remote, now],
            )?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO code_projects(id, root_dir, name, git_remote, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, dir, name, remote, now],
            )?;
            id
        }
    };
    get(conn, &id)
}

/// Link a code project to a Tether project (or unlink with `None`).
pub fn set_project(
    conn: &Connection,
    id: &str,
    project_id: Option<&str>,
) -> AppResult<CodeProject> {
    if let Some(pid) = project_id {
        projects::get(conn, pid)?;
    }
    if conn.execute(
        "UPDATE code_projects SET project_id = ?2 WHERE id = ?1",
        params![id, project_id],
    )? == 0
    {
        return Err(AppError::NotFound("code project".into()));
    }
    get(conn, id)
}

/// Everything Claude Code needs before suggesting: the mapped project, open tasks for this repo
/// (or its project), and Claude suggestions still waiting for approval.
pub fn context(conn: &Connection, input: &ResolveInput) -> AppResult<ProjectContext> {
    let cp = resolve(conn, input)?;
    let project = match &cp.project_id {
        Some(pid) => projects::get(conn, pid).ok(),
        None => None,
    };
    let open: Vec<Task> = {
        let sql = format!(
            "SELECT {} FROM tasks t WHERE t.deleted_at IS NULL AND t.parent_id IS NULL
               AND t.status NOT IN ('completed','archived')
               AND (t.code_project_id = ?1 OR (?2 IS NOT NULL AND t.project_id = ?2))
             {} LIMIT 25",
            tasks::COLS,
            tasks::ORDER
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map(params![cp.id, cp.project_id], tasks::from_row)?
            .collect::<Result<_, _>>()?
    };
    let pending = suggestions::list(conn, Some(SuggestionStatus::Pending), 50)?
        .into_iter()
        .filter(|s| s.origin == Origin::Claude)
        .filter(|s| {
            s.payload.get("codeProjectId").and_then(|v| v.as_str()) == Some(cp.id.as_str())
                || s.target_task_id
                    .as_ref()
                    .is_some_and(|t| open.iter().any(|o| &o.id == t))
        })
        .take(10)
        .collect();
    Ok(ProjectContext {
        code_project: cp,
        project,
        open_tasks: open,
        pending_suggestions: pending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Actor, ProjectInput, TaskInput, TaskOrigin},
        repo::test_util::db,
    };

    fn input(dir: &str) -> ResolveInput {
        ResolveInput {
            root_dir: dir.into(),
            name: None,
            git_remote: Some("https://github.com/acme/educator.git".into()),
        }
    }

    #[test]
    fn resolve_is_stable_across_case_and_slashes() {
        let db = db();
        let a = db
            .write(|c| resolve(c, &input(r"C:\Code\Educator")))
            .unwrap();
        let b = db
            .write(|c| resolve(c, &input("c:/code/educator/")))
            .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.name, "Educator");
        assert!(db.write(|c| resolve(c, &input("relative/path"))).is_err());
    }

    #[test]
    fn context_lists_repo_and_project_tasks() {
        let db = db();
        let cp = db
            .write(|c| resolve(c, &input(r"C:\Code\Educator")))
            .unwrap();
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
        db.write(|c| set_project(c, &cp.id, Some(&p.id))).unwrap();
        let mk = |title: &str, project: Option<String>, code: Option<String>| {
            db.write(|c| {
                tasks::create(
                    c,
                    &TaskInput {
                        title: title.into(),
                        project_id: project,
                        ..Default::default()
                    },
                    &TaskOrigin {
                        code_project_id: code,
                        ..Default::default()
                    },
                    Actor::User,
                )
            })
            .unwrap()
        };
        mk("from repo", None, Some(cp.id.clone()));
        mk("from project", Some(p.id.clone()), None);
        mk("unrelated", None, None);
        let ctx = db
            .write(|c| context(c, &input(r"C:\Code\Educator")))
            .unwrap();
        let titles: Vec<_> = ctx.open_tasks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles.len(), 2);
        assert!(titles.contains(&"from repo") && titles.contains(&"from project"));
        assert_eq!(ctx.project.unwrap().name, "Educator platform");
    }
}
