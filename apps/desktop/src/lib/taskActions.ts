// Task writes shared by My Tasks, the quick panel and the full page.
// Each one reads the task fresh from the backend first: another window (a pop-out task window)
// has its own cache, so building a full update from a cached copy could undo its edits.
import type { TaskInput, TaskStatus } from "@tether/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

/** Every editable field of a task, for a full update (absent = cleared on the backend). */
export function toTaskInput(t: TaskInput & { title: string }): TaskInput {
  return {
    title: t.title, description: t.description, notes: t.notes, status: t.status, priority: t.priority,
    dueDate: t.dueDate, dueTime: t.dueTime, scheduledDate: t.scheduledDate, projectId: t.projectId, tags: t.tags,
  };
}

/** Change some fields, keeping every other field as it is saved right now. */
export async function patchTask(id: string, p: Partial<TaskInput>) {
  const fresh = await api.task(id);
  return api.updateTask(id, { ...toTaskInput(fresh), ...p });
}

const isOpen = (s: TaskStatus) => s !== "completed" && s !== "archived";

/**
 * Complete a task and its open subtasks. Returns an undo that puts back the task's own
 * status and reopens exactly the subtasks this completed (each with its old status).
 */
export async function completeTask(id: string): Promise<() => Promise<void>> {
  const before = await api.task(id);
  const reopen = before.subtasks.filter((s) => isOpen(s.status)).map((s) => ({ id: s.id, status: s.status }));
  await api.setStatus(id, "completed", true);
  return async () => {
    await api.setStatus(id, isOpen(before.status) ? before.status : "not_started", false);
    for (const s of reopen) await api.setStatus(s.id, s.status, false);
  };
}

/** Move a task to another day, keeping its time; undo restores the exact old date and time. */
export async function rescheduleTask(id: string, date: string | null): Promise<() => Promise<unknown>> {
  const before = await api.task(id);
  await api.reschedule(id, date, date ? before.dueTime : null);
  return () => api.reschedule(id, before.dueDate, before.dueTime);
}

/** True inside a pop-out task window (Tauri window label "task-<id>"). False in a plain browser. */
export function isPopoutWindow(): boolean {
  try {
    return getCurrentWindow().label.startsWith("task-");
  } catch {
    return false;
  }
}
