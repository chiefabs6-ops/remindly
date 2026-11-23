//! Meetings captured from Google Meet captions. Saving one writes a meeting note at once
//! (transcript only); the summary, decisions and the user's own action items are added later by
//! the background worker (local AI) or by Claude Code, and the action items arrive as task
//! suggestions the user approves.

use chrono::{DateTime, Local};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    error::{AppError, AppResult},
    model::{
        MAX_TEXT, NewSuggestion, NoteInput, NoteKind, Origin, Source, SuggestionKind, clean_date,
        clean_title, new_id, now_utc,
    },
    repo::{notes, suggestions},
};

pub const MAX_SEGMENTS: usize = 5000;
const MAX_SPEAKER: usize = 100;
const MAX_SEGMENT_TEXT: usize = 4000;
/// Shown in the note until the summary arrives; replaced in place so user edits elsewhere stay.
pub const PLACEHOLDER: &str = "_Summary on the way…_";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub speaker: String,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingInput {
    pub dedupe_key: String,
    pub meet_code: String,
    #[serde(default)]
    pub title: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub note_id: Option<String>,
    pub meet_code: String,
    pub title: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub summary_status: String,
    pub summary_error: Option<String>,
    pub segment_count: usize,
    pub suggestion_count: usize,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ActionItem {
    pub title: String,
    pub due_date: Option<String>,
    pub quote: Option<String>,
    /// Speaker name as in the transcript; "You" is the user. None means "the user's" (Claude
    /// Code is asked to return only the user's items).
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingSummary {
    pub summary: String,
    pub decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn parse_time(field: &str, v: &str) -> AppResult<DateTime<Local>> {
    DateTime::parse_from_rfc3339(v.trim())
        .map(|d| d.with_timezone(&Local))
        .map_err(|_| AppError::invalid(format!("{field} must be an RFC 3339 time")))
}

fn valid_meet_code(code: &str) -> bool {
    let parts: Vec<&str> = code.split('-').collect();
    parts.len() == 3
        && [3, 4, 3]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_lowercase()))
}

/// Clean segments: trim, cap, drop empties, keep time order.
fn clean_segments(input: &[Segment]) -> AppResult<Vec<Segment>> {
    if input.is_empty() {
        return Err(AppError::invalid("the meeting has no captions"));
    }
    if input.len() > MAX_SEGMENTS {
        return Err(AppError::invalid("the meeting has too many caption lines"));
    }
    let mut out = Vec::with_capacity(input.len());
    for s in input {
        let text = s.text.split_whitespace().collect::<Vec<_>>().join(" ");
        // Skip one bad line rather than lose the whole meeting.
        if text.is_empty() || parse_time("segment time", &s.at).is_err() {
            continue;
        }
        let speaker = clip(&s.speaker, MAX_SPEAKER);
        out.push(Segment {
            speaker: if speaker.is_empty() {
                "Someone".into()
            } else {
                speaker
            },
            text: clip(&text, MAX_SEGMENT_TEXT),
            at: s.at.trim().to_string(),
        });
    }
    if out.is_empty() {
        return Err(AppError::invalid("the meeting has no captions"));
    }
    out.sort_by(|a, b| a.at.cmp(&b.at));
    Ok(out)
}

/// Consecutive lines from the same speaker, joined: (speaker, first time, text).
fn turns(segments: &[Segment]) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    for s in segments {
        match out.last_mut() {
            Some((sp, _, text)) if *sp == s.speaker => {
                text.push(' ');
                text.push_str(&s.text);
            }
            _ => out.push((s.speaker.clone(), s.at.clone(), s.text.clone())),
        }
    }
    out
}

fn hhmm(at: &str) -> String {
    parse_time("time", at)
        .map(|d| d.format("%H:%M").to_string())
        .unwrap_or_default()
}

fn transcript_md(segments: &[Segment]) -> String {
    let mut md = String::from("## Transcript\n");
    for (speaker, at, text) in turns(segments) {
        md.push_str(&format!(
            "\n**{}** · {}\n{}\n",
            speaker.replace('*', ""),
            hhmm(&at),
            text
        ));
    }
    md
}

