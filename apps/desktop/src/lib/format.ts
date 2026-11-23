import { dayDiff, isoDate, isoTime, relativeDayLabel, type Task } from "@tether/core";

export const todayIso = () => isoDate(new Date());

export type DueTone = "overdue" | "today" | "plain";

export function dueTone(t: Pick<Task, "dueDate" | "dueTime" | "status">, today = todayIso()): DueTone {
  if (!t.dueDate || t.status === "completed" || t.status === "archived") return "plain";
  if (t.dueDate < today) return "overdue";
  if (t.dueDate === today) {
    if (t.dueTime && t.dueTime < isoTime(new Date())) return "overdue";
    return "today";
  }
  return "plain";
}

/** "Today 15:30", "Tomorrow", "Friday", "3 Dec", "2 days late". */
export function dueLabel(t: Pick<Task, "dueDate" | "dueTime">, today = todayIso()): string | null {
  if (!t.dueDate) return null;
  const diff = dayDiff(today, t.dueDate);
  if (diff < -1) return `${-diff} days late`;
  const day = relativeDayLabel(t.dueDate, today);
  return t.dueTime ? `${day} ${t.dueTime}` : day;
}

/** "9 min", "3 h", "Yesterday", "12 Nov" for an RFC 3339 timestamp. */
export function ago(ts: string, nowMs = Date.now()): string {
  const ms = nowMs - new Date(ts).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "Now";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  return relativeDayLabel(isoDate(new Date(ts)), todayIso());
}

export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}
