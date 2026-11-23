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
/// Shown in the note until the summary arrives.
pub const PLACEHOLDER: &str = "_Summary on the way…_";
/// The summary lives between these markers, so a new summary replaces only that part and user
/// edits elsewhere in the note stay.
const SUMMARY_START: &str = "<!-- tether:summary -->";
const SUMMARY_END: &str = "<!-- /tether:summary -->";
/// Room kept in the note for the summary block (at most ~22 KB after cleaning).
const SUMMARY_ROOM: usize = 30_000;

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

/// The transcript section, cut (on a character boundary) so the note stays under its size limit
/// with room for the summary. The full transcript is always kept with the meeting.
fn transcript_section(segments: &[Segment]) -> String {
    let full = transcript_md(segments);
    let budget = MAX_TEXT - SUMMARY_ROOM;
    if full.len() <= budget {
        return full;
    }
    let mut cut = budget - 200;
    while !full.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n\n_(The transcript is cut here to fit the note. The full text is kept with the meeting and used for the summary.)_\n",
        &full[..cut]
    )
}

fn summary_section(inner: &str) -> String {
    format!("{SUMMARY_START}\n{}\n{SUMMARY_END}", inner.trim_end())
}

/// Replace the marked summary section, or put one at the top when the markers are gone.
fn with_summary(body: &str, inner: &str) -> String {
    if let Some(i) = body.find(SUMMARY_START)
        && let Some(j) = body[i..].find(SUMMARY_END)
    {
        let end = i + j + SUMMARY_END.len();
        return format!("{}{}{}", &body[..i], summary_section(inner), &body[end..]);
    }
    format!("{}\n\n{}", summary_section(inner), body)
}

