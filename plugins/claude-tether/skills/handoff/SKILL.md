---
name: handoff
description: Save unfinished work as a Tether task for later. Use when the user stops for now ("that's enough for today", "finish this tomorrow", "park this", "hand off"), or asks to save where they are.
---

# Hand off to Tether

1. Call `get_project_context` (Tether MCP) to see this repo's open tasks and pending suggestions.
2. If an open task already covers this work, call `suggest_task_update` on it with an `appendNote`
   of progress and what remains (and a new `dueDate` if the user named one). Do not create a duplicate.
3. Otherwise call `suggest_task` with:
   - `title`: the specific piece of work, not "Continue work".
   - `completed`: what was done this session (concrete).
   - `remaining`: each step left, small enough to start cold.
   - `why`: why it matters, in one line, if known.
   - `resumeHint`: where to pick up — files, branch, failing test, the next command to run.
   - `dueDate`: only when the user named a time ("tomorrow" → that date as YYYY-MM-DD).
4. Tell the user it was sent to Tether for approval (not that a task was created), in one line.
