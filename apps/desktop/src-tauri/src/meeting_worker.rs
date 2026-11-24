//! Summarises saved meetings with the local AI, one at a time, in the background. The meeting
//! note already exists; this only adds the summary and the action-item suggestions.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::{
    DATA_CHANGED,
    ai::{self, AiSettings},
    error::AppResult,
    model::Origin,
    repo::meetings,
    state::AppState,
};

const POLL: Duration = Duration::from_secs(20);

pub fn start(app: AppHandle, state: AppState) {
    if let Err(e) = state.db.write(|c| meetings::requeue_running(c)) {
        log::warn!("could not requeue meeting summaries: {e}");
    }
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(POLL);
        loop {
            tick.tick().await;
            let st = state.clone();
            let changed = tokio::task::spawn_blocking(move || drain(&st))
                .await
                .unwrap_or(false);
            if changed {
                let _ = app.emit(DATA_CHANGED, ());
            }
        }
    });
}

/// Work through every waiting meeting. Returns true if anything changed.
fn drain(state: &AppState) -> bool {
    let mut changed = false;
    loop {
        let id = match state.db.write(|c| meetings::claim_next(c)) {
            Ok(Some(id)) => id,
            Ok(None) => return changed,
            Err(e) => {
                log::warn!("meeting queue: {e}");
                return changed;
            }
        };
        changed = true;
        if let Err(e) = summarise_one(state, &id) {
            // The message is about Ollama or the model, never transcript text.
            log::warn!("meeting summary failed: {e}");
            let _ = state.db.write(|c| meetings::fail(c, &id, &e.to_string()));
        }
    }
}

fn summarise_one(state: &AppState, id: &str) -> AppResult<()> {
    let cfg = state.db.read(AiSettings::load)?;
    if !cfg.enabled {
        state.db.write(|c| meetings::resummarise(c, id, false))?;
        return Ok(());
    }
    let (m, segments) = state.db.read(|c| meetings::get_with_segments(c, id))?;
    let lines = meetings::transcript_lines(&segments);
    let date = m.started_at.get(..10).unwrap_or_default().to_string();
    // Long: several model calls on a slow PC. The database is not locked meanwhile.
    let summary = ai::summarise_meeting(&cfg, &lines, &date)?;
    let n = state
        .db
        .write(|c| meetings::apply_summary(c, id, &summary, Origin::Ai))?;
    log::info!("meeting summarised; {n} action items suggested");
    Ok(())
}
