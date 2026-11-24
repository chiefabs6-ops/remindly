// When a task will remind, worked out with the same rules as the scheduler
// (src-tauri/src/reminders.rs `due_notices`). The reminder card and Overview's "Reminders today"
// both use this, so the app never shows a reminder that will not fire.
import type { Task } from "@tether/core";

export interface ReminderRules {
  enabled: boolean;
  dueSoonMinutes: number;
  overdueAfterMinutes: number;
  /** "HH:MM" */
  workStart: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  workDays: number[];
}

export const DEFAULT_RULES: ReminderRules = { enabled: true, dueSoonMinutes: 15, overdueAfterMinutes: 60, workStart: "09:00", workDays: [1, 2, 3, 4, 5] };

export type MomentKind = "early" | "due" | "followup" | "repeat" | "once" | "snooze";
export interface Moment { taskId: string; title: string; at: Date; kind: MomentKind }

type Plannable = Pick<Task, "id" | "title" | "dueDate" | "dueTime" | "reminderLead" | "reminderRepeat" | "nextReminder" | "snoozedUntil">;

const at = (date: string, hm: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0);
};
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

/** Every reminder moment of one open task in the window (from, to], as the scheduler would fire them. */
export function taskMoments(t: Plannable, rules: ReminderRules, from: Date, to: Date): Moment[] {
  if (!rules.enabled) return [];
  const out: Moment[] = [];
  const push = (when: Date, kind: MomentKind) => { if (when > from && when <= to) out.push({ taskId: t.id, title: t.title, at: when, kind }); };
  // A one-off "remind me at…" is extra; it never silences the others.
  if (t.nextReminder) push(new Date(t.nextReminder), "once");
  // A snooze from a notification pauses everything else until it fires, then they carry on.
  const snoozeAt = t.snoozedUntil ? new Date(t.snoozedUntil) : null;
  if (snoozeAt) push(snoozeAt, "snooze");
  const paused = (m: Moment) => !!snoozeAt && m.kind !== "once" && m.kind !== "snooze" && m.at <= snoozeAt;
  if (!t.dueDate) return out;
  const morning = at(t.dueDate, rules.workStart);
  if (t.dueTime) {
    const due = at(t.dueDate, t.dueTime);
    push(due, "due");
    const lead = t.reminderLead;
    const early =
      lead === -1 ? (morning < due ? morning : null)
      : lead === null ? (rules.dueSoonMinutes > 0 ? new Date(due.getTime() - rules.dueSoonMinutes * 60_000) : null)
      : lead > 0 ? new Date(due.getTime() - lead * 60_000)
      : null; // 0 = only at the due time
    if (early) push(early, "early");
    if (rules.overdueAfterMinutes > 0) push(new Date(due.getTime() + rules.overdueAfterMinutes * 60_000), "followup");
  } else if (t.reminderLead === -1) {
    push(morning, "early");
  }
  if (t.reminderRepeat) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (day <= to) {
      const d = isoDay(day);
      if (d > t.dueDate && rules.workDays.includes(isoWeekday(day))) push(at(d, rules.workStart), "repeat");
      day.setDate(day.getDate() + 1);
    }
  }
  return out.filter((m) => !paused(m));
}

/** Moments falling on one local day (YYYY-MM-DD), earliest first. */
export function dayMoments(tasks: Plannable[], rules: ReminderRules, day: string): Moment[] {
  const start = at(day, "00:00");
  const from = new Date(start.getTime() - 1);
  const to = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, -1);
  return tasks.flatMap((t) => taskMoments(t, rules, from, to)).sort((a, b) => a.at.getTime() - b.at.getTime() || a.title.localeCompare(b.title));
}

/** The next moment this task will remind after `now`, if any (looks 60 days ahead). */
export function nextMoment(t: Plannable, rules: ReminderRules, now = new Date()): Moment | null {
  const to = new Date(now.getTime() + 60 * 86_400_000);
  const all = taskMoments(t, rules, now, to).sort((a, b) => a.at.getTime() - b.at.getTime());
  return all[0] ?? null;
}
