use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::{error::AppResult, model::now_utc};

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(s) => Some(serde_json::from_str(&s)?),
        None => None,
    })
}

pub fn set(conn: &Connection, key: &str, value: &Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(value)?, now_utc()],
    )?;
    Ok(())
}

pub fn all(conn: &Connection) -> AppResult<serde_json::Map<String, Value>> {
    let mut stmt = conn.prepare("SELECT key, value_json FROM settings ORDER BY key")?;
    let mut out = serde_json::Map::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        out.insert(k, serde_json::from_str(&v)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_util::db;

    #[test]
    fn set_get_overwrite() {
        let db = db();
        db.write(|c| set(c, "theme", &Value::from("dark"))).unwrap();
        db.write(|c| set(c, "theme", &Value::from("light")))
            .unwrap();
        assert_eq!(
            db.read(|c| get(c, "theme")).unwrap(),
            Some(Value::from("light"))
        );
        assert_eq!(db.read(|c| get(c, "missing")).unwrap(), None);
        assert_eq!(db.read(all).unwrap().len(), 1);
    }
}
