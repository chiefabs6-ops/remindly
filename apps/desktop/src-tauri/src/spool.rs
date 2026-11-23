//! Suggestions written to disk by the Claude Code MCP server while Tether was closed.
//! Each file in `<data dir>/spool/*.json` is one `NewSuggestion`; importing is idempotent
//! because the server dedupes on `dedupeKey`.

use std::{fs, path::Path};

use crate::{db::Db, error::AppError, model::NewSuggestion, repo::suggestions};

pub const SPOOL_DIR: &str = "spool";
const MAX_FILE: u64 = 256 * 1024;

#[derive(Debug, Default, PartialEq)]
pub struct SpoolReport {
    pub imported: usize,
    pub rejected: usize,
    pub kept: usize,
}

pub fn import(db: &Db, data_dir: &Path) -> SpoolReport {
    let dir = data_dir.join(SPOOL_DIR);
    let mut report = SpoolReport::default();
    let Ok(entries) = fs::read_dir(&dir) else {
        return report;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort(); // writers name files by time, so this keeps capture order
    for path in files {
        let parsed: Result<NewSuggestion, String> = fs::metadata(&path)
            .map_err(|e| e.to_string())
            .and_then(|m| {
                if m.len() > MAX_FILE {
                    Err("file too large".into())
                } else {
                    fs::read_to_string(&path).map_err(|e| e.to_string())
                }
            })
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()));
        let outcome = match parsed {
            Ok(s) => db.write(|c| suggestions::create(c, &s)).map(|_| ()),
            Err(e) => Err(AppError::invalid(e)),
        };
        match outcome {
            Ok(()) => {
                let _ = fs::remove_file(&path);
                report.imported += 1;
            }
            Err(AppError::Invalid(msg)) | Err(AppError::NotFound(msg)) => {
                log::warn!("spool file {} rejected: {msg}", path.display());
                let rejected = dir.join("rejected");
                let _ = fs::create_dir_all(&rejected);
                let _ = fs::rename(&path, rejected.join(path.file_name().unwrap_or_default()));
                report.rejected += 1;
            }
            Err(e) => {
                // Database busy or similar: try again on the next pass.
                log::warn!("spool file {} kept: {e}", path.display());
                report.kept += 1;
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SuggestionStatus;

    #[test]
    fn imports_valid_files_and_sets_bad_ones_aside() {
        let data = std::env::temp_dir().join(format!("tether-spool-{}", ulid::Ulid::generate()));
        let spool = data.join(SPOOL_DIR);
        fs::create_dir_all(&spool).unwrap();
        let good = serde_json::json!({
            "kind": "task", "origin": "claude", "dedupeKey": "claude:1",
            "payload": { "title": "Finish educator profile" },
            "context": { "remaining": ["Fix validation"] }
        });
        fs::write(spool.join("0001.json"), good.to_string()).unwrap();
        fs::write(spool.join("0002.json"), good.to_string()).unwrap(); // retry duplicate
        fs::write(spool.join("0003.json"), "{not json").unwrap();
        fs::write(spool.join("note.txt"), "ignored").unwrap();

        let db = Db::open_in_memory().unwrap();
        let r = import(&db, &data);
        assert_eq!(
            r,
            SpoolReport {
                imported: 2,
                rejected: 1,
                kept: 0
            }
        );
        let pending = db
            .read(|c| suggestions::list(c, Some(SuggestionStatus::Pending), 10))
            .unwrap();
        assert_eq!(pending.len(), 1, "duplicate collapsed by dedupeKey");
        assert!(spool.join("rejected").join("0003.json").exists());
        assert!(spool.join("note.txt").exists());
        assert_eq!(import(&db, &data), SpoolReport::default());
        let _ = fs::remove_dir_all(&data);
    }
}
