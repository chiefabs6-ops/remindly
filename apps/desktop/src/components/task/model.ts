// Shared helpers for the quick panel and the full task page.
import { STATUS_LABEL, type HistoryEntry, type TaskDetail, type TaskInput } from "@tether/core";
import { hostOf } from "../../lib/format";

export const WHO: Record<string, string> = { user: "You", claude: "Claude Code", chrome: "Chrome", system: "Tether", ai: "Local AI" };

const FIELD: Record<string, string> = {
  title: "title", description: "description", notes: "notes", status: "status", priority: "priority",
  due_date: "due date", due_time: "due time", scheduled_date: "do-on date", project_id: "project", tags: "tags",
};

/** One plain-English line per history entry. Comments return the text alone (the page shows who wrote it). */
export function historyLine(h: HistoryEntry): string {
  const who = WHO[h.actor] ?? h.actor;
  switch (h.action) {
    case "created": return `${who} created the task`;
    case "suggested": return `Approved from ${WHO[h.actor] ?? "a suggestion"}`;
    case "duplicated": return `${who} duplicated it from another task`;
    case "deleted": return `${who} deleted it`;
    case "restored": return `${who} restored it`;
    case "comment": return `${who}: ${h.newValue ?? ""}`;
    case "link_added": return `${who} added the link ${hostOf(h.newValue) ?? h.newValue ?? ""}`;
    case "link_removed": return `${who} removed the link ${hostOf(h.oldValue) ?? h.oldValue ?? ""}`;
    case "status": return `${who} set status to ${STATUS_LABEL[h.newValue as keyof typeof STATUS_LABEL] ?? h.newValue}`;
    default: {
      const f = FIELD[h.field ?? ""] ?? h.field ?? "a field";
      if (h.field === "notes" || h.field === "description") return `${who} edited the ${f}`;
      if (h.field === "project_id") return `${who} changed the project`;
      if (h.field === "status") return `${who} set status to ${STATUS_LABEL[h.newValue as keyof typeof STATUS_LABEL] ?? h.newValue}`;
      if (!h.newValue) return `${who} cleared the ${f}`;
      return `${who} set the ${f} to ${h.newValue}`;
    }
  }
}

/** Every field of the task, so a one-field change can be saved with updateTask. */
export function asInput(t: TaskDetail): TaskInput {
  return {
    title: t.title, description: t.description, notes: t.notes, status: t.status, priority: t.priority,
    dueDate: t.dueDate, dueTime: t.dueTime, scheduledDate: t.scheduledDate, projectId: t.projectId, tags: t.tags,
  };
}

export const same = (a: string | null, b: string | null) =>
  (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

/** Local date and time to an ISO instant, for the reminder API. */
export function localIso(date: string, hh: number, mm: number, minusMin = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm - minusMin).toISOString();
}

/** Open a web link outside the app. Only http(s) links are ever opened; inside Tauri the system
 *  browser opens it (never the app's own webview), in a plain browser a new tab does. */
export async function openExternal(url: string) {
  if (!/^https?:\/\/[^\s/]/i.test(url)) return;
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Claude context is stored as Markdown inside the task notes: "**Label**" + "- item" lines, or "**Label:** text". */
export interface CtxPart { label: string; text?: string; items?: string[] }
export function parseContext(md: string | null): CtxPart[] {
  const parts: CtxPart[] = [];
  let cur: CtxPart | null = null;
  for (const raw of (md ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const inline = /^\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    const head = /^\*\*(.+?)\*\*$/.exec(line);
    if (inline) { cur = null; parts.push({ label: inline[1], text: inline[2] }); }
    else if (head) { cur = { label: head[1], items: [] }; parts.push(cur); }
    else if (/^[-*] /.test(line) && cur?.items) cur.items.push(line.replace(/^[-*] /, ""));
    else { cur = null; parts.push({ label: "", text: line }); }
  }
  return parts;
}
