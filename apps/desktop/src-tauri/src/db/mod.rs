//! SQLite access. The Rust core is the only owner of the database file.

use std::{path::Path, sync::Mutex, time::Duration};

use rusqlite::{Connection, Transaction};

use crate::error::{AppError, AppResult};

/// Ordered migrations. Index + 1 is the schema version stored in `PRAGMA user_version`.
/// Never edit a shipped migration; append a new one.
const MIGRATIONS: &[&str] = &[include_str!("migrations/001_init.sql")];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let mut conn = Connection::open(path)?;
        configure(&conn, true)?;
        migrate(&mut conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> AppResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        configure(&conn, false)?;
        migrate(&mut conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written (each write runs in a
        // transaction), so recover the guard instead of propagating the poison.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Run read-only or single-statement work.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.lock();
        f(&conn)
    }

    /// Run work inside one transaction; rolled back if `f` returns an error.
    pub fn write<T>(&self, f: impl FnOnce(&Transaction) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

fn configure(conn: &Connection, wal: bool) -> AppResult<()> {
    if wal {
        let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            log::warn!("WAL mode not enabled (journal_mode={mode})");
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> AppResult<usize> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    Ok(v.max(0) as usize)
}

fn migrate(conn: &mut Connection) -> AppResult<()> {
    let current = schema_version(conn)?;
    if current > MIGRATIONS.len() {
        return Err(AppError::invalid(format!(
            "database schema v{current} is newer than this app (v{}); update Tether",
            MIGRATIONS.len()
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
        log::info!("migrated database to v{}", i + 1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_to_latest_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("tether-db-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            let v = db.read(schema_version).unwrap();
            assert_eq!(v, MIGRATIONS.len());
            let mode: String = db
                .read(|c| Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?))
                .unwrap();
            assert_eq!(mode, "wal");
        }
        // Re-open: no migration re-run, no error.
        let db = Db::open(&path).unwrap();
        assert_eq!(db.read(schema_version).unwrap(), MIGRATIONS.len());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_newer_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        assert!(matches!(migrate(&mut conn), Err(AppError::Invalid(_))));
    }

    #[test]
    fn fts5_trigram_is_available() {
        let db = Db::open_in_memory().unwrap();
        db.read(|c| {
            c.execute_batch("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")?;
            Ok(())
        })
        .unwrap();
    }
}
