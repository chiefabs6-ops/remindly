---
name: breakdown
description: Break a Tether task into concrete subtasks. Use when the user asks to break down, split up or plan the steps of a task in Tether.
---

# Break a Tether task into steps

1. Find the task: `search_tasks` with words from the user's request (or use the id they gave), then
   `get_task` to read its description, notes and existing subtasks.
2. Write 3–8 concrete next steps. Each is a short imperative action someone could start cold.
   Use what the task and its notes say, plus what you know of this repository if the task is about
   it. Skip steps that already exist as subtasks.
3. Call `suggest_task_update` with the task id and `addSubtasks`.
4. Tell the user the steps were sent to Tether for approval, in one line.
