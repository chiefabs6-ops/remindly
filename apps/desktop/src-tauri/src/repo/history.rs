use rusqlite::{Connection, params};

use crate::{
    error::AppResult,
    model::{Actor, HistoryEntry, now_utc},
};

pub fn record(
    conn: &Connection,
    task_id: &str,
    actor: Actor,
    action: &str,
    field: Option<&str>,
    old_value: Option<&str>,
    new_value: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_history(task_id, at, actor, action, field, old_value, new_value)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            task_id,
            now_utc(),
            actor,
            action,
            field,
            old_value,
            new_value
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<HistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, at, actor, action, field, old_value, new_value
         FROM task_history WHERE task_id = ?1 ORDER BY at DESC, id DESC LIMIT 200",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        Ok(HistoryEntry {
            id: r.get(0)?,
            at: r.get(1)?,
            actor: r.get(2)?,
            action: r.get(3)?,
            field: r.get(4)?,
            old_value: r.get(5)?,
            new_value: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
