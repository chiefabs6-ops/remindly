// Typed wrappers over the Tauri commands in src-tauri/src/commands.rs.
// Outside Tauri (plain browser / tests) calls go to an in-memory mock so the UI can be previewed.

import type {
  ApiInfo,
  AppError,
  Dashboard,
  Meeting,
  Note,
  NoteFilter,
  NoteInput,
  Project,
  ProjectInput,
  SearchResults,
  Suggestion,
  SuggestionStatus,
  Tag,
  Task,
  TaskDetail,
  TaskLink,
  TaskFilter,
  TaskInput,
  TaskStatus,
} from "@tether/core";

export interface CodeProject {
  id: string;
  rootDir: string;
  name: string;
  gitRemote: string | null;
  projectId: string | null;
  lastSeenAt: string;
}

export interface ReminderSettings {
  enabled: boolean;
  dueSoonMinutes: number;
  overdueAfterMinutes: number;
  briefingEnabled: boolean;
  briefingTime: string;
  reviewEnabled: boolean;
  reviewTime: string;
  nudgeMinutes: number;
  workStart: string;
  workEnd: string;
  workDays: number[];
}

export interface BackupSettings {
  autoDaily: boolean;
  dir: string;
  keepDaily: number;
  keepWeekly: number;
  lastAuto: string | null;
  lastError?: string | null;
  /** Resolved folder (read-only). */
  folder?: string;
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  takenAt: string;
}

export interface AiSettings {
  enabled: boolean;
  url: string;
  model: string;
}

export interface AiStatus {
  enabled: boolean;
  reachable: boolean;
  version: string | null;
  models: string[];
  modelInstalled: boolean;
}

export interface AiResult<T> {
  value: T;
  tokensPerSecond: number;
}

export interface Extracted {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: number | null;
  projectName?: string | null;
}

export interface DayPlan {
  summary: string;
  items: { task: import("@tether/core").Task; reason: string }[];
}

type Args = Record<string, unknown>;
type Invoke = <T>(cmd: string, args?: Args) => Promise<T>;

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backend: Promise<Invoke> | null = null;
function getBackend(): Promise<Invoke> {
  if (!backend) {
    backend = inTauri
      ? import("@tauri-apps/api/core").then((m) => m.invoke as Invoke)
      : import("./mock").then((m) => m.mockInvoke as Invoke);
  }
  return backend;
}

