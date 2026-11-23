use rusqlite::{Connection, OptionalExtension, Row, ToSql, params, params_from_iter};

use crate::{
    error::{AppError, AppResult},
    model::{
        Actor, MAX_TEXT, Note, NoteFilter, NoteInput, NoteKind, Source, Task, TaskInput,
        TaskOrigin, clean_text, new_id, now_utc,
    },
    repo::{search, tags, tasks},
};

const COLS: &str = "n.id, n.project_id, n.task_id, n.title, n.body_md, n.kind, n.source,
    n.source_url, n.created_at, n.updated_at, n.deleted_at,
    (SELECT group_concat(g.name, char(31)) FROM note_tags nt JOIN tags g ON g.id = nt.tag_id
        WHERE nt.note_id = n.id)";

fn from_row(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        project_id: r.get(1)?,
        task_id: r.get(2)?,
        title: r.get(3)?,
        body_md: r.get(4)?,
        kind: r.get(5)?,
        source: r.get(6)?,
        source_url: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        deleted_at: r.get(10)?,
        tags: tags::split_joined(r.get(11)?),
    })
}

fn validate(input: &NoteInput) -> AppResult<(String, String)> {
    let title = input.title.trim().to_string();
    let body = input.body_md.trim_end().to_string();
    if title.is_empty() && body.trim().is_empty() {
        return Err(AppError::invalid("a note needs a title or some text"));
    }
    if title.chars().count() > 500 {
        return Err(AppError::invalid("title is longer than 500 characters"));
    }
    if body.len() > MAX_TEXT {
        return Err(AppError::invalid("note is too long"));
    }
    Ok((title, body))
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Note> {
    conn.query_row(
        &format!("SELECT {COLS} FROM notes n WHERE n.id = ?1 AND n.deleted_at IS NULL"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("note".into()))
}

pub fn create(conn: &Connection, input: &NoteInput, source: Source) -> AppResult<Note> {
    let (title, body) = validate(input)?;
    let id = new_id();
    let now = now_utc();
    conn.execute(
        "INSERT INTO notes(id, project_id, task_id, title, body_md, kind, source, source_url,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            clean_text("project", &input.project_id)?,
            clean_text("task", &input.task_id)?,
            title,
            body,
            input.kind.unwrap_or(NoteKind::General),
            source,
            clean_text("source url", &input.source_url)?,
            now
        ],
    )?;
    tags::set_for_note(conn, &id, &input.tags)?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: &NoteInput) -> AppResult<Note> {
    let (title, body) = validate(input)?;
    let old = get(conn, id)?;
    conn.execute(
        "UPDATE notes SET project_id = ?2, task_id = ?3, title = ?4, body_md = ?5, kind = ?6,
            source_url = ?7, updated_at = ?8
         WHERE id = ?1",
        params![
            id,
            clean_text("project", &input.project_id)?,
            clean_text("task", &input.task_id)?,
            title,
            body,
            input.kind.unwrap_or(old.kind),
            clean_text("source url", &input.source_url)?,
            now_utc()
        ],
    )?;
    tags::set_for_note(conn, id, &input.tags)?;
    get(conn, id)
}

pub fn soft_delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE notes SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now_utc()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("note".into()));
    }
    Ok(())
}

