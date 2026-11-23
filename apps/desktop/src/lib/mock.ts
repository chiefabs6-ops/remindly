// In-memory backend used when the UI runs in a plain browser (vite dev, screenshots) or tests.
// It mirrors the Rust commands closely enough to exercise every screen. Not shipped logic:
// the real rules live in src-tauri/src/repo/*.rs.

import {
  addDays,
  isoDate,
  isoTime,
  type Dashboard,
  type Note,
  type NoteFilter,
  type NoteInput,
  type Project,
  type ProjectInput,
  type Suggestion,
  type SuggestedTask,
  type Task,
  type TaskFilter,
  type TaskInput,
  type TaskStatus,
} from "@tether/core";

let seq = 0;
const id = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
const now = () => new Date().toISOString();
const err = (code: string, message: string) => Promise.reject({ code, message });

interface Store {
  tasks: Task[];
  projects: Project[];
  notes: Note[];
  suggestions: Suggestion[];
  settings: Record<string, unknown>;
}

function task(p: Partial<Task> & { title: string }): Task {
  const t = now();
  return {
    id: id(),
    parentId: null,
    projectId: null,
    description: null,
    notes: null,
    status: "not_started",
    priority: 0,
    dueDate: null,
    dueTime: null,
    scheduledDate: null,
    source: "manual",
    sourceUrl: null,
    sourceTitle: null,
    sourceSelection: null,
    codeProjectId: null,
    noteId: null,
    sortOrder: 0,
    completedAt: null,
    archivedAt: null,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    tags: [],
    subtaskCount: 0,
    subtaskDone: 0,
    ...p,
  };
}

function project(name: string, color: string, sortOrder: number): Project {
  const t = now();
  return {
    id: id(),
    name,
    color,
    icon: null,
    description: null,
    sortOrder,
    archivedAt: null,
    createdAt: t,
    updatedAt: t,
    openTasks: 0,
  };
}

/** Sample data relative to today so every dashboard bucket has something in it. */
export function sampleStore(): Store {
  const today = isoDate(new Date());
  const d = (n: number) => addDays(today, n);
  const edu = project("Educator platform", "#1d5fbf", 1);
  const admin = project("Administration", "#2e7d32", 2);
  const personal = project("Personal", "#8a8a8a", 3);
  const profile = task({
    title: "Finish educator profile page",
    projectId: edu.id,
    priority: 3,
    dueDate: d(1),
    status: "in_progress",
    source: "claude",
    description: "Profile form saves; validation and Irish translations still open.",
  });
  const tasks: Task[] = [
    task({ title: "Send updated teacher list to programme lead", projectId: admin.id, dueDate: d(-2), priority: 2 }),
    task({ title: "Approve October expense claims", projectId: admin.id, dueDate: d(0), dueTime: "09:00", priority: 2 }),
    task({ title: "Review course import from LearnWorlds", projectId: edu.id, dueDate: d(0), dueTime: "15:30" }),
    task({ title: "Book car service", projectId: personal.id, scheduledDate: d(0) }),
    task({ title: "Draft newsletter intro", projectId: admin.id, scheduledDate: d(-1), tags: ["writing"] }),
    profile,
    task({ title: "Fix validation errors on profile form", projectId: edu.id, parentId: profile.id, status: "completed", completedAt: now() }),
    task({ title: "Test Irish translations", projectId: edu.id, parentId: profile.id }),
    task({ title: "Renew domain for portfolio site", projectId: personal.id, dueDate: d(3), priority: 1 }),
    task({ title: "Prepare Q1 training calendar", projectId: admin.id, dueDate: d(6) }),
    task({ title: "Quarterly VAT return", projectId: admin.id, dueDate: d(12), priority: 3 }),
    task({ title: "Call about gym membership", status: "inbox" }),
    task({ title: "Order replacement laptop charger", projectId: personal.id, status: "completed", completedAt: now(), dueDate: d(0) }),
    task({ title: "Reply to venue about workshop dates", projectId: admin.id, status: "waiting", dueDate: d(2) }),
  ];
  const suggestions: Suggestion[] = [
    {
      id: id(),
      kind: "task",
      origin: "chrome",
      targetTaskId: null,
      payload: {
        title: "Follow up about the updated teacher list",
        description: "Request the updated teacher list before Friday.",
        dueDate: d(4),
        sourceUrl: "https://mail.google.com/mail/u/0/#inbox/thread-42",
        sourceTitle: "Re: Teacher list — Inbox",
        sourceSelection: "Follow up about the updated teacher list before Friday.",
      } satisfies SuggestedTask,
      context: null,
      confidence: { dueDate: 0.6 },
      dedupeKey: null,
      possibleDuplicateOf: tasks[0].id,
      status: "pending",
      resultingId: null,
      createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      decidedAt: null,
    },
    {
      id: id(),
      kind: "task",
      origin: "claude",
      targetTaskId: null,
      payload: {
        title: "Wire the profile save to the new API",
        description: "Switch the profile form to POST /educators/:id and handle 422s.",
        dueDate: d(1),
        priority: 2,
        projectName: "Educator platform",
      } satisfies SuggestedTask,
      context: {
        completed: ["Form layout", "Field components"],
        remaining: ["Call the new endpoint", "Map 422 errors to fields", "Test with Irish locale"],
        why: "Old endpoint is removed on the 1st.",
        resumeHint: "src/features/profile/ProfileForm.tsx",
      },
      confidence: null,
      dedupeKey: null,
      possibleDuplicateOf: null,
      status: "pending",
      resultingId: null,
      createdAt: new Date(Date.now() - 50 * 60_000).toISOString(),
      decidedAt: null,
    },
  ];
  const notes: Note[] = [
    {
      id: id(),
      projectId: admin.id,
      taskId: null,
      title: "Monday team meeting",
      bodyMd: "Agreed the spring intake dates.\n\n- Confirm room bookings\n- Share the timetable draft\n- [x] Circulate minutes",
      kind: "meeting",
      source: "manual",
      sourceUrl: null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      tags: [],
    },
    {
      id: id(),
      projectId: null,
      taskId: null,
      title: "Ideas for the onboarding email",
      bodyMd: "Lead with the first lesson, not the account setup. Keep it under 120 words.",
      kind: "idea",
      source: "manual",
      sourceUrl: null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      tags: ["writing"],
    },
  ];
  return { tasks, projects: [edu, admin, personal], notes, suggestions, settings: { onboarded: true } };
}