/// Plain transcript for the AI and Claude Code: "[10:02] You: text" per turn.
pub fn transcript_lines(segments: &[Segment]) -> Vec<String> {
    turns(segments)
        .into_iter()
        .map(|(speaker, at, text)| format!("[{}] {}: {}", hhmm(&at), speaker, text))
        .collect()
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<(Meeting, String)> {
    let segments_json: String = r.get(7)?;
    Ok((
        Meeting {
            id: r.get(0)?,
            note_id: r.get(1)?,
            meet_code: r.get(2)?,
            title: r.get(3)?,
            started_at: r.get(4)?,
            ended_at: r.get(5)?,
            summary_status: r.get(6)?,
            summary_error: r.get(8)?,
            segment_count: 0,
            suggestion_count: r.get::<_, i64>(9)? as usize,
        },
        segments_json,
    ))
}

const SELECT: &str = "SELECT m.id, m.note_id, m.meet_code, m.title, m.started_at, m.ended_at,
    m.summary_status, m.segments_json, m.summary_error,
    (SELECT count(*) FROM suggestions s
      WHERE json_extract(s.context_json, '$.meeting.meetingId') = m.id) AS n
    FROM meetings m";

fn load(
    conn: &Connection,
    where_sql: &str,
    arg: &str,
) -> AppResult<Option<(Meeting, Vec<Segment>)>> {
    let row = conn
        .query_row(&format!("{SELECT} WHERE {where_sql}"), [arg], from_row)
        .optional()?;
    match row {
        None => Ok(None),
        Some((mut m, json)) => {
            let segments: Vec<Segment> = serde_json::from_str(&json).unwrap_or_default();
            m.segment_count = segments.len();
            Ok(Some((m, segments)))
        }
    }
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Meeting> {
    load(conn, "m.id = ?1", id)?
        .map(|(m, _)| m)
        .ok_or_else(|| AppError::NotFound("meeting".into()))
}

pub fn get_with_segments(conn: &Connection, id: &str) -> AppResult<(Meeting, Vec<Segment>)> {
    load(conn, "m.id = ?1", id)?.ok_or_else(|| AppError::NotFound("meeting".into()))
}

pub fn for_note(conn: &Connection, note_id: &str) -> AppResult<Option<Meeting>> {
    Ok(load(conn, "m.note_id = ?1", note_id)?.map(|(m, _)| m))
}

/// Save a meeting and its note. Idempotent on `dedupe_key`: a retried upload returns the first.
/// `ai_on` decides whether the summary is queued ("pending") or not ("off").
pub fn create(conn: &Connection, input: &MeetingInput, ai_on: bool) -> AppResult<Meeting> {
    let key = input.dedupe_key.trim();
    if key.is_empty() || key.len() > 200 {
        return Err(AppError::invalid("dedupeKey must be 1-200 characters"));
    }
    if let Some((m, _)) = load(conn, "m.dedupe_key = ?1", key)? {
        return Ok(m);
    }
    let code = input.meet_code.trim();
    if !valid_meet_code(code) {
        return Err(AppError::invalid("meetCode must look like abc-defg-hij"));
    }
    let started = parse_time("startedAt", &input.started_at)?;
    let ended = parse_time("endedAt", &input.ended_at)?;
    if ended < started {
        return Err(AppError::invalid("endedAt is before startedAt"));
    }
    let segments = clean_segments(&input.segments)?;
    let title = input
        .title
        .as_deref()
        .map(|t| clip(t, 200))
        .filter(|t| !t.is_empty());
    let note_title = match &title {
        Some(t) => t.clone(),
        None => format!(
            "Meeting {}",
            started.format("%e %b %H:%M").to_string().trim()
        ),
    };
    let mut body = String::new();
    if ai_on {
        body.push_str(PLACEHOLDER);
        body.push_str("\n\n");
    }
    body.push_str(&transcript_md(&segments));
    if body.len() > MAX_TEXT {
        // Keep the newest part out of the note rather than refuse; the raw transcript is kept.
        body = body.chars().take(MAX_TEXT / 4).collect();
        body.push_str("\n\n_(Transcript cut here; the full text is kept with the meeting.)_");
    }
    let note = notes::create(
        conn,
        &NoteInput {
            title: note_title,
            body_md: body,
            kind: Some(NoteKind::Meeting),
            source_url: Some(format!("https://meet.google.com/{code}")),
            ..Default::default()
        },
        Source::Chrome,
    )?;
    let id = new_id();
    let now = now_utc();
    conn.execute(
        "INSERT INTO meetings(id, note_id, dedupe_key, meet_code, title, started_at, ended_at,
            segments_json, summary_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            note.id,
            key,
            code,
            title,
            input.started_at.trim(),
            input.ended_at.trim(),
            serde_json::to_string(&segments).map_err(|e| AppError::invalid(e.to_string()))?,
            if ai_on { "pending" } else { "off" },
            now
        ],
    )?;
    get(conn, &id)
}

fn set_status(conn: &Connection, id: &str, status: &str, error: Option<&str>) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE meetings SET summary_status = ?2, summary_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, error, now_utc()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("meeting".into()));
    }
    Ok(())
}

