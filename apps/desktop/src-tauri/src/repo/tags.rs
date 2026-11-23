use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    error::{AppError, AppResult},
    model::{Tag, new_id},
};

/// Trim, strip a leading '#', drop empties and case-insensitive duplicates, keep first spelling.
pub fn clean_names(names: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let t = n.trim().trim_start_matches('#').trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > 50 {
            return Err(AppError::invalid("tag is longer than 50 characters"));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    if out.len() > 20 {
        return Err(AppError::invalid("at most 20 tags"));
    }
    Ok(out)
}

/// Returns the id of the tag with this name, creating it if needed.
pub fn ensure(conn: &Connection, name: &str) -> AppResult<String> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            [name],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO tags(id, name) VALUES (?1, ?2)",
        params![id, name],
    )?;
    Ok(id)
}

/// Replace a task's tags. Returns the cleaned names.
pub fn set_for_task(conn: &Connection, task_id: &str, names: &[String]) -> AppResult<Vec<String>> {
    let names = clean_names(names)?;
    conn.execute("DELETE FROM task_tags WHERE task_id = ?1", [task_id])?;
    for n in &names {
        let tag_id = ensure(conn, n)?;
        conn.execute(
            "INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES (?1, ?2)",
            params![task_id, tag_id],
        )?;
    }
    Ok(names)
}

pub fn set_for_note(conn: &Connection, note_id: &str, names: &[String]) -> AppResult<Vec<String>> {
    let names = clean_names(names)?;
    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", [note_id])?;
    for n in &names {
        let tag_id = ensure(conn, n)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;
    }
    Ok(names)
}

pub fn list(conn: &Connection) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.color,
            (SELECT count(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
               WHERE tt.tag_id = g.id AND t.deleted_at IS NULL)
          + (SELECT count(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
               WHERE nt.tag_id = g.id AND n.deleted_at IS NULL)
         FROM tags g ORDER BY g.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            usage: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    if conn.execute("DELETE FROM tags WHERE id = ?1", [id])? == 0 {
        return Err(AppError::NotFound("tag".into()));
    }
    Ok(())
}

/// Split a `char(31)`-joined `group_concat` into sorted names.
pub fn split_joined(joined: Option<String>) -> Vec<String> {
    let mut v: Vec<String> = joined
        .map(|s| s.split('\u{1f}').map(str::to_string).collect())
        .unwrap_or_default();
    v.sort_by_key(|s| s.to_lowercase());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_names_dedupes_and_strips_hash() {
        let names = clean_names(&[
            "#Urgent".into(),
            "urgent".into(),
            " ".into(),
            "kinia".into(),
        ])
        .unwrap();
        assert_eq!(names, ["Urgent", "kinia"]);
        assert!(clean_names(&["x".repeat(51)]).is_err());
    }
}
