//! Settings → Updates: rebuild this app from the local source folder and swap it in.
//!
//! The app never builds anything itself. "Update Tether" opens a PowerShell window that runs the
//! repo's own `scripts/update-app.ps1 -Pull -FromApp`: pull main, build, close Tether, swap the exe,
//! reopen it. Only the desktop UI can start it (it is a Tauri command, not part of the local API).

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    repo::settings,
};

pub const SETTINGS_KEY: &str = "updates";
/// Commit this build came from (set by build.rs), or "unknown".
pub const BUILD_COMMIT: &str = env!("TETHER_GIT_SHA");
/// The folder this build was made from: the default source folder.
const BUILD_SOURCE: &str = env!("TETHER_SOURCE_DIR");
const SCRIPT: &str = "scripts/update-app.ps1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    /// The Tether source folder (a git checkout of this repo).
    pub repo: String,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            repo: BUILD_SOURCE.to_string(),
        }
    }
}

impl UpdateSettings {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(settings::get(conn, SETTINGS_KEY)?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    pub fn save(&self, conn: &Connection) -> AppResult<()> {
        settings::set(conn, SETTINGS_KEY, &serde_json::to_value(self)?)
    }

    /// The folder, if it looks like the Tether source: absolute, with the update script and package.json.
    pub fn validate(&self) -> AppResult<PathBuf> {
        let p = PathBuf::from(self.repo.trim());
        if self.repo.trim().is_empty() || !p.is_absolute() {
            return Err(AppError::invalid(
                "pick the full path of the Tether source folder",
            ));
        }
        if !p.join(SCRIPT).is_file() || !p.join("package.json").is_file() {
            return Err(AppError::invalid(format!(
                "{} is not the Tether source folder (no {SCRIPT} in it)",
                p.display()
            )));
        }
        Ok(p)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub repo: String,
    /// Why the folder cannot be used, if it cannot.
    pub problem: Option<String>,
    /// Commit the running app was built from (short), or "unknown".
    pub running: String,
    pub branch: Option<String>,
    /// Tracked files with changes not committed.
    pub dirty: bool,
    /// Newest main known locally (short), after the last check.
    pub latest: Option<String>,
    /// Commits on main that the running app does not have (None when it cannot tell).
    pub behind: Option<u32>,
    pub can_update: bool,
    /// Why the button is off, when it is.
    pub reason: Option<String>,
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Run git in the folder; trimmed stdout on success. No console window flashes up.
fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The main branch to compare with: origin/main after a check, else the local main.
fn main_ref(repo: &Path) -> Option<&'static str> {
    ["origin/main", "main"]
        .into_iter()
        .find(|r| git(repo, &["rev-parse", "--verify", "--quiet", r]).is_some())
}

pub fn status(cfg: &UpdateSettings) -> UpdateStatus {
    let mut st = UpdateStatus {
        repo: cfg.repo.clone(),
        problem: None,
        running: short(BUILD_COMMIT),
        branch: None,
        dirty: false,
        latest: None,
        behind: None,
        can_update: false,
        reason: None,
    };
    let repo = match cfg.validate() {
        Ok(p) => p,
        Err(e) => {
            let msg = e.to_string();
            st.problem = Some(msg.clone());
            st.reason = Some(msg);
            return st;
        }
    };
    st.branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    st.dirty = git(&repo, &["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|s| !s.is_empty());
    if let Some(r) = main_ref(&repo) {
        st.latest = git(&repo, &["rev-parse", r]).map(|s| short(&s));
        if BUILD_COMMIT != "unknown" {
            st.behind = git(
                &repo,
                &["rev-list", "--count", &format!("{BUILD_COMMIT}..{r}")],
            )
            .and_then(|n| n.parse().ok());
        }
    }
    st.reason = match st.branch.as_deref() {
        None => Some("git could not read the source folder".into()),
        Some(b) if b != "main" => Some(format!(
            "the source folder is on branch {b}; switch it to main to update"
        )),
        _ if st.dirty => Some(
            "the source folder has changes that are not committed; commit or undo them first"
                .into(),
        ),
        _ => None,
    };
    st.can_update = st.reason.is_none();
    st
}

/// Fetch main from GitHub (read-only), then report.
pub fn check(cfg: &UpdateSettings) -> AppResult<UpdateStatus> {
    let repo = cfg.validate()?;
    git(&repo, &["fetch", "--quiet", "origin", "main"])
        .ok_or_else(|| AppError::invalid("could not reach GitHub to check for updates"))?;
    Ok(status(cfg))
}

/// Open the update window. Tether closes and reopens when it finishes.
pub fn run(cfg: &UpdateSettings) -> AppResult<()> {
    let st = status(cfg);
    if !st.can_update {
        return Err(AppError::invalid(
            st.reason
                .unwrap_or_else(|| "cannot update right now".into()),
        ));
    }
    let repo = cfg.validate()?;
    launch(&repo)
}

#[cfg(windows)]
fn launch(repo: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let spawn = |flags: u32| {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(repo.join(SCRIPT))
            .args(["-Pull", "-FromApp"])
            .current_dir(repo)
            .creation_flags(flags)
            .spawn()
    };
    // The window must outlive Tether (the script closes it), so leave any job Tether is in when allowed.
    spawn(CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(CREATE_NEW_CONSOLE))
        .map(|_| ())
        .map_err(|e| AppError::invalid(format!("could not start the update: {e}")))
}

#[cfg(not(windows))]
fn launch(_repo: &Path) -> AppResult<()> {
    Err(AppError::invalid(
        "updating from source works on Windows only",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_source_folder() {
        let bad = UpdateSettings {
            repo: "relative/path".into(),
        };
        assert!(bad.validate().is_err());
        let st = status(&bad);
        assert!(!st.can_update && st.problem.is_some());

        let dir = std::env::temp_dir().join(format!("tether-upd-{}", crate::model::new_id()));
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        let cfg = UpdateSettings {
            repo: dir.display().to_string(),
        };
        assert!(cfg.validate().is_err(), "no script yet");
        std::fs::write(dir.join(SCRIPT), "").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        assert_eq!(cfg.validate().unwrap(), dir);
        // Not a git checkout: the folder is valid but the button stays off with a reason.
        let st = status(&cfg);
        assert!(st.problem.is_none());
        assert!(!st.can_update);
        assert!(st.reason.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn default_folder_is_where_it_was_built() {
        assert_eq!(UpdateSettings::default().repo, BUILD_SOURCE);
        assert!(!BUILD_COMMIT.is_empty());
    }
}
