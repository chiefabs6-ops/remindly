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
export async function completeTask(id: string): Promise<(() => Promise<void>) & { nextDue: string | null }> {
  const before = await api.task(id);
  // The backend cascade closes every open descendant, so remember them at every level.
  const reopen: { id: string; status: TaskStatus }[] = [];
  const collect = async (subs: { id: string; status: TaskStatus; subtaskCount: number }[]) => {
    for (const s of subs) {
      if (isOpen(s.status)) reopen.push({ id: s.id, status: s.status });
      if (s.subtaskCount > 0) await collect((await api.task(s.id)).subtasks);
    }
  };
  await collect(before.subtasks);
  const done = await api.setStatus(id, "completed", true);
  // A repeating task leaves its next copy behind; the toast names its due date.
  const nextDue = done.repeatNextId ? (await api.task(done.repeatNextId)).dueDate : null;
  const undo = async () => {
    await api.setStatus(id, isOpen(before.status) ? before.status : "not_started", false);
    for (const s of reopen) await api.setStatus(s.id, s.status, false);
  };
  return Object.assign(undo, { nextDue });
}

/** "Tue 2 Dec" */
export function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const part = (o: Intl.DateTimeFormatOptions) => dt.toLocaleDateString("en-IE", o);
  return `${part({ weekday: "short" })} ${d} ${part({ month: "short" })}`;
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
