//! Process-wide state shared by Tauri commands and the HTTP API.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::{
    db::Db,
    error::{AppError, AppResult},
};

pub const API_PORT: u16 = 47821;
pub const DB_FILE: &str = "tether.db";
pub const TOKEN_FILE: &str = "token";

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    /// Bearer token for the local API, shared with the Chrome extension / MCP server.
    pub token: Arc<String>,
    pub data_dir: Arc<PathBuf>,
}

impl AppState {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let db = Db::open(&data_dir.join(DB_FILE))?;
        let token = load_or_create_token(&data_dir.join(TOKEN_FILE))?;
        Ok(AppState {
            db: Arc::new(db),
            token: Arc::new(token),
            data_dir: Arc::new(data_dir.to_path_buf()),
        })
    }

    /// Replace the API token (invalidates every paired client).
    pub fn rotate_token(&mut self) -> AppResult<()> {
        let token = new_token();
        write_token(&self.data_dir.join(TOKEN_FILE), &token)?;
        self.token = Arc::new(token);
        Ok(())
    }
}

pub fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS random source unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_token(path: &Path, token: &str) -> AppResult<()> {
    // %APPDATA% is private to the Windows user, which is the protection boundary we rely on.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, token)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn load_or_create_token(path: &Path) -> AppResult<String> {
    match std::fs::read_to_string(path) {
        Ok(s) if is_valid_token(s.trim()) => Ok(s.trim().to_string()),
        Ok(_) => {
            log::warn!("token file was invalid; generating a new token");
            let t = new_token();
            write_token(path, &t)?;
            Ok(t)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let t = new_token();
            write_token(path, &t)?;
            Ok(t)
        }
        Err(e) => Err(AppError::Io(e)),
    }
}

fn is_valid_token(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_persists_and_rotates() {
        let dir = std::env::temp_dir().join(format!("tether-state-{}", ulid::Ulid::generate()));
        let a = AppState::open(&dir).unwrap();
        assert!(is_valid_token(&a.token));
        let b = AppState::open(&dir).unwrap();
        assert_eq!(a.token, b.token, "token survives restart");

        let mut c = b.clone();
        c.rotate_token().unwrap();
        assert_ne!(c.token, a.token);
        let d = AppState::open(&dir).unwrap();
        assert_eq!(d.token, c.token);

        std::fs::write(dir.join(TOKEN_FILE), "garbage").unwrap();
        let e = AppState::open(&dir).unwrap();
        assert!(is_valid_token(&e.token));
        drop((a, b, c, d, e));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
