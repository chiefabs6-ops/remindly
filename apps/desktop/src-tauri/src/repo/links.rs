//! Links the user attached to a task, and short written updates in its activity log.

use rusqlite::{Connection, params};

use crate::{
    error::{AppError, AppResult},
    model::{Actor, TaskLink, new_id, now_utc},
    repo::{history, tasks},
};

const MAX_URL: usize = 2048;
const MAX_TITLE: usize = 300;
const MAX_COMMENT: usize = 2000;

/// Only plain web links: `http://` or `https://`, no spaces or control characters.
/// Anything else (`javascript:`, `file:`, `data:` …) is refused so the UI can never open it.
pub fn clean_url(raw: &str) -> AppResult<String> {
    let url = raw.trim();
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| AppError::invalid("link must start with http:// or https://"))?;
    if rest.is_empty() || rest.starts_with('/') {
        return Err(AppError::invalid("link has no host"));
    }
    if url.len() > MAX_URL {
        return Err(AppError::invalid("link is too long"));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::invalid("link must not contain spaces"));
    }
    Ok(url.to_string())
}

pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<TaskLink>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, url, title, created_at FROM task_links
         WHERE task_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        Ok(TaskLink {
            id: r.get(0)?,
            task_id: r.get(1)?,
            url: r.get(2)?,
            title: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn add(
    conn: &Connection,
    task_id: &str,
    url: &str,
    title: Option<&str>,
    actor: Actor,
) -> AppResult<TaskLink> {
    tasks::get(conn, task_id)?;
    let url = clean_url(url)?;
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(MAX_TITLE).collect::<String>());
    let link = TaskLink {
        id: new_id(),
        task_id: task_id.to_string(),
        url,
        title,
        created_at: now_utc(),
    };
    conn.execute(
        "INSERT INTO task_links(id, task_id, url, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![link.id, link.task_id, link.url, link.title, link.created_at],
    )?;
    history::record(
        conn,
        task_id,
        actor,
        "link_added",
        None,
        None,
        Some(&link.url),
    )?;
    touch(conn, task_id)?;
    Ok(link)
}

pub fn remove(conn: &Connection, link_id: &str, actor: Actor) -> AppResult<()> {
    let (task_id, url): (String, String) = conn
        .query_row(
            "SELECT task_id, url FROM task_links WHERE id = ?1",
            [link_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("link".into()),
            e => e.into(),
        })?;
    conn.execute("DELETE FROM task_links WHERE id = ?1", [link_id])?;
    history::record(
        conn,
        &task_id,
        actor,
        "link_removed",
        None,
        Some(&url),
        None,
    )?;
    touch(conn, &task_id)?;
    Ok(())
}

/// A written update ("waiting on Sinéad") kept in the task's activity log.
pub fn comment(conn: &Connection, task_id: &str, text: &str, actor: Actor) -> AppResult<()> {
    tasks::get(conn, task_id)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::invalid("update is empty"));
    }
    if text.chars().count() > MAX_COMMENT {
        return Err(AppError::invalid(
            "update is too long (2000 characters max)",
        ));
    }
    history::record(conn, task_id, actor, "comment", None, None, Some(text))?;
    touch(conn, task_id)?;
    Ok(())
}

fn touch(conn: &Connection, task_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE tasks SET updated_at = ?2 WHERE id = ?1",
        params![task_id, now_utc()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{TaskInput, TaskOrigin},
        repo::test_util::db,
    };

    fn task(c: &Connection) -> String {
        let input = TaskInput {
            title: "Fix the Zap".into(),
            ..Default::default()
        };
        tasks::create(c, &input, &TaskOrigin::default(), Actor::User)
            .unwrap()
            .id
    }

    #[test]
    fn url_rules() {
        assert_eq!(
            clean_url("  https://zapier.com/x ").unwrap(),
            "https://zapier.com/x"
        );
        assert!(clean_url("HTTP://Example.com").is_ok());
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/html,hi",
            "https://",
            "https:///path",
            "https://a b.com",
            "mail.google.com",
            "",
        ] {
            assert!(clean_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn add_list_remove_with_history() {
        let db = db();
        db.write(|c| {
            let id = task(c);
            let l = add(
                c,
                &id,
                "https://mail.google.com/x",
                Some("  Alert  "),
                Actor::User,
            )?;
            assert_eq!(l.title.as_deref(), Some("Alert"));
            assert_eq!(list(c, &id)?.len(), 1);
            remove(c, &l.id, Actor::User)?;
            assert!(list(c, &id)?.is_empty());
            let h = history::list(c, &id)?;
            let actions: Vec<_> = h.iter().map(|e| e.action.as_str()).collect();
            assert!(actions.contains(&"link_added") && actions.contains(&"link_removed"));
            assert!(matches!(
                remove(c, &l.id, Actor::User),
                Err(AppError::NotFound(_))
            ));
            assert!(add(c, &id, "javascript:alert(1)", None, Actor::User).is_err());
            assert!(add(c, "nope", "https://a.com", None, Actor::User).is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn comments_are_trimmed_and_bounded() {
        let db = db();
        db.write(|c| {
            let id = task(c);
            comment(c, &id, "  waiting on Sinéad ", Actor::User)?;
            let h = history::list(c, &id)?;
            assert_eq!(h[0].action, "comment");
            assert_eq!(h[0].new_value.as_deref(), Some("waiting on Sinéad"));
            assert!(comment(c, &id, "   ", Actor::User).is_err());
            assert!(comment(c, &id, &"x".repeat(2001), Actor::User).is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn links_go_with_their_task() {
        let db = db();
        db.write(|c| {
            let id = task(c);
            add(c, &id, "https://a.com", None, Actor::User)?;
            c.execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
            let n: i64 = c.query_row("SELECT count(*) FROM task_links", [], |r| r.get(0))?;
            assert_eq!(n, 0);
            Ok(())
        })
        .unwrap();
    }
}
