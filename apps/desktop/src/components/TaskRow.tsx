import { Bot, Globe, StickyNote } from "lucide-react";
import type { Project, Task } from "@tether/core";
import { api } from "../lib/api";
import { dueLabel, dueTone } from "../lib/format";
import { useAction } from "../lib/queries";

const PRIORITY_MARK: Record<number, string> = { 3: "High", 2: "Medium", 1: "Low" };

export function SourceIcon({ source }: { source: Task["source"] }) {
  const common = { size: 14, strokeWidth: 1.75, className: "text-faint flex-none" };
  if (source === "chrome") return <Globe {...common} aria-label="Captured in Chrome" />;
  if (source === "claude") return <Bot {...common} aria-label="Suggested by Claude Code" />;
  if (source === "note") return <StickyNote {...common} aria-label="Made from a note" />;
  return null;
}

interface Props {
  task: Task;
  project?: Project;
  selected?: boolean;
  onOpen?: (id: string) => void;
  /** Hide the project name when the list is already scoped to one project. */
  hideProject?: boolean;
  /** Narrow cards: title and due only. */
  compact?: boolean;
}

/** One task: checkbox, title, then meta in fixed right-hand slots so rows line up as columns. */
export function TaskRow({ task, project, selected, onOpen, hideProject, compact }: Props) {
  const toggle = useAction((done: boolean) =>
    api.setStatus(task.id, done ? "completed" : "not_started", done),
  );
  const done = task.status === "completed";
  const tone = dueTone(task);
  const due = dueLabel(task);

  return (
    <div
      role="listitem"
      className={`group flex min-h-11 items-center gap-3 rounded-[6px] px-2 ${
        selected ? "bg-active" : "hover:bg-raised"
      }`}
    >
      <input
        type="checkbox"
        aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
        checked={done}
        disabled={toggle.isPending}
        onChange={(e) => toggle.mutate(e.target.checked)}
        className="size-4 flex-none cursor-pointer accent-[var(--primary)]"
      />
      <button
        type="button"
        onClick={() => onOpen?.(task.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left"
      >
        <span className={`truncate ${done ? "text-muted line-through" : ""}`}>{task.title}</span>
        <SourceIcon source={task.source} />
        {task.subtaskCount > 0 && (
          <span className="num flex-none text-xs text-muted">
            {task.subtaskDone}/{task.subtaskCount}
          </span>
        )}
        {task.status === "waiting" && <span className="pill">Waiting</span>}
        {task.status === "in_progress" && <span className="pill">In progress</span>}
      </button>
      {!hideProject && !compact && (
        <span className="hidden w-40 flex-none truncate text-right text-xs text-muted md:block">
          {project?.name ?? ""}
        </span>
      )}
      <span className={`w-14 flex-none text-right text-xs text-muted ${compact ? "hidden" : "max-sm:hidden"}`}>
        {task.priority > 0 ? PRIORITY_MARK[task.priority] : ""}
      </span>
      <span
        className={`num flex-none text-right text-xs ${compact ? "w-auto" : "w-28"} ${
          tone === "overdue" ? "font-medium text-negative" : tone === "today" ? "font-medium text-today" : "text-muted"
        }`}
      >
        {due ?? "—"}
      </span>
    </div>
  );
}

export function TaskList({
  tasks,
  projects,
  selectedId,
  onOpen,
  hideProject,
  compact,
  empty,
}: {
  tasks: Task[];
  projects: Project[];
  selectedId?: string | null;
  onOpen?: (id: string) => void;
  hideProject?: boolean;
  compact?: boolean;
  empty: string;
}) {
  if (tasks.length === 0) {
    return <p className="rounded-[8px] border border-dashed border-line px-3 py-2.5 text-muted">{empty}</p>;
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  return (
    <div role="list">
      {tasks.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          project={t.projectId ? byId.get(t.projectId) : undefined}
          selected={selectedId === t.id}
          onOpen={onOpen}
          hideProject={hideProject}
          compact={compact}
        />
      ))}
    </div>
  );
}
