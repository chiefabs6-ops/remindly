-- Tether schema v1. Timestamps are UTC RFC 3339 strings; dates are local YYYY-MM-DD; times HH:MM.
-- IDs are ULIDs (TEXT). Tables keep the implicit rowid so FTS5 external-content tables can index them.

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color       TEXT
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  color       TEXT,
  icon        TEXT,
  description TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  sort_order  REAL NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  color TEXT
);

CREATE TABLE code_projects (
  id           TEXT PRIMARY KEY,
  root_dir     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL,
  git_remote   TEXT,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  parent_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title            TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description      TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'not_started'
                   CHECK (status IN ('inbox','not_started','in_progress','waiting','completed','archived')),
  priority         INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  due_date         TEXT CHECK (due_date IS NULL OR date(due_date) = due_date),
  due_time         TEXT CHECK (due_time IS NULL OR (due_date IS NOT NULL AND time(due_time) IS NOT NULL)),
  scheduled_date   TEXT CHECK (scheduled_date IS NULL OR date(scheduled_date) = scheduled_date),
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','chrome','claude','note','ai')),
  source_url       TEXT,
  source_title     TEXT,
  source_selection TEXT,
  code_project_id  TEXT REFERENCES code_projects(id) ON DELETE SET NULL,
  note_id          TEXT REFERENCES notes(id) ON DELETE SET NULL,
  sort_order       REAL NOT NULL DEFAULT 0,
  completed_at     TEXT,
  archived_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_tasks_parent   ON tasks(parent_id);
CREATE INDEX idx_tasks_project  ON tasks(project_id);
CREATE INDEX idx_tasks_status   ON tasks(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due      ON tasks(due_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_sched    ON tasks(scheduled_date) WHERE deleted_at IS NULL;

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title      TEXT NOT NULL DEFAULT '',
  body_md    TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'general'
             CHECK (kind IN ('general','meeting','idea','research','work')),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','chrome','claude','ai')),
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_notes_project ON notes(project_id);
CREATE INDEX idx_notes_task    ON notes(task_id);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE suggestions (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('task','task_update','note')),
  origin                TEXT NOT NULL CHECK (origin IN ('chrome','claude','ai','note')),
  target_task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  payload_json          TEXT NOT NULL CHECK (json_valid(payload_json)),
  context_json          TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  confidence_json       TEXT CHECK (confidence_json IS NULL OR json_valid(confidence_json)),
  dedupe_key            TEXT,
  possible_duplicate_of TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  resulting_id          TEXT,
  created_at            TEXT NOT NULL,
  decided_at            TEXT
);
CREATE INDEX idx_suggestions_status ON suggestions(status, created_at);
CREATE UNIQUE INDEX idx_suggestions_pending_dedupe ON suggestions(dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('due_soon','due','overdue','custom','snooze','briefing','eod_review','nudge')),
  fire_at       TEXT NOT NULL,
  fired_at      TEXT,
  snoozed_until TEXT,
  dismissed_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_reminders_pending ON reminders(fired_at, fire_at);

CREATE TABLE task_history (
  id        INTEGER PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL CHECK (actor IN ('user','claude','chrome','system','ai')),
  action    TEXT NOT NULL,
  field     TEXT,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX idx_history_task ON task_history(task_id, at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

-- Full-text search. Trigram tokenizer gives substring matching (needs >= 3 characters).
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, notes, content='tasks', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.rowid, new.title, coalesce(new.description,''), coalesce(new.notes,''));
END;
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description,''), coalesce(old.notes,''));
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description, notes ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description,''), coalesce(old.notes,''));
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.rowid, new.title, coalesce(new.description,''), coalesce(new.notes,''));
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body_md, content='notes', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, body_md ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
