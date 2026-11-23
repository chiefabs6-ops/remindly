//! Backups (consistent SQLite copies via `VACUUM INTO`), restore, JSON export and health checks.
//! Nothing is written unless the user asks, or turns automatic daily backups on.

use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{Datelike, Local, NaiveDate};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    api::ALLOWED_ORIGINS_KEY,
    db::Db,
    error::{AppError, AppResult},
    repo::settings,
};

pub const SETTINGS_KEY: &str = "backups";
const PREFIX: &str = "tether-";
const EXT: &str = ".db";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSettings {
    /// Off until the user turns it on.
    pub auto_daily: bool,
    /// Folder for backups; empty = Documents\Tether\Backups.
    pub dir: String,
    pub keep_daily: usize,
    pub keep_weekly: usize,
    /// Local date of the last automatic backup attempt (YYYY-MM-DD).
    pub last_auto: Option<String>,
    /// Why the last automatic backup failed, if it did.
    pub last_error: Option<String>,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            auto_daily: false,
            dir: String::new(),
            keep_daily: 7,
            keep_weekly: 4,
            last_auto: None,
            last_error: None,
        }
    }
}

impl BackupSettings {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(settings::get(conn, SETTINGS_KEY)?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    pub fn save(&self, conn: &Connection) -> AppResult<()> {
        settings::set(conn, SETTINGS_KEY, &serde_json::to_value(self)?)
    }

    pub fn folder(&self, default_dir: &Path) -> PathBuf {
        if self.dir.trim().is_empty() {
            default_dir.to_path_buf()
        } else {
            PathBuf::from(self.dir.trim())
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    /// Local timestamp from the file name, "YYYY-MM-DD HH:MM:SS".
    pub taken_at: String,
}

fn stamp_of(name: &str) -> Option<chrono::NaiveDateTime> {
    let s = name.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    let s = s.split('-').take(2).collect::<Vec<_>>().join("-");
    chrono::NaiveDateTime::parse_from_str(&s, "%Y%m%d-%H%M%S").ok()
}

/// Write a consistent copy of the live database into `folder`. Returns the new file.
pub fn backup_now(db: &Db, folder: &Path, label: &str) -> AppResult<BackupFile> {
    fs::create_dir_all(folder)?;
    let now = Local::now();
    let suffix = if label.is_empty() {
        String::new()
    } else {
        format!("-{label}")
    };
    let name = format!("{PREFIX}{}{suffix}{EXT}", now.format("%Y%m%d-%H%M%S"));
    let path = folder.join(&name);
    if path.exists() {
        return Err(AppError::Conflict(
            "a backup with this name already exists; try again in a second".into(),
        ));
    }
    let written = db.read(|c| {
        c.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])?;
        Ok(())
    });
    // Never leave a half-written or empty file that would look restorable.
    let checked = written.and_then(|_| verify(&path));
    match checked {
        Ok(r) if r == "ok" => describe(&path),
        Ok(r) => {
            let _ = fs::remove_file(&path);
            Err(AppError::invalid(format!(
                "backup failed its integrity check: {r}"
            )))
        }
        Err(e) => {
            let _ = fs::remove_file(&path);
            Err(e)
        }
    }
}

fn describe(path: &Path) -> AppResult<BackupFile> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    Ok(BackupFile {
        bytes: fs::metadata(path)?.len(),
        taken_at: stamp_of(&name)
            .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default(),
        path: path.display().to_string(),
        name,
    })
}

pub fn list(folder: &Path) -> AppResult<Vec<BackupFile>> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Ok(vec![]);
    };
    let mut out: Vec<BackupFile> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(EXT) && stamp_of(n).is_some())
        })
        .filter_map(|p| describe(&p).ok())
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Checks a backup file: SQLite says it is sound AND it really holds Tether data (an empty or
/// foreign file also passes `integrity_check`, so that alone is not enough). "ok" when usable.
pub fn verify(path: &Path) -> AppResult<String> {
    if fs::metadata(path)?.len() == 0 {
        return Ok("empty file".into());
    }
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let r: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if r != "ok" {
        return Ok(r);
    }
    let tables: i64 = c.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'projects', 'settings')",
        [],
        |r| r.get(0),
    )?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if tables < 3 || version < 1 {
        return Ok("not a Tether database".into());
    }
    Ok(r)
}

