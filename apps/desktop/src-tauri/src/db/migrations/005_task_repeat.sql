-- 005: repeating tasks. When a repeating task is completed, the next copy is created with a due date
-- counted from the completion date: repeat_every x repeat_unit (day, weekday = working day, week, month).
ALTER TABLE tasks ADD COLUMN repeat_every INTEGER CHECK (repeat_every IS NULL OR repeat_every BETWEEN 1 AND 365);
ALTER TABLE tasks ADD COLUMN repeat_unit TEXT
  CHECK (repeat_unit IS NULL OR repeat_unit IN ('day', 'weekday', 'week', 'month'));
-- The copy made when this task was completed, so completing again (after an undo) never makes two.
ALTER TABLE tasks ADD COLUMN repeat_next_id TEXT;