/// Take the oldest meeting waiting for a summary and mark it running.
pub fn claim_next(conn: &Connection) -> AppResult<Option<String>> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM meetings WHERE summary_status = 'pending' ORDER BY created_at LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = &id {
        set_status(conn, id, "running", None)?;
    }
    Ok(id)
}

/// After a restart nothing is running any more: put interrupted work back in the queue.
pub fn requeue_running(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE meetings SET summary_status = 'pending', updated_at = ?1 WHERE summary_status = 'running'",
        [now_utc()],
    )?)
}

pub fn fail(conn: &Connection, id: &str, message: &str) -> AppResult<()> {
    set_status(conn, id, "failed", Some(&clip(message, 500)))
}

/// "Try again": queue the local summary (or report that the local AI is off).
pub fn resummarise(conn: &Connection, id: &str, ai_on: bool) -> AppResult<Meeting> {
    let m = get(conn, id)?;
    if m.summary_status == "running" {
        return Ok(m);
    }
    set_status(conn, id, if ai_on { "pending" } else { "off" }, None)?;
    get(conn, id)
}

fn is_users(owner: &Option<String>) -> bool {
    match owner.as_deref().map(str::trim) {
        None | Some("") => true,
        Some(o) => ["you", "me", "i"].contains(&o.to_lowercase().as_str()),
    }
}

/// Clamp model or client output to safe sizes. Never trust it.
pub fn clean_summary(s: &MeetingSummary) -> MeetingSummary {
    let mut seen = std::collections::HashSet::new();
    MeetingSummary {
        summary: clip(&s.summary, 4000),
        decisions: s
            .decisions
            .iter()
            .map(|d| clip(d, 500))
            .filter(|d| !d.is_empty())
            .take(20)
            .collect(),
        action_items: s
            .action_items
            .iter()
            .filter_map(|a| {
                let title = clean_title(&clip(&a.title, 200)).ok()?;
                if !seen.insert(title.to_lowercase()) {
                    return None;
                }
                Some(ActionItem {
                    title,
                    due_date: clean_date("due date", &a.due_date).unwrap_or(None),
                    quote: a
                        .quote
                        .as_deref()
                        .map(|q| clip(q, 500))
                        .filter(|q| !q.is_empty()),
                    owner: a
                        .owner
                        .as_deref()
                        .map(|o| clip(o, MAX_SPEAKER))
                        .filter(|o| !o.is_empty()),
                })
            })
            .take(30)
            .collect(),
    }
}

fn summary_md(s: &MeetingSummary) -> String {
    let mut md = format!("## Summary\n{}\n", s.summary.trim());
    if !s.decisions.is_empty() {
        md.push_str("\n## Decisions\n");
        for d in &s.decisions {
            md.push_str(&format!("- {d}\n"));
        }
    }
    if !s.action_items.is_empty() {
        md.push_str("\n## Action items\n");
        for a in &s.action_items {
            let due = a
                .due_date
                .as_deref()
                .map(|d| format!(" (due {d})"))
                .unwrap_or_default();
            if is_users(&a.owner) {
                md.push_str(&format!("- [ ] {}{due}\n", a.title));
            } else {
                md.push_str(&format!(
                    "- ({}) {}{due}\n",
                    a.owner.as_deref().unwrap_or(""),
                    a.title
                ));
            }
        }
    }
    md
}