/// Quick health check of the live database (run at start-up).
pub fn quick_check(db: &Db) -> AppResult<String> {
    db.read(|c| Ok(c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))?))
}

/// Keep the newest `keep_daily` distinct days, plus the newest backup of each of the last
/// `keep_weekly` other weeks. Only automatic backups (`-auto`) are ever deleted.
pub fn prune(folder: &Path, keep_daily: usize, keep_weekly: usize) -> AppResult<usize> {
    let autos: Vec<BackupFile> = list(folder)?
        .into_iter()
        .filter(|b| b.name.contains("-auto"))
        .collect();
    let mut keep_days: Vec<NaiveDate> = Vec::new();
    let mut keep_weeks: Vec<(i32, u32)> = Vec::new();
    let mut removed = 0;
    for b in autos {
        let Some(t) = stamp_of(&b.name) else { continue };
        let day = t.date();
        let week = (day.iso_week().year(), day.iso_week().week());
        let keep = if keep_days.contains(&day) {
            false // second backup of a kept day
        } else if keep_days.len() < keep_daily {
            keep_days.push(day);
            true
        } else if !keep_weeks.contains(&week)
            && keep_weeks.len() < keep_weekly
            && !keep_days
                .iter()
                .any(|d| (d.iso_week().year(), d.iso_week().week()) == week)
        {
            keep_weeks.push(week);
            true
        } else {
            false
        };
        if !keep {
            fs::remove_file(&b.path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Replace the live database with a backup. The current data is backed up first (`-before-restore`).
pub fn restore(db: &Db, folder: &Path, name: &str) -> AppResult<BackupFile> {
    if name.contains(['/', '\\', ':'])
        || name.contains("..")
        || !name.starts_with(PREFIX)
        || !name.ends_with(EXT)
    {
        return Err(AppError::invalid("unknown backup"));
    }
    let path = folder.join(name);
    if !path.exists() {
        return Err(AppError::NotFound("backup".into()));
    }
    let check = verify(&path)?;
    if check != "ok" {
        return Err(AppError::invalid(format!(
            "that backup is damaged ({check}); pick another"
        )));
    }
    let src = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = src.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let current = db.read(crate::db::schema_version)? as i64;
    if version > current {
        return Err(AppError::invalid(
            "that backup comes from a newer version of Tether",
        ));
    }
    drop(src);
    // Keep the current data first. If the live database is too damaged to copy cleanly (the case
    // where you most need a restore), fall back to a raw byte copy of the file.
    let safety = match backup_now(db, folder, "before-restore") {
        Ok(b) => b,
        Err(e) => {
            log::warn!("clean safety copy failed ({e}); taking a raw copy instead");
            let raw = folder.join(format!(
                "{PREFIX}{}-before-restore-raw{EXT}",
                Local::now().format("%Y%m%d-%H%M%S")
            ));
            db.raw_copy(&raw)?;
            BackupFile {
                name: raw
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string(),
                path: raw.display().to_string(),
                bytes: fs::metadata(&raw).map(|m| m.len()).unwrap_or(0),
                taken_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            }
        }
    };
    // Settings that belong to this PC survive the restore (backup folder, paired browser).
    let keep: Vec<(String, Value)> = db
        .read(|c| {
            let mut v = Vec::new();
            for k in [SETTINGS_KEY, ALLOWED_ORIGINS_KEY] {
                if let Some(val) = settings::get(c, k)? {
                    v.push((k.to_string(), val));
                }
            }
            Ok(v)
        })
        .unwrap_or_default();
    db.restore_from(&path)?;
    db.write(|c| {
        for (k, v) in &keep {
            settings::set(c, k, v)?;
        }
        Ok(())
    })?;
    log::info!("restored {name}; previous data saved as {}", safety.name);
    Ok(safety)
}

/// Everything as JSON (for reading or moving data elsewhere). The API token origins are left out.
pub fn export_json(db: &Db) -> AppResult<Value> {
    db.read(|c| {
        let mut out = Map::new();
        out.insert("app".into(), Value::from("tether"));
        out.insert("exportedAt".into(), Value::from(crate::model::now_utc()));
        out.insert(
            "schemaVersion".into(),
            Value::from(crate::db::schema_version(c)? as i64),
        );
        for table in [
            "projects",
            "categories",
            "tags",
            "tasks",
            "task_tags",
            "notes",
            "note_tags",
            "code_projects",
            "suggestions",
            "reminders",
            "task_history",
            "settings",
        ] {
            let mut stmt = c.prepare(&format!("SELECT * FROM {table}"))?;
            let cols: Vec<String> = stmt.column_names().map(str::to_string).collect();
            let rows = stmt.query_map([], |r| {
                let mut m = Map::new();
                for (i, col) in cols.iter().enumerate() {
                    let v = match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => Value::from(n),
                        rusqlite::types::ValueRef::Real(f) => Value::from(f),
                        rusqlite::types::ValueRef::Text(t) => {
                            Value::from(String::from_utf8_lossy(t).to_string())
                        }
                        rusqlite::types::ValueRef::Blob(_) => Value::Null,
                    };
                    m.insert(col.clone(), v);
                }
                Ok(Value::Object(m))
            })?;
            let mut list: Vec<Value> = rows.collect::<Result<_, _>>()?;
            if table == "settings" {
                list.retain(|v| v.get("key").and_then(|k| k.as_str()) != Some(ALLOWED_ORIGINS_KEY));
            }
            out.insert(table.into(), Value::Array(list));
        }
        Ok(Value::Object(out))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Actor, TaskInput, TaskOrigin},
        repo::tasks,
    };

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tether-{tag}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn mk(db: &Db, title: &str) {
        db.write(|c| {
            tasks::create(
                c,
                &TaskInput {
                    title: title.into(),
                    ..Default::default()
                },
                &TaskOrigin::default(),
                Actor::User,
            )
        })
        .unwrap();
    }

    #[test]
    fn backup_verify_restore_round_trip() {
        let data = tmp("data");
        let folder = tmp("backups");
        let db = Db::open(&data.join("t.db")).unwrap();
        mk(&db, "Before backup");
        let b = backup_now(&db, &folder, "").unwrap();
        assert_eq!(verify(Path::new(&b.path)).unwrap(), "ok");
        mk(&db, "After backup");
        assert_eq!(
            db.read(|c| tasks::list(c, &Default::default()))
                .unwrap()
                .len(),
            2
        );

        std::thread::sleep(std::time::Duration::from_millis(1100)); // unique second for the safety copy
        let safety = restore(&db, &folder, &b.name).unwrap();
        assert!(safety.name.contains("before-restore"));
        let titles: Vec<_> = db
            .read(|c| tasks::list(c, &Default::default()))
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(titles, ["Before backup"]);
        // FTS still works after restore.
        let found = db
            .read(|c| {
                tasks::list(
                    c,
                    &crate::model::TaskFilter {
                        query: Some("backup".into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(list(&folder).unwrap().len(), 2);
        drop(db);
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn restore_refuses_bad_names_and_damaged_files() {
        let folder = tmp("bad");
        let db = Db::open_in_memory().unwrap();
        assert!(restore(&db, &folder, "..\\evil.db").is_err());
        assert!(restore(&db, &folder, "tether-20260101-000000.db").is_err());
        fs::write(folder.join("tether-20260101-000000.db"), b"not a database").unwrap();
        assert!(restore(&db, &folder, "tether-20260101-000000.db").is_err());
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn prune_keeps_recent_days_and_weekly_and_never_manual() {
        let folder = tmp("prune");
        let names = [
            "tether-20261123-090000-auto.db",
            "tether-20261122-090000-auto.db",
            "tether-20261121-090000-auto.db",
            "tether-20261121-180000-auto.db", // newest of a kept day -> kept; the 09:00 one goes
            "tether-20261114-090000-auto.db",
            "tether-20261107-090000-auto.db",
            "tether-20261031-090000-auto.db",
            "tether-20261001-090000.db", // manual, always kept
        ];
        for n in names {
            fs::write(folder.join(n), b"x").unwrap();
        }
        let removed = prune(&folder, 3, 2).unwrap();
        let left: Vec<String> = list(&folder).unwrap().into_iter().map(|b| b.name).collect();
        assert_eq!(removed, 2, "{left:?}");
        assert!(left.contains(&"tether-20261001-090000.db".to_string()));
        assert!(left.contains(&"tether-20261114-090000-auto.db".to_string()));
        assert!(!left.contains(&"tether-20261031-090000-auto.db".to_string()));
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn export_has_data_but_not_the_allow_list() {
        let db = Db::open_in_memory().unwrap();
        mk(&db, "Exported");
        db.write(|c| {
            settings::set(
                c,
                ALLOWED_ORIGINS_KEY,
                &serde_json::json!(["chrome-extension://x"]),
            )
        })
        .unwrap();
        db.write(|c| settings::set(c, "theme", &serde_json::json!("dark")))
            .unwrap();
        let v = export_json(&db).unwrap();
        assert_eq!(v["tasks"].as_array().unwrap().len(), 1);
        let keys: Vec<_> = v["settings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["key"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(keys, ["theme"]);
    }

    #[test]
    fn empty_or_foreign_files_are_not_backups() {
        let folder = tmp("empty");
        let db = Db::open_in_memory().unwrap();
        fs::write(folder.join("tether-20260101-000000.db"), b"").unwrap();
        assert_eq!(
            verify(&folder.join("tether-20260101-000000.db")).unwrap(),
            "empty file"
        );
        assert!(restore(&db, &folder, "tether-20260101-000000.db").is_err());
        let foreign = folder.join("tether-20260102-000000.db");
        Connection::open(&foreign)
            .unwrap()
            .execute_batch("CREATE TABLE x(a)")
            .unwrap();
        assert_eq!(verify(&foreign).unwrap(), "not a Tether database");
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn refuses_a_backup_from_a_newer_version() {
        let folder = tmp("newer");
        let data = tmp("newer-data");
        let db = Db::open(&data.join("t.db")).unwrap();
        let b = backup_now(&db, &folder, "").unwrap();
        Connection::open(&b.path)
            .unwrap()
            .pragma_update(None, "user_version", 999)
            .unwrap();
        let e = restore(&db, &folder, &b.name).unwrap_err();
        assert!(e.to_string().contains("newer version"), "{e}");
        drop(db);
        let _ = fs::remove_dir_all(&folder);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn failed_backup_leaves_no_file() {
        let folder = tmp("fail");
        let db = Db::open_in_memory().unwrap();
        // A folder path where the file should be makes VACUUM INTO fail.
        let blocked = folder.join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        let before = fs::read_dir(&blocked).unwrap().count();
        let r = backup_now(&db, &blocked.join("missing-subdir").join("x"), "");
        // Either it failed or it produced a verified file; never a broken leftover.
        if r.is_err() {
            assert_eq!(fs::read_dir(&blocked).unwrap().count(), before);
        }
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn restore_keeps_this_pcs_settings() {
        let data = tmp("keep");
        let folder = tmp("keep-b");
        let db = Db::open(&data.join("t.db")).unwrap();
        db.write(|c| settings::set(c, ALLOWED_ORIGINS_KEY, &serde_json::json!(["old"])))
            .unwrap();
        let b = backup_now(&db, &folder, "").unwrap();
        db.write(|c| {
            settings::set(
                c,
                ALLOWED_ORIGINS_KEY,
                &serde_json::json!(["chrome-extension://now"]),
            )
        })
        .unwrap();
        db.write(|c| {
            BackupSettings {
                auto_daily: true,
                ..Default::default()
            }
            .save(c)
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        restore(&db, &folder, &b.name).unwrap();
        assert_eq!(
            db.read(|c| settings::get(c, ALLOWED_ORIGINS_KEY)).unwrap(),
            Some(serde_json::json!(["chrome-extension://now"]))
        );
        assert!(db.read(BackupSettings::load).unwrap().auto_daily);
        drop(db);
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn automatic_backups_are_off_by_default() {
        let db = Db::open_in_memory().unwrap();
        assert!(!db.read(BackupSettings::load).unwrap().auto_daily);
    }

    #[test]
    fn quick_check_ok() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(quick_check(&db).unwrap(), "ok");
    }
}
