-- 004: per-task reminders and Claude's context kept apart from the user's notes.
-- reminder_lead: NULL = the app default; 0..1440 = minutes before the due time; -1 = the morning of the due day.
ALTER TABLE tasks ADD COLUMN reminder_lead INTEGER
  CHECK (reminder_lead IS NULL OR reminder_lead = -1 OR reminder_lead BETWEEN 0 AND 1440);
-- reminder_repeat: once overdue, remind every working day at the start of work until done.
ALTER TABLE tasks ADD COLUMN reminder_repeat INTEGER NOT NULL DEFAULT 0 CHECK (reminder_repeat IN (0, 1));
-- claude_context: JSON from an approved Claude suggestion (said, completed, remaining, why, resumeHint ...).
ALTER TABLE tasks ADD COLUMN claude_context TEXT;