pub fn list(conn: &Connection, f: &NoteFilter) -> AppResult<Vec<Note>> {
    let mut wheres = vec!["n.deleted_at IS NULL".to_string()];
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    fn push(args: &mut Vec<Box<dyn ToSql>>, v: Box<dyn ToSql>) -> String {
        args.push(v);
        format!("?{}", args.len())
    }
    if let Some(p) = &f.project_id {
        let a = push(&mut args, Box::new(p.clone()));
        wheres.push(format!("n.project_id = {a}"));
    }
    if let Some(t) = &f.task_id {
        let a = push(&mut args, Box::new(t.clone()));
        wheres.push(format!("n.task_id = {a}"));
    }
    if let Some(k) = f.kind {
        let a = push(&mut args, Box::new(k));
        wheres.push(format!("n.kind = {a}"));
    }
    if let Some(q) = f.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        if search::uses_fts(q) {
            let a = push(&mut args, Box::new(search::fts_phrase(q)));
            wheres.push(format!(
                "n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH {a})"
            ));
        } else {
            let a = push(&mut args, Box::new(search::like_pattern(q)));
            wheres.push(format!(
                "(n.title LIKE {a} ESCAPE '\\' OR n.body_md LIKE {a} ESCAPE '\\')"
            ));
        }
    }
    let limit = f.limit.unwrap_or(500).clamp(1, 2000);
    let sql = format!(
        "SELECT {COLS} FROM notes n WHERE {} ORDER BY n.updated_at DESC LIMIT {limit}",
        wheres.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Lines that look like open to-do items: `- x`, `* x`, `+ x`, `1. x`, `- [ ] x`.
/// Checked items (`- [x]`) are skipped.
pub fn action_lines(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in body.lines() {
        let line = raw.trim();
        let rest = if let Some(r) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
        {
            r
        } else if let Some(pos) = line.find(". ") {
            if pos > 0 && pos <= 3 && line[..pos].chars().all(|c| c.is_ascii_digit()) {
                &line[pos + 2..]
            } else {
                continue;
            }
        } else {
            continue;
        };
        let rest = rest.trim();
        if rest.starts_with("[x]") || rest.starts_with("[X]") {
            continue;
        }
        let text = rest.strip_prefix("[ ]").unwrap_or(rest).trim();
        if !text.is_empty() {
            out.push(text.chars().take(crate::model::MAX_TITLE).collect());
        }
    }
    out
}

/// Turn a note into tasks: one per to-do line, or one task from the title if there are none.
/// Tasks are linked back to the note and inherit its project.
pub fn convert_to_tasks(conn: &Connection, id: &str, actor: Actor) -> AppResult<Vec<Task>> {
    let note = get(conn, id)?;
    let mut titles = action_lines(&note.body_md);
    let single = titles.is_empty();
    if single {
        let t = if note.title.trim().is_empty() {
            note.body_md
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string()
        } else {
            note.title.clone()
        };
        titles.push(t.chars().take(crate::model::MAX_TITLE).collect());
    }
    let origin = TaskOrigin {
        source: Some(Source::Note),
        note_id: Some(note.id.clone()),
        source_url: note.source_url.clone(),
        ..Default::default()
    };
    titles
        .into_iter()
        .map(|title| {
            let input = TaskInput {
                title,
                project_id: note.project_id.clone(),
                tags: note.tags.clone(),
                description: single
                    .then(|| note.body_md.clone())
                    .filter(|b| !b.trim().is_empty()),
                ..Default::default()
            };
            tasks::create(conn, &input, &origin, actor)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_util::db;

    fn note(title: &str, body: &str) -> NoteInput {
        NoteInput {
            title: title.into(),
            body_md: body.into(),
            ..Default::default()
        }
    }

    #[test]
    fn crud_and_search() {
        let db = db();
        let n = db
            .write(|c| {
                create(
                    c,
                    &note("Meeting", "Discussed the LearnWorlds import"),
                    Source::Manual,
                )
            })
            .unwrap();
        assert_eq!(n.kind, NoteKind::General);
        let found = db
            .read(|c| {
                list(
                    c,
                    &NoteFilter {
                        query: Some("learnworlds".into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        assert_eq!(found.len(), 1);
        db.write(|c| update(c, &n.id, &note("Meeting", "Nothing here")))
            .unwrap();
        let found = db
            .read(|c| {
                list(
                    c,
                    &NoteFilter {
                        query: Some("learnworlds".into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        assert!(found.is_empty());
        db.write(|c| soft_delete(c, &n.id)).unwrap();
        assert!(db.read(|c| get(c, &n.id)).is_err());
        assert!(
            db.write(|c| create(c, &note(" ", " "), Source::Manual))
                .is_err()
        );
    }

    #[test]
    fn action_lines_parse() {
        let body = "Intro text\n- Call Niamh\n* [ ] Send list\n- [x] Done already\n2. Book room\n10.5 is a number\n";
        assert_eq!(action_lines(body), ["Call Niamh", "Send list", "Book room"]);
    }

    #[test]
    fn convert_three_bullets_to_three_linked_tasks() {
        let db = db();
        let n = db
            .write(|c| create(c, &note("Plan", "- One\n- Two\n- Three"), Source::Manual))
            .unwrap();
        let tasks = db
            .write(|c| convert_to_tasks(c, &n.id, Actor::User))
            .unwrap();
        assert_eq!(tasks.len(), 3);
        assert!(
            tasks
                .iter()
                .all(|t| t.note_id.as_deref() == Some(n.id.as_str()))
        );
        assert!(tasks.iter().all(|t| t.source == Source::Note));
    }

    #[test]
    fn convert_without_bullets_uses_title() {
        let db = db();
        let n = db
            .write(|c| {
                create(
                    c,
                    &note("Renew insurance", "Policy ends in March"),
                    Source::Manual,
                )
            })
            .unwrap();
        let tasks = db
            .write(|c| convert_to_tasks(c, &n.id, Actor::User))
            .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Renew insurance");
        assert_eq!(
            tasks[0].description.as_deref(),
            Some("Policy ends in March")
        );
    }
}
