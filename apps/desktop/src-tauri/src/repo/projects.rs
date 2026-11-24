use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::{
    error::{AppError, AppResult},
    model::{Project, ProjectInput, clean_text, new_id, now_utc},
};

const COLS: &str = "p.id, p.name, p.color, p.icon, p.description, p.sort_order, p.archived_at,
    p.created_at, p.updated_at,
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL
        AND t.parent_id IS NULL AND t.status NOT IN ('completed','archived')),
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL
        AND t.parent_id IS NULL AND t.status = 'completed'
        AND t.completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'))";

fn from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        icon: r.get(3)?,
        description: r.get(4)?,
        sort_order: r.get(5)?,
        archived_at: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        open_tasks: r.get(9)?,
        done_recent: r.get(10)?,
    })
}

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::invalid("project name is required"));
    }
    if n.chars().count() > 100 {
        return Err(AppError::invalid(
            "project name is longer than 100 characters",
        ));
    }
    Ok(n.to_string())
}

pub fn list(conn: &Connection, include_archived: bool) -> AppResult<Vec<Project>> {
    let sql = format!(
        "SELECT {COLS} FROM projects p {} ORDER BY p.sort_order, p.name COLLATE NOCASE",
        if include_archived {
            ""
        } else {
            "WHERE p.archived_at IS NULL"
        }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Project> {
    conn.query_row(
        &format!("SELECT {COLS} FROM projects p WHERE p.id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("project".into()))
}

pub fn find_by_name(conn: &Connection, name: &str) -> AppResult<Option<Project>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM projects p WHERE p.name = ?1 COLLATE NOCASE"),
            [name.trim()],
            from_row,
        )
        .optional()?)
}

pub fn create(conn: &Connection, input: &ProjectInput) -> AppResult<Project> {
    let id = new_id();
    let now = now_utc();
    let next_order: f64 = conn.query_row(
        "SELECT coalesce(max(sort_order), 0) + 1 FROM projects",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO projects(id, name, color, icon, description, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            clean_name(&input.name)?,
            clean_text("color", &input.color)?,
            clean_text("icon", &input.icon)?,
            clean_text("description", &input.description)?,
            next_order,
            now
        ],
    )
    .map_err(|e| match AppError::from(e) {
        AppError::Conflict(_) => {
            AppError::Conflict(format!("a project named \"{}\" already exists", input.name.trim()))
        }
        other => other,
    })?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: &ProjectInput) -> AppResult<Project> {
    let n = conn
        .execute(
            "UPDATE projects SET name = ?2, color = ?3, icon = ?4, description = ?5, updated_at = ?6
             WHERE id = ?1",
            params![
                id,
                clean_name(&input.name)?,
                clean_text("color", &input.color)?,
                clean_text("icon", &input.icon)?,
                clean_text("description", &input.description)?,
                now_utc()
            ],
        )
        .map_err(|e| match AppError::from(e) {
            AppError::Conflict(_) => AppError::Conflict(format!(
                "a project named \"{}\" already exists",
                input.name.trim()
            )),
            other => other,
        })?;
    if n == 0 {
        return Err(AppError::NotFound("project".into()));
    }
    get(conn, id)
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> AppResult<Project> {
    let now = now_utc();
    let n = conn.execute(
        "UPDATE projects SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, if archived { Some(&now) } else { None }, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("project".into()));
    }
    get(conn, id)
}

/// Deletes the project; its tasks and notes are kept and become unassigned (FK ON DELETE SET NULL).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    if conn.execute("DELETE FROM projects WHERE id = ?1", [id])? == 0 {
        return Err(AppError::NotFound("project".into()));
    }
    Ok(())
}

/// Persist a drag-and-drop order.
pub fn reorder(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE projects SET sort_order = ?2 WHERE id = ?1",
            params![id, i as f64],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_util::db;

    fn input(name: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            color: Some("#4f46e5".into()),
            ..Default::default()
        }
    }

    #[test]
    fn crud_and_unique_names() {
        let db = db();
        let p = db
            .write(|c| create(c, &input("  Kinia – Educator Platform ")))
            .unwrap();
        assert_eq!(p.name, "Kinia – Educator Platform");
        assert_eq!(p.open_tasks, 0);

        let dup = db.write(|c| create(c, &input("kinia – educator platform")));
        assert!(matches!(dup, Err(AppError::Conflict(_))), "{dup:?}");

        let renamed = db.write(|c| update(c, &p.id, &input("Educator"))).unwrap();
        assert_eq!(renamed.name, "Educator");

        db.write(|c| set_archived(c, &p.id, true)).unwrap();
        assert!(db.read(|c| list(c, false)).unwrap().is_empty());
        assert_eq!(db.read(|c| list(c, true)).unwrap().len(), 1);

        db.write(|c| delete(c, &p.id)).unwrap();
        assert!(matches!(
            db.read(|c| get(c, &p.id)),
            Err(AppError::NotFound(_))
        ));
        assert!(db.write(|c| create(c, &input("   "))).is_err());
    }

    #[test]
    fn reorder_changes_list_order() {
        let db = db();
        let a = db.write(|c| create(c, &input("A"))).unwrap();
        let b = db.write(|c| create(c, &input("B"))).unwrap();
        db.write(|c| reorder(c, &[b.id.clone(), a.id.clone()]))
            .unwrap();
        let names: Vec<_> = db
            .read(|c| list(c, false))
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["B", "A"]);
    }
}
