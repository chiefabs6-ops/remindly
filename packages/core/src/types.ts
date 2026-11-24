// Mirrors the Rust types in apps/desktop/src-tauri/src/model.rs (JSON is camelCase).

export type TaskStatus =
  | "inbox"
  | "not_started"
  | "in_progress"
  | "waiting"
  | "completed"
  | "archived";

export const TASK_STATUSES: TaskStatus[] = [
  "inbox",
  "not_started",
  "in_progress",
  "waiting",
  "completed",
  "archived",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "Inbox",
  not_started: "Not started",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
  archived: "Archived",
};

/** 0 none, 1 low, 2 medium, 3 high. */
export type Priority = 0 | 1 | 2 | 3;
export const PRIORITY_LABEL: Record<Priority, string> = {
  0: "None",
  1: "Low",
  2: "Medium",
  3: "High",
};

export type Source = "manual" | "chrome" | "claude" | "note" | "ai";
export type NoteKind = "general" | "meeting" | "idea" | "research" | "work";
export type SuggestionKind = "task" | "task_update" | "note";
export type Origin = "chrome" | "claude" | "ai" | "note";
export type SuggestionStatus = "pending" | "approved" | "dismissed";
export type Actor = "user" | "claude" | "chrome" | "system" | "ai";

export interface Task {
  id: string;
  parentId: string | null;
  projectId: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  dueDate: string | null;
  dueTime: string | null;
  scheduledDate: string | null;
  source: Source;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceSelection: string | null;
  codeProjectId: string | null;
  noteId: string | null;
  sortOrder: number;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  tags: string[];
  subtaskCount: number;
  subtaskDone: number;
  /** null = the app default; minutes before the due time; -1 = the morning of the due day. */
  reminderLead: number | null;
  /** Once overdue, remind every working morning until done. */
  reminderRepeat: boolean;
  /** Context from an approved Claude suggestion: said, completed, remaining, why, resumeHint, … */
  claudeContext: Record<string, unknown> | null;
  /** Next one-off reminder ("remind me at…" / snooze) not yet shown, RFC 3339 UTC. */
  nextReminder: string | null;
}

export interface HistoryEntry {
  id: number;
  at: string;
  actor: Actor;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface TaskDetail extends Task {
  subtasks: Task[];
  history: HistoryEntry[];
  links: TaskLink[];
}

/** A web link attached to a task (http/https only; the backend refuses anything else). */
export interface TaskLink {
  id: string;
  taskId: string;
  url: string;
  title: string | null;
  createdAt: string;
}

/** Editable fields; used for create and full update (absent = cleared). */
export interface TaskInput {
  title: string;
  description?: string | null;
  notes?: string | null;
  status?: TaskStatus | null;
  priority?: Priority;
  dueDate?: string | null;
  dueTime?: string | null;
  scheduledDate?: string | null;
  projectId?: string | null;
  tags?: string[];
}

export interface TaskFilter {
  statuses?: TaskStatus[];
  projectId?: string | null;
  noProject?: boolean;
  tag?: string | null;
  parentId?: string | null;
  topLevelOnly?: boolean;
  dueFrom?: string | null;
  dueTo?: string | null;
  query?: string | null;
  source?: Source | null;
  includeDeleted?: boolean;
  limit?: number;
}

export interface Project {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  openTasks: number;
  /** Top-level tasks completed in the last 30 days. */
  doneRecent: number;
}

export interface ProjectInput {
  name: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  usage: number;
}

export interface Note {
  id: string;
  projectId: string | null;
  taskId: string | null;
  title: string;
  bodyMd: string;
  kind: NoteKind;
  source: Source;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  tags: string[];
}

export interface NoteInput {
  title: string;
  bodyMd: string;
  kind?: NoteKind | null;
  projectId?: string | null;
  taskId?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
}

export interface NoteFilter {
  projectId?: string | null;
  taskId?: string | null;
  kind?: NoteKind | null;
  query?: string | null;
  limit?: number;
}

/** Payload of a `task` suggestion. */
export interface SuggestedTask {
  title: string;
  description?: string | null;
  notes?: string | null;
  priority?: Priority | null;
  dueDate?: string | null;
  dueTime?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceSelection?: string | null;
}

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  origin: Origin;
  targetTaskId: string | null;
  payload: SuggestedTask | NoteInput | Record<string, unknown>;
  context: Record<string, unknown> | null;
  confidence: Record<string, number> | null;
  dedupeKey: string | null;
  possibleDuplicateOf: string | null;
  status: SuggestionStatus;
  resultingId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type MeetingSummaryStatus = "pending" | "running" | "done" | "failed" | "off";

export interface Meeting {
  id: string;
  noteId: string | null;
  meetCode: string;
  title: string | null;
  startedAt: string;
  endedAt: string;
  summaryStatus: MeetingSummaryStatus;
  summaryError: string | null;
  segmentCount: number;
  suggestionCount: number;
}

export interface Dashboard {
  today: string;
  overdue: Task[];
  dueToday: Task[];
  carriedOver: Task[];
  dueSoon: Task[];
  upcoming: Task[];
  recent: Task[];
  inboxCount: number;
  completedToday: Task[];
  progress: { done: number; total: number };
  pending: { origin: Origin; count: number }[];
  suggestions: Suggestion[];
}

export interface SearchResults {
  tasks: Task[];
  notes: Note[];
}

export interface ApiInfo {
  url: string;
  tokenHint: string;
  dataDir: string;
}

/** Error shape returned by commands and the HTTP API. */
export interface AppError {
  code: "not_found" | "invalid" | "conflict" | "database" | "json" | "io";
  message: string;
}
