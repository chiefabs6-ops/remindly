-- 003: links on tasks (web pages the user attached). File attachments come later.
CREATE TABLE task_links (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url        TEXT NOT NULL CHECK (url LIKE 'http://%' OR url LIKE 'https://%'),
  title      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_links_task ON task_links(task_id);