/// Write the summary into the note and suggest the user's own action items as tasks.
/// Returns how many suggestions were created (retries never duplicate them).
pub fn apply_summary(
    conn: &Connection,
    id: &str,
    summary: &MeetingSummary,
    origin: Origin,
) -> AppResult<usize> {
    let m = get(conn, id)?;
    let s = clean_summary(summary);
    if s.summary.is_empty() {
        return Err(AppError::invalid("summary is required"));
    }
    if let Some(note_id) = &m.note_id
        && let Ok(note) = notes::get(conn, note_id)
    {
        {
            let block = summary_md(&s);
            let body = if note.body_md.contains(PLACEHOLDER) {
                note.body_md.replacen(PLACEHOLDER, block.trim_end(), 1)
            } else if let Some(i) = note.body_md.find("## Summary\n") {
                // A new summary replaces the old one, up to the transcript.
                let end = note.body_md[i..]
                    .find("## Transcript")
                    .map(|j| i + j)
                    .unwrap_or(note.body_md.len());
                format!(
                    "{}{}\n\n{}",
                    &note.body_md[..i],
                    block.trim_end(),
                    &note.body_md[end..]
                )
            } else {
                format!("{}\n\n{}", block.trim_end(), note.body_md)
            };
            notes::update(
                conn,
                note_id,
                &NoteInput {
                    title: note.title.clone(),
                    body_md: body,
                    kind: Some(note.kind),
                    project_id: note.project_id.clone(),
                    task_id: note.task_id.clone(),
                    tags: note.tags.clone(),
                    source_url: note.source_url.clone(),
                },
            )?;
        }
    }
    let mut created = 0;
    for a in s.action_items.iter().filter(|a| is_users(&a.owner)) {
        let key: String = format!("meeting:{id}:{}", a.title.to_lowercase())
            .chars()
            .take(200)
            .collect();
        let before: i64 = conn.query_row(
            "SELECT count(*) FROM suggestions WHERE dedupe_key = ?1",
            [&key],
            |r| r.get(0),
        )?;
        suggestions::create(
            conn,
            &NewSuggestion {
                kind: SuggestionKind::Task,
                origin,
                target_task_id: None,
                payload: json!({
                    "title": a.title,
                    "dueDate": a.due_date,
                    "sourceUrl": format!("https://meet.google.com/{}", m.meet_code),
                    "sourceTitle": m.title,
                    "sourceSelection": a.quote,
                }),
                context: Some(json!({
                    "meeting": { "meetingId": m.id, "noteId": m.note_id, "title": m.title },
                    "quote": a.quote,
                })),
                confidence: None,
                dedupe_key: Some(key),
                captured_at: None,
            },
        )?;
        if before == 0 {
            created += 1;
        }
    }
    set_status(conn, id, "done", None)?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_util::db;

    fn seg(speaker: &str, text: &str, at: &str) -> Segment {
        Segment {
            speaker: speaker.into(),
            text: text.into(),
            at: at.into(),
        }
    }

    fn input(key: &str) -> MeetingInput {
        MeetingInput {
            dedupe_key: key.into(),
            meet_code: "abc-defg-hij".into(),
            title: Some("Weekly sync".into()),
            started_at: "2026-11-23T10:00:00Z".into(),
            ended_at: "2026-11-23T10:30:00Z".into(),
            segments: vec![
                seg("Sarah", "Can you send the report", "2026-11-23T10:01:00Z"),
                seg("Sarah", "by Friday?", "2026-11-23T10:01:05Z"),
                seg("You", "Yes, I'll send it Friday.", "2026-11-23T10:01:10Z"),
                seg("You", "   ", "2026-11-23T10:01:20Z"),
            ],
        }
    }

    #[test]
    fn create_saves_note_and_is_idempotent() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k1"), true)).unwrap();
        assert_eq!(m.summary_status, "pending");
        assert_eq!(m.segment_count, 3);
        let again = db.write(|c| create(c, &input("meet:k1"), true)).unwrap();
        assert_eq!(again.id, m.id);
        let note = db
            .read(|c| notes::get(c, m.note_id.as_deref().unwrap()))
            .unwrap();
        assert_eq!(note.title, "Weekly sync");
        assert_eq!(note.kind, NoteKind::Meeting);
        assert!(note.body_md.starts_with(PLACEHOLDER));
        assert!(note.body_md.contains("**Sarah**"));
        assert!(note.body_md.contains("Can you send the report by Friday?"));
        let off = db.write(|c| create(c, &input("meet:k2"), false)).unwrap();
        assert_eq!(off.summary_status, "off");
    }

    #[test]
    fn bad_input_is_rejected() {
        let db = db();
        let mut i = input("meet:x");
        i.meet_code = "https://evil".into();
        assert!(db.write(|c| create(c, &i, true)).is_err());
        let mut i = input("meet:x");
        i.segments = vec![seg("You", "  ", "2026-11-23T10:00:00Z")];
        assert!(db.write(|c| create(c, &i, true)).is_err());
        let mut i = input("meet:x");
        i.ended_at = "2026-11-23T09:00:00Z".into();
        assert!(db.write(|c| create(c, &i, true)).is_err());
    }

    #[test]
    fn summary_goes_into_note_and_only_own_items_become_suggestions() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k3"), true)).unwrap();
        assert_eq!(
            db.write(|c| claim_next(c)).unwrap().as_deref(),
            Some(m.id.as_str())
        );
        let s = MeetingSummary {
            summary: "Agreed the report goes out Friday.".into(),
            decisions: vec!["Report goes out Friday".into()],
            action_items: vec![
                ActionItem {
                    title: "Send the report".into(),
                    due_date: Some("2026-11-27".into()),
                    quote: Some("I'll send it Friday".into()),
                    owner: Some("You".into()),
                },
                ActionItem {
                    title: "Book the room".into(),
                    owner: Some("Sarah".into()),
                    ..Default::default()
                },
            ],
        };
        let n = db
            .write(|c| apply_summary(c, &m.id, &s, Origin::Ai))
            .unwrap();
        assert_eq!(n, 1);
        // A retry does not duplicate suggestions.
        assert_eq!(
            db.write(|c| apply_summary(c, &m.id, &s, Origin::Ai))
                .unwrap(),
            0
        );
        let got = db.read(|c| get(c, &m.id)).unwrap();
        assert_eq!(got.summary_status, "done");
        assert_eq!(got.suggestion_count, 1);
        let note = db
            .read(|c| notes::get(c, m.note_id.as_deref().unwrap()))
            .unwrap();
        assert!(!note.body_md.contains(PLACEHOLDER));
        assert_eq!(note.body_md.matches("## Summary").count(), 1);
        assert!(
            note.body_md
                .contains("- [ ] Send the report (due 2026-11-27)")
        );
        assert!(note.body_md.contains("- (Sarah) Book the room"));
        assert!(note.body_md.contains("## Transcript"));
    }

    #[test]
    fn requeue_and_resummarise() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k4"), true)).unwrap();
        db.write(|c| claim_next(c)).unwrap();
        assert_eq!(db.write(|c| requeue_running(c)).unwrap(), 1);
        db.write(|c| fail(c, &m.id, "Ollama is not running"))
            .unwrap();
        let f = db.read(|c| get(c, &m.id)).unwrap();
        assert_eq!(f.summary_status, "failed");
        let r = db.write(|c| resummarise(c, &m.id, false)).unwrap();
        assert_eq!(r.summary_status, "off");
        assert_eq!(r.summary_error, None);
    }

    #[test]
    fn transcript_lines_join_turns() {
        let i = input("k");
        let lines = transcript_lines(&clean_segments(&i.segments).unwrap());
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("Sarah: Can you send the report by Friday?"));
    }
}