/** For tests: replace the backend. */
export function setBackend(fn: Invoke) {
  backend = Promise.resolve(fn);
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

async function call<T>(cmd: string, args?: Args): Promise<T> {
  const invoke = await getBackend();
  return invoke<T>(cmd, args);
}

export const api = {
  dashboard: () => call<Dashboard>("dashboard_get"),
  search: (query: string) => call<SearchResults>("search_all", { query }),

  tasks: (filter: TaskFilter) => call<Task[]>("tasks_list", { filter }),
  task: (id: string) => call<TaskDetail>("task_get", { id }),
  createTask: (input: TaskInput, parentId?: string | null) =>
    call<Task>("task_create", { input, parentId: parentId ?? null }),
  updateTask: (id: string, input: TaskInput) => call<Task>("task_update", { id, input }),
  setStatus: (id: string, status: TaskStatus, cascade = false) =>
    call<Task>("task_set_status", { id, status, cascade }),
  reschedule: (id: string, dueDate: string | null, dueTime: string | null = null) =>
    call<Task>("task_reschedule", { id, dueDate, dueTime }),
  schedule: (id: string, scheduledDate: string | null) =>
    call<Task>("task_schedule", { id, scheduledDate }),
  duplicate: (id: string) => call<Task>("task_duplicate", { id }),
  deleteTask: (id: string) => call<void>("task_delete", { id }),
  restoreTask: (id: string) => call<Task>("task_restore", { id }),
  reorderTasks: (ids: string[]) => call<void>("task_reorder", { ids }),
  setReminder: (id: string, lead: number | null, repeat: boolean) => call<Task>("task_set_reminder", { id, lead, repeat }),
  mergeSuggestion: (id: string, taskId: string) => call<{ kind: string; id: string }>("suggestion_merge", { id, taskId }),
  addLink: (id: string, url: string, title?: string | null) =>
    call<TaskLink>("task_link_add", { id, url, title: title ?? null }),
  removeLink: (linkId: string) => call<void>("task_link_remove", { linkId }),
  addComment: (id: string, text: string) => call<void>("task_comment", { id, text }),
  openTaskWindow: (id: string) => call<void>("task_open_window", { id }),

  projects: (includeArchived = false) => call<Project[]>("projects_list", { includeArchived }),
  createProject: (input: ProjectInput) => call<Project>("project_create", { input }),
  updateProject: (id: string, input: ProjectInput) => call<Project>("project_update", { id, input }),
  archiveProject: (id: string, archived: boolean) =>
    call<Project>("project_set_archived", { id, archived }),
  deleteProject: (id: string) => call<void>("project_delete", { id }),

  tags: () => call<Tag[]>("tags_list"),

  notes: (filter: NoteFilter) => call<Note[]>("notes_list", { filter }),
  note: (id: string) => call<Note>("note_get", { id }),
  createNote: (input: NoteInput) => call<Note>("note_create", { input }),
  updateNote: (id: string, input: NoteInput) => call<Note>("note_update", { id, input }),
  deleteNote: (id: string) => call<void>("note_delete", { id }),
  convertNote: (id: string) => call<Task[]>("note_convert_to_tasks", { id }),
  meetingForNote: (noteId: string) => call<Meeting | null>("meeting_for_note", { noteId }),
  meetingResummarise: (id: string) => call<Meeting>("meeting_resummarise", { id }),

  suggestions: (status: SuggestionStatus | null) => call<Suggestion[]>("suggestions_list", { status }),
  approveSuggestion: (id: string, edited?: unknown) =>
    call<{ kind: string; id: string }>("suggestion_approve", { id, edited: edited ?? null }),
  dismissSuggestion: (id: string) => call<Suggestion>("suggestion_dismiss", { id }),

  settings: () => call<Record<string, unknown>>("settings_get_all"),
  setSetting: (key: string, value: unknown) => call<void>("settings_set", { key, value }),
  apiInfo: () => call<ApiInfo>("api_info"),
  startPairing: () => call<{ code: string; expiresInSecs: number }>("pairing_start"),
  pairedBrowsers: () => call<string[]>("paired_browsers"),
  unpairAll: () => call<void>("unpair_all"),
  reminders: () => call<ReminderSettings>("reminders_get"),
  setReminders: (value: ReminderSettings) => call<ReminderSettings>("reminders_set", { value }),
  testReminder: () => call<void>("reminder_test"),
  remindAt: (id: string, until: string) => call<void>("reminder_snooze", { id, until }),
  takePendingRoute: () => call<string | null>("take_pending_route"),
  autostart: () => call<boolean>("autostart_get"),
  setAutostart: (enabled: boolean) => call<boolean>("autostart_set", { enabled }),
  backupSettings: () => call<BackupSettings>("backup_settings_get"),
  setBackupSettings: (value: BackupSettings) => call<BackupSettings>("backup_settings_set", { value }),
  backups: () => call<BackupFile[]>("backups_list"),
  backupNow: () => call<BackupFile>("backup_now"),
  restoreBackup: (name: string) => call<BackupFile>("backup_restore", { name }),
  exportJson: () => call<string>("export_json"),
  dbHealth: () => call<string>("db_health"),
  reveal: (path: string) => call<void>("reveal_path", { path }),
  aiSettings: () => call<AiSettings>("ai_settings_get"),
  setAiSettings: (value: AiSettings) => call<AiSettings>("ai_settings_set", { value }),
  aiStatus: () => call<AiStatus>("ai_status"),
  aiExtract: (text: string, pageTitle: string | null) => call<AiResult<Extracted>>("ai_extract", { text, pageTitle }),
  aiBreakdown: (id: string) => call<AiResult<string[]>>("ai_breakdown", { id }),
  planDay: () => call<DayPlan>("plan_day"),
  codeProjects: () => call<CodeProject[]>("code_projects_list"),
  linkCodeProject: (id: string, projectId: string | null) =>
    call<CodeProject>("code_project_set_project", { id, projectId }),
};

/** Subscribe to backend data changes (API writes). Returns an unsubscribe function. */
/** Follow navigation requests from notification buttons ("Review now", "Open"). */
export async function onNavigate(cb: (path: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("navigate", (e) => cb(e.payload));
}

export async function onDataChanged(cb: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("data-changed", cb);
}
