-- Meetings captured from Google Meet captions by the Chrome extension.
-- The readable record is a note (kind 'meeting'); this table keeps the raw transcript and the
-- state of the background summary.
CREATE TABLE meetings (
  id             TEXT PRIMARY KEY,
  note_id        TEXT REFERENCES notes(id) ON DELETE SET NULL,
  dedupe_key     TEXT NOT NULL UNIQUE,
  meet_code      TEXT NOT NULL,
  title          TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT NOT NULL,
  segments_json  TEXT NOT NULL CHECK (json_valid(segments_json)),
  summary_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (summary_status IN ('pending','running','done','failed','off')),
  summary_error  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_meetings_note   ON meetings(note_id);
CREATE INDEX idx_meetings_status ON meetings(summary_status, created_at);