/// Replace the transcript section (from its heading to the end), or append one.
fn with_transcript(body: &str, segments: &[Segment]) -> String {
    let head = match body.find("## Transcript") {
        Some(i) => &body[..i],
        None => body,
    };
    format!("{}\n\n{}", head.trim_end(), transcript_section(segments))
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

/// Save a meeting and its note. Idempotent on `dedupe_key`: a retried upload returns the first;
/// an upload with new caption lines for a known key (a call that was sent early, then went on)
/// is merged in. `ai_on` decides whether the summary is queued ("pending") or not ("off").
pub fn create(conn: &Connection, input: &MeetingInput, ai_on: bool) -> AppResult<Meeting> {
    let key = input.dedupe_key.trim();
    if key.is_empty() || key.len() > 200 {
        return Err(AppError::invalid("dedupeKey must be 1-200 characters"));
    }
    if let Some((m, old)) = load(conn, "m.dedupe_key = ?1", key)? {
        return merge(conn, m, old, input, ai_on);
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
    let body = format!(
        "{}\n\n{}",
        summary_section(if ai_on { PLACEHOLDER } else { "" }),
        transcript_section(&segments)
    );
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

/// Add caption lines that are not stored yet; rebuild the note's transcript and queue a new summary.
fn merge(
    conn: &Connection,
    m: Meeting,
    mut segments: Vec<Segment>,
    input: &MeetingInput,
    ai_on: bool,
) -> AppResult<Meeting> {
    // A merged upload must be valid too, but an empty one (a plain retry) changes nothing.
    let incoming = match clean_segments(&input.segments) {
        Ok(v) => v,
        Err(_) => return Ok(m),
    };
    let known: std::collections::HashSet<(String, String, String)> = segments
        .iter()
        .map(|s| (s.speaker.clone(), s.text.clone(), s.at.clone()))
        .collect();
    let new: Vec<Segment> = incoming
        .into_iter()
        .filter(|s| !known.contains(&(s.speaker.clone(), s.text.clone(), s.at.clone())))
        .collect();
    if new.is_empty() {
        return Ok(m);
    }
    segments.extend(new);
    segments.sort_by(|a, b| a.at.cmp(&b.at));
    if segments.len() > MAX_SEGMENTS {
        return Err(AppError::invalid("the meeting has too many caption lines"));
    }
    let ended = if input.ended_at.trim() > m.ended_at.as_str() {
        input.ended_at.trim().to_string()
    } else {
        m.ended_at.clone()
    };
    // A running summary sees "pending" when it finishes and leaves the note alone; the worker
    // then summarises the whole meeting again.
    let status = if ai_on { "pending" } else { "off" };
    conn.execute(
        "UPDATE meetings SET segments_json = ?2, ended_at = ?3, summary_status = ?4,
            summary_error = NULL, updated_at = ?5 WHERE id = ?1",
        params![
            m.id,
            serde_json::to_string(&segments).map_err(|e| AppError::invalid(e.to_string()))?,
            ended,
            status,
            now_utc()
        ],
    )?;
    if let Some(note_id) = &m.note_id
        && let Ok(note) = notes::get(conn, note_id)
    {
        let body = with_transcript(&note.body_md, &segments);
        notes::update(conn, note_id, &note_input(&note, body))?;
    }
    get(conn, &m.id)
}

fn note_input(note: &crate::model::Note, body_md: String) -> NoteInput {
    NoteInput {
        title: note.title.clone(),
        body_md,
        kind: Some(note.kind),
        project_id: note.project_id.clone(),
        task_id: note.task_id.clone(),
        tags: note.tags.clone(),
        source_url: note.source_url.clone(),
    }
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

/// Record a failed local summary, unless new captions re-queued the meeting meanwhile.
pub fn fail(conn: &Connection, id: &str, message: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE meetings SET summary_status = 'failed', summary_error = ?2, updated_at = ?3
         WHERE id = ?1 AND summary_status = 'running'",
        params![id, clip(message, 500), now_utc()],
    )?;
    Ok(())
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

/// The user's own item? Claude Code is asked for the user's items only, so a missing owner means
/// the user; the local model must name the owner ("You").
fn is_users(owner: &Option<String>, origin: Origin) -> bool {
    match owner.as_deref().map(str::trim) {
        None | Some("") => origin != Origin::Ai,
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

fn summary_md(s: &MeetingSummary, origin: Origin) -> String {
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
            if is_users(&a.owner, origin) {
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
    // The local worker only writes while its claim stands: if new captions arrived (pending) or
    // Claude Code already wrote a summary (done), its result is stale.
    if origin == Origin::Ai && m.summary_status != "running" {
        return Ok(0);
    }
    let s = clean_summary(summary);
    if s.summary.is_empty() {
        return Err(AppError::invalid("summary is required"));
    }
    if let Some(note_id) = &m.note_id
        && let Ok(note) = notes::get(conn, note_id)
    {
        let body = with_summary(&note.body_md, &summary_md(&s, origin));
        notes::update(conn, note_id, &note_input(&note, body))?;
    }
    let mut created = 0;
    for a in s.action_items.iter().filter(|a| is_users(&a.owner, origin)) {
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
        assert!(note.body_md.contains(PLACEHOLDER));
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
    fn later_captions_with_the_same_key_are_merged() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k5"), true)).unwrap();
        let mut more = input("meet:k5");
        more.ended_at = "2026-11-23T11:00:00Z".into();
        more.segments = vec![seg("You", "One more thing.", "2026-11-23T10:40:00Z")];
        let merged = db.write(|c| create(c, &more, true)).unwrap();
        assert_eq!(merged.id, m.id);
        assert_eq!(merged.segment_count, 4);
        assert_eq!(merged.ended_at, "2026-11-23T11:00:00Z");
        let note = db
            .read(|c| notes::get(c, m.note_id.as_deref().unwrap()))
            .unwrap();
        assert!(note.body_md.contains("One more thing."));
        assert_eq!(note.body_md.matches("## Transcript").count(), 1);
        // The same upload again changes nothing.
        let again = db.write(|c| create(c, &more, true)).unwrap();
        assert_eq!(again.segment_count, 4);
    }

    #[test]
    fn stale_local_summary_is_ignored_and_user_edits_stay() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k6"), true)).unwrap();
        let note_id = m.note_id.clone().unwrap();
        // The user writes their own line above the summary.
        db.write(|c| {
            let n = notes::get(c, &note_id)?;
            let body = format!("My own notes.\n\n{}", n.body_md);
            notes::update(c, &note_id, &note_input(&n, body))
        })
        .unwrap();
        let s = MeetingSummary {
            summary: "First.".into(),
            ..Default::default()
        };
        // Not claimed by the worker: a local result is ignored.
        assert_eq!(
            db.write(|c| apply_summary(c, &m.id, &s, Origin::Ai))
                .unwrap(),
            0
        );
        assert_eq!(
            db.read(|c| get(c, &m.id)).unwrap().summary_status,
            "pending"
        );
        db.write(|c| apply_summary(c, &m.id, &s, Origin::Claude))
            .unwrap();
        let s2 = MeetingSummary {
            summary: "Second.".into(),
            ..Default::default()
        };
        db.write(|c| apply_summary(c, &m.id, &s2, Origin::Claude))
            .unwrap();
        let body = db.read(|c| notes::get(c, &note_id)).unwrap().body_md;
        assert!(body.starts_with("My own notes."));
        assert!(body.contains("Second.") && !body.contains("First."));
        assert!(body.contains("## Transcript"));
    }

    #[test]
    fn local_items_without_owner_are_not_suggested() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k7"), true)).unwrap();
        db.write(|c| claim_next(c)).unwrap();
        let s = MeetingSummary {
            summary: "x".into(),
            action_items: vec![ActionItem {
                title: "Someone's job".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            db.write(|c| apply_summary(c, &m.id, &s, Origin::Ai))
                .unwrap(),
            0
        );
    }

    #[test]
    fn very_long_meetings_leave_room_for_the_summary() {
        let db = db();
        let mut i = input("meet:k8");
        i.segments = (0..2000)
            .map(|n| {
                seg(
                    if n % 2 == 0 { "You" } else { "Sarah" },
                    &"word ".repeat(40),
                    &format!("2026-11-23T10:{:02}:{:02}Z", (n / 60) % 60, n % 60),
                )
            })
            .collect();
        let m = db.write(|c| create(c, &i, true)).unwrap();
        db.write(|c| claim_next(c)).unwrap();
        let big = MeetingSummary {
            summary: "s".repeat(4000),
            decisions: vec!["d".repeat(500); 20],
            action_items: (0..30)
                .map(|n| ActionItem {
                    title: format!("{n} {}", "t".repeat(190)),
                    owner: Some("You".into()),
                    ..Default::default()
                })
                .collect(),
        };
        db.write(|c| apply_summary(c, &m.id, &big, Origin::Ai))
            .unwrap();
        let body = db
            .read(|c| notes::get(c, m.note_id.as_deref().unwrap()))
            .unwrap()
            .body_md;
        assert!(body.len() <= MAX_TEXT);
        assert!(body.contains("transcript is cut here"));
    }

    #[test]
    fn requeue_and_resummarise() {
        let db = db();
        let m = db.write(|c| create(c, &input("meet:k4"), true)).unwrap();
        db.write(|c| claim_next(c)).unwrap();
        assert_eq!(db.write(|c| requeue_running(c)).unwrap(), 1);
        db.write(|c| claim_next(c)).unwrap();
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