let store: Store = sampleStore();
export function resetMock(s?: Partial<Store>) {
  store = { ...sampleStore(), ...s };
}

const live = (t: Task) => !t.deletedAt;
const open = (t: Task) => live(t) && !t.parentId && t.status !== "completed" && t.status !== "archived";

function withCounts(t: Task): Task {
  const subs = store.tasks.filter((s) => s.parentId === t.id && live(s));
  return { ...t, subtaskCount: subs.length, subtaskDone: subs.filter((s) => s.status === "completed").length };
}

function sortTasks(a: Task, b: Task) {
  const k = (t: Task) => [t.dueDate ? 0 : 1, t.dueDate ?? "", t.dueTime ? 0 : 1, t.dueTime ?? "", -t.priority] as const;
  const ka = k(a), kb = k(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

function listTasks(f: TaskFilter): Task[] {
  const q = f.query?.trim().toLowerCase();
  return store.tasks
    .filter((t) => f.includeDeleted || live(t))
    .filter((t) => !f.statuses?.length || f.statuses.includes(t.status))
    .filter((t) => (f.projectId ? t.projectId === f.projectId : f.noProject ? !t.projectId : true))
    .filter((t) => (f.parentId ? t.parentId === f.parentId : f.topLevelOnly ? !t.parentId : true))
    .filter((t) => !f.tag || t.tags.some((g) => g.toLowerCase() === f.tag!.toLowerCase()))
    .filter((t) => !f.dueFrom || (t.dueDate ?? "") >= f.dueFrom)
    .filter((t) => !f.dueTo || (!!t.dueDate && t.dueDate <= f.dueTo))
    .filter((t) => !f.source || t.source === f.source)
    .filter((t) => !q || [t.title, t.description, t.notes].some((s) => s?.toLowerCase().includes(q)))
    .map(withCounts)
    .sort(sortTasks)
    .slice(0, f.limit ?? 500);
}

function getTask(taskId: string): Task | undefined {
  return store.tasks.find((t) => t.id === taskId && live(t));
}

function applyInput(t: Task, input: TaskInput): Task | string {
  const title = input.title?.trim();
  if (!title) return "title is required";
  if (input.dueTime && !input.dueDate) return "a due time needs a due date";
  const status = (input.status ?? t.status) as TaskStatus;
  return {
    ...t,
    title,
    description: input.description?.trim() || null,
    notes: input.notes?.trim() || null,
    status,
    priority: input.priority ?? 0,
    dueDate: input.dueDate || null,
    dueTime: input.dueTime || null,
    scheduledDate: input.scheduledDate || null,
    projectId: input.projectId || null,
    tags: [...new Set((input.tags ?? []).map((g) => g.replace(/^#/, "").trim()).filter(Boolean))],
    completedAt: status === "completed" ? (t.status === "completed" ? t.completedAt : now()) : null,
    archivedAt: status === "archived" ? (t.status === "archived" ? t.archivedAt : now()) : null,
    updatedAt: now(),
  };
}

function dashboard(): Dashboard {
  const today = isoDate(new Date());
  const hm = isoTime(new Date());
  const tops = store.tasks.filter(open).map(withCounts).sort(sortTasks);
  const overdueT = (t: Task) => !!t.dueDate && (t.dueDate < today || (t.dueDate === today && !!t.dueTime && t.dueTime < hm));
  const overdue = tops.filter(overdueT);
  const notInbox = (t: Task) => t.status !== "inbox";
  const dueToday = tops.filter(
    (t) => !overdueT(t) && notInbox(t) && (t.dueDate === today || (t.scheduledDate === today && (!t.dueDate || t.dueDate >= today))),
  );
  const carriedOver = tops.filter(
    (t) => !overdueT(t) && notInbox(t) && !!t.scheduledDate && t.scheduledDate < today && (!t.dueDate || t.dueDate > today),
  );
  const plannedEarlier = (t: Task) => !!t.scheduledDate && t.scheduledDate <= today;
  const dueSoon = tops.filter((t) => !!t.dueDate && t.dueDate > today && t.dueDate <= addDays(today, 3) && !plannedEarlier(t));
  const upcoming = tops.filter((t) => !!t.dueDate && t.dueDate > addDays(today, 3) && t.dueDate <= addDays(today, 14) && !plannedEarlier(t));
  const completedToday = store.tasks
    .filter((t) => live(t) && t.status === "completed" && !!t.completedAt && isoDate(new Date(t.completedAt)) === today)
    .map(withCounts);
  const doneTop = completedToday.filter((t) => !t.parentId).length;
  const pendingS = store.suggestions.filter((s) => s.status === "pending");
  const origins = [...new Set(pendingS.map((s) => s.origin))].sort();
  return {
    today,
    overdue,
    dueToday,
    carriedOver,
    dueSoon,
    upcoming,
    recent: store.tasks.filter((t) => live(t) && !t.parentId).slice(-10).reverse().map(withCounts),
    inboxCount: store.tasks.filter((t) => live(t) && !t.parentId && t.status === "inbox").length,
    completedToday,
    progress: { done: doneTop, total: doneTop + overdue.length + dueToday.length + carriedOver.length },
    pending: origins.map((origin) => ({ origin, count: pendingS.filter((s) => s.origin === origin).length })),
    suggestions: pendingS.slice(0, 10),
  };
}

function projectsList(includeArchived: boolean): Project[] {
  return store.projects
    .filter((p) => includeArchived || !p.archivedAt)
    .map((p) => ({ ...p, openTasks: store.tasks.filter((t) => open(t) && t.projectId === p.id).length }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

type Args = Record<string, any>;
const handlers: Record<string, (a: Args) => unknown> = {
  dashboard_get: () => dashboard(),
  search_all: ({ query }) => ({
    tasks: listTasks({ query }),
    notes: store.notes.filter((n) => !n.deletedAt && (n.title + n.bodyMd).toLowerCase().includes(String(query).toLowerCase())),
  }),
  tasks_list: ({ filter }) => listTasks(filter ?? {}),
  task_get: ({ id: tid }) => {
    const t = getTask(tid);
    if (!t) return err("not_found", "task not found");
    return { ...withCounts(t), subtasks: listTasks({ parentId: tid }), history: [] };
  },
  task_create: ({ input, parentId }) => {
    const parent = parentId ? getTask(parentId) : null;
    const t = applyInput(task({ title: "x", parentId: parentId ?? null }), {
      ...input,
      projectId: input.projectId ?? parent?.projectId ?? null,
      status: input.status ?? "not_started",
    });
    if (typeof t === "string") return err("invalid", t);
    store.tasks.push(t);
    return withCounts(t);
  },
  task_update: ({ id: tid, input }) => {
    const i = store.tasks.findIndex((t) => t.id === tid && live(t));
    if (i < 0) return err("not_found", "task not found");
    const t = applyInput(store.tasks[i], input);
    if (typeof t === "string") return err("invalid", t);
    store.tasks[i] = t;
    return withCounts(t);
  },
  task_set_status: ({ id: tid, status, cascade }) => {
    const t = getTask(tid);
    if (!t) return err("not_found", "task not found");
    const set = (x: Task) => Object.assign(x, applyInput(x, { ...x, status }));
    set(t);
    if (cascade && (status === "completed" || status === "archived"))
      store.tasks.filter((s) => s.parentId === tid && live(s)).forEach(set);
    return withCounts(t);
  },
  task_reschedule: ({ id: tid, dueDate, dueTime }) => {
    const t = getTask(tid);
    if (!t) return err("not_found", "task not found");
    Object.assign(t, { dueDate, dueTime: dueDate ? dueTime : null, updatedAt: now() });
    return withCounts(t);
  },
  task_schedule: ({ id: tid, scheduledDate }) => {
    const t = getTask(tid);
    if (!t) return err("not_found", "task not found");
    Object.assign(t, { scheduledDate, updatedAt: now() });
    return withCounts(t);
  },
  task_duplicate: ({ id: tid }) => {
    const t = getTask(tid);
    if (!t) return err("not_found", "task not found");
    const copy = { ...t, id: id(), title: `${t.title} (copy)`, status: "not_started" as const, completedAt: null, createdAt: now() };
    store.tasks.push(copy);
    return withCounts(copy);
  },
  task_delete: ({ id: tid }) => {
    store.tasks.forEach((t) => (t.id === tid || t.parentId === tid) && !t.deletedAt && (t.deletedAt = now()));
  },
  task_restore: ({ id: tid }) => {
    store.tasks.forEach((t) => (t.id === tid || t.parentId === tid) && (t.deletedAt = null));
    return withCounts(store.tasks.find((t) => t.id === tid)!);
  },
  projects_list: ({ includeArchived }) => projectsList(!!includeArchived),
  project_create: ({ input }: Args) => {
    input = input as ProjectInput;
    const name = input.name.trim();
    if (!name) return err("invalid", "project name is required");
    if (store.projects.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return err("conflict", `a project named "${name}" already exists`);
    const p = { ...project(name, input.color ?? "#8a8a8a", store.projects.length + 1), description: input.description ?? null };
    store.projects.push(p);
    return p;
  },
  project_update: ({ id: pid, input }) => {
    const p = store.projects.find((x) => x.id === pid);
    if (!p) return err("not_found", "project not found");
    Object.assign(p, { name: input.name.trim(), color: input.color ?? null, description: input.description ?? null });
    return p;
  },
  project_set_archived: ({ id: pid, archived }) => {
    const p = store.projects.find((x) => x.id === pid)!;
    p.archivedAt = archived ? now() : null;
    return p;
  },
  project_delete: ({ id: pid }) => {
    store.projects = store.projects.filter((p) => p.id !== pid);
    store.tasks.forEach((t) => t.projectId === pid && (t.projectId = null));
  },
  tags_list: () => {
    const names = [...new Set(store.tasks.flatMap((t) => t.tags))];
    return names.map((name) => ({ id: name, name, color: null, usage: store.tasks.filter((t) => t.tags.includes(name)).length }));
  },
  notes_list: ({ filter }: Args) => {
    filter = filter as NoteFilter;
    const q = filter?.query?.toLowerCase();
    return store.notes
      .filter((n) => !n.deletedAt)
      .filter((n) => !filter?.projectId || n.projectId === filter.projectId)
      .filter((n) => !q || (n.title + " " + n.bodyMd).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  note_get: ({ id: nid }) => store.notes.find((n) => n.id === nid && !n.deletedAt) ?? err("not_found", "note not found"),
  note_create: ({ input }: Args) => {
    input = input as NoteInput;
    if (!input.title.trim() && !input.bodyMd.trim()) return err("invalid", "a note needs a title or some text");
    const n: Note = {
      id: id(),
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      title: input.title.trim(),
      bodyMd: input.bodyMd,
      kind: input.kind ?? "general",
      source: "manual",
      sourceUrl: input.sourceUrl ?? null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      tags: input.tags ?? [],
    };
    store.notes.push(n);
    return n;
  },
  note_update: ({ id: nid, input }) => {
    const n = store.notes.find((x) => x.id === nid);
    if (!n) return err("not_found", "note not found");
    Object.assign(n, { ...input, title: input.title.trim(), updatedAt: now() });
    return n;
  },
  note_delete: ({ id: nid }) => {
    const n = store.notes.find((x) => x.id === nid);
    if (n) n.deletedAt = now();
  },
  note_convert_to_tasks: ({ id: nid }) => {
    const n = store.notes.find((x) => x.id === nid)!;
    const lines = n.bodyMd
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^([-*+]|\d{1,3}\.)\s/.test(l) && !/^[-*+]\s\[[xX]\]/.test(l))
      .map((l) => l.replace(/^([-*+]|\d{1,3}\.)\s(\[ \]\s)?/, ""));
    const titles = lines.length ? lines : [n.title || n.bodyMd.split("\n")[0]];
    const created = titles.map((title) => task({ title, projectId: n.projectId, noteId: n.id, source: "note" }));
    store.tasks.push(...created);
    return created;
  },
  suggestions_list: ({ status }) => store.suggestions.filter((s) => !status || s.status === status),
  suggestion_approve: ({ id: sid, edited }) => {
    const s = store.suggestions.find((x) => x.id === sid);
    if (!s) return err("not_found", "suggestion not found");
    if (s.status !== "pending") return err("conflict", `suggestion is already ${s.status}`);
    const p = (edited ?? s.payload) as SuggestedTask;
    const projectId = p.projectId ?? store.projects.find((x) => x.name.toLowerCase() === p.projectName?.toLowerCase())?.id ?? null;
    const t = task({
      title: p.title,
      description: p.description ?? null,
      dueDate: p.dueDate ?? null,
      dueTime: p.dueTime ?? null,
      priority: (p.priority ?? 0) as Task["priority"],
      projectId,
      source: s.origin === "chrome" ? "chrome" : s.origin === "claude" ? "claude" : "ai",
      sourceUrl: p.sourceUrl ?? null,
      sourceTitle: p.sourceTitle ?? null,
      sourceSelection: p.sourceSelection ?? null,
    });
    store.tasks.push(t);
    Object.assign(s, { status: "approved", resultingId: t.id, decidedAt: now() });
    return { kind: s.kind, id: t.id };
  },
  suggestion_dismiss: ({ id: sid }) => {
    const s = store.suggestions.find((x) => x.id === sid)!;
    Object.assign(s, { status: "dismissed", decidedAt: now() });
    return s;
  },
  settings_get_all: () => store.settings,
  settings_set: ({ key, value }) => {
    store.settings[key] = value;
  },
  pairing_start: () => ({ code: String(Math.floor(100000 + Math.random() * 900000)), expiresInSecs: 120 }),
  paired_browsers: () => (store.settings.paired as string[] | undefined) ?? [],
  unpair_all: () => {
    store.settings.paired = [];
  },
  api_info: () => ({ url: "http://127.0.0.1:47821", tokenHint: "3f9a", dataDir: "%APPDATA%\\ie.tether.app" }),
};

export async function mockInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  const h = handlers[cmd];
  if (!h) return err("invalid", `mock: unknown command ${cmd}`);
  // Copy so callers cannot mutate the store through returned objects.
  const out = await h(args);
  return (out === undefined ? undefined : structuredClone(out)) as T;
}
