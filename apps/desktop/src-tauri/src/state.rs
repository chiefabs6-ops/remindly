//! Process-wide state shared by Tauri commands and the HTTP API.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use subtle::ConstantTimeEq;

use crate::{
    db::Db,
    error::{AppError, AppResult},
};

pub const API_PORT: u16 = 47821;
pub const DB_FILE: &str = "tether.db";
pub const TOKEN_FILE: &str = "token";

/// How long a pairing code shown in Settings stays valid, and how many guesses it allows.
pub const PAIRING_TTL: Duration = Duration::from_secs(120);
pub const PAIRING_ATTEMPTS: u8 = 5;

struct PendingPairing {
    code: String,
    expires: Instant,
    attempts: u8,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    /// Bearer token for the local API, shared with the Chrome extension / MCP server.
    token: Arc<RwLock<String>>,
    pairing: Arc<Mutex<Option<PendingPairing>>>,
    pub data_dir: Arc<PathBuf>,
}

impl AppState {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let db = Db::open(&data_dir.join(DB_FILE))?;
        let token = load_or_create_token(&data_dir.join(TOKEN_FILE))?;
        Ok(AppState {
            db: Arc::new(db),
            token: Arc::new(RwLock::new(token)),
            pairing: Arc::new(Mutex::new(None)),
            data_dir: Arc::new(data_dir.to_path_buf()),
        })
    }

    pub fn token(&self) -> String {
        self.token.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Constant-time check of a presented bearer token.
    pub fn token_matches(&self, presented: &str) -> bool {
        let t = self.token.read().unwrap_or_else(|p| p.into_inner());
        presented.as_bytes().ct_eq(t.as_bytes()).into()
    }

    /// Replace the API token (invalidates every paired client).
    pub fn rotate_token(&self) -> AppResult<()> {
        let token = new_token();
        write_token(&self.data_dir.join(TOKEN_FILE), &token)?;
        *self.token.write().unwrap_or_else(|p| p.into_inner()) = token;
        Ok(())
    }

    /// Start pairing: a fresh 6-digit code, valid for `PAIRING_TTL`. Replaces any earlier code.
    pub fn start_pairing(&self) -> String {
        let mut buf = [0u8; 4];
        getrandom::fill(&mut buf).expect("OS random source unavailable");
        let code = format!("{:06}", u32::from_le_bytes(buf) % 1_000_000);
        *self.pairing.lock().unwrap_or_else(|p| p.into_inner()) = Some(PendingPairing {
            code: code.clone(),
            expires: Instant::now() + PAIRING_TTL,
            attempts: 0,
        });
        code
    }

    /// Exchange a pairing code for the API token. A code works once, for a limited time and
    /// a limited number of guesses.
    pub fn redeem_pairing(&self, code: &str) -> AppResult<String> {
        let mut slot = self.pairing.lock().unwrap_or_else(|p| p.into_inner());
        let Some(p) = slot.as_mut() else {
            return Err(AppError::invalid(
                "No pairing in progress. In Tether, open Settings and press Pair Chrome.",
            ));
        };
        if Instant::now() > p.expires {
            *slot = None;
            return Err(AppError::invalid(
                "That code expired. Press Pair Chrome again.",
            ));
        }
        if !bool::from(code.trim().as_bytes().ct_eq(p.code.as_bytes())) {
            p.attempts += 1;
            if p.attempts >= PAIRING_ATTEMPTS {
                *slot = None;
                return Err(AppError::invalid(
                    "Too many wrong codes. Press Pair Chrome again.",
                ));
            }
            return Err(AppError::invalid(
                "That code is wrong. Check the 6 digits in Tether.",
            ));
        }
        *slot = None;
        Ok(self.token())
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
        assert!(is_valid_token(&a.token()));
        let b = AppState::open(&dir).unwrap();
        assert_eq!(a.token(), b.token(), "token survives restart");

        let c = b.clone();
        c.rotate_token().unwrap();
        assert_ne!(c.token(), a.token());
        assert_eq!(b.token(), c.token(), "clones share the rotated token");
        let d = AppState::open(&dir).unwrap();
        assert_eq!(d.token(), c.token());

        std::fs::write(dir.join(TOKEN_FILE), "garbage").unwrap();
        let e = AppState::open(&dir).unwrap();
        assert!(is_valid_token(&e.token()));
        drop((a, b, c, d, e));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairing_codes_work_once_and_lock_after_guesses() {
        let dir = std::env::temp_dir().join(format!("tether-pair-{}", ulid::Ulid::generate()));
        let s = AppState::open(&dir).unwrap();
        assert!(s.redeem_pairing("123456").is_err(), "nothing in progress");

        let code = s.start_pairing();
        assert_eq!(code.len(), 6);
        assert_eq!(s.redeem_pairing(&code).unwrap(), s.token());
        assert!(s.redeem_pairing(&code).is_err(), "single use");

        let code = s.start_pairing();
        let wrong = if code == "000000" { "000001" } else { "000000" };
        for _ in 0..PAIRING_ATTEMPTS {
            assert!(s.redeem_pairing(wrong).is_err());
        }
        assert!(
            s.redeem_pairing(&code).is_err(),
            "locked after too many guesses"
        );
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
