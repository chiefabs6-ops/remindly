import type { DragEvent } from "react";
import { Bell, Bot, CalendarClock, Copy, Ellipsis, Flag, Globe, GripVertical, Maximize2, Repeat, StickyNote, Trash2 } from "lucide-react";
import { dayDiff, isoDate, PRIORITY_LABEL, relativeDayLabel, type Priority, type Project, type Task } from "@tether/core";
import { api } from "../lib/api";
import { dueLabel, dueTone, todayIso } from "../lib/format";
import { useAction } from "../lib/queries";
import { toneStyle } from "../lib/colors";
import { Check, ClaudeMark, PriorityBars, SubtaskRing } from "./ui/Bits";
import { Popover, usePopover } from "./ui/Popover";
import { ReschedulePopover } from "./ui/Reschedule";

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
  /** Wide table layout at lg and up: project, due, priority columns. Below lg it looks the same as before. */
  columns?: boolean;
}

/** One task: checkbox, title, then meta in fixed right-hand slots so rows line up as columns. */
export function TaskRow({ task, project, selected, onOpen, hideProject, compact, columns }: Props) {
  const toggle = useAction((done: boolean) =>
    api.setStatus(task.id, done ? "completed" : "not_started", done),
  );
  const done = task.status === "completed";
  const tone = dueTone(task);
  const due = dueLabel(task);

  return (
    <div
      role="listitem"
      className={`group flex min-h-11 items-center gap-3 border-t border-rule px-2 first:border-t-0 ${
        selected ? "bg-raised" : "hover:bg-raised"
      }`}
    >
      <input
        type="checkbox"
        aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
        checked={done}
        disabled={toggle.isPending}
        onChange={(e) => toggle.mutate(e.target.checked)}
        className="size-4 flex-none cursor-pointer rounded-[4px] accent-[var(--today)]"
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
        <span className={`hidden flex-none justify-end md:flex ${columns ? "w-44 lg:order-1 lg:w-52 lg:justify-start" : "w-44"}`}>
          {project && <span className="chip" style={toneStyle(project.color)} title={project.name}>{project.name}</span>}
        </span>
      )}
      <span className={`w-14 flex-none text-right text-xs text-muted ${compact ? "hidden" : "max-sm:hidden"} ${columns ? "lg:hidden" : ""}`}>
        {task.priority > 0 ? PRIORITY_MARK[task.priority] : ""}
      </span>
      {columns && !compact && (
        <span className="hidden w-20 flex-none lg:order-3 lg:flex">
          {task.priority > 0 && <span className="pill">{PRIORITY_MARK[task.priority]}</span>}
        </span>
      )}
      <span
        className={`num flex-none text-right text-xs ${compact ? "w-auto" : "w-28"} ${columns ? "lg:order-2 lg:text-left" : ""} ${
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
  columns,
  empty,
}: {
  tasks: Task[];
  projects: Project[];
  selectedId?: string | null;
  onOpen?: (id: string) => void;
  hideProject?: boolean;
  compact?: boolean;
  columns?: boolean;
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
          columns={columns}
        />
      ))}
    </div>
  );
}

/* ===================== My Tasks row (mockup E) ===================== */

/** Due cell text and tone: "Today 15:30", "Yesterday · 1d", "Sun 22 Nov · 2d". */
export function rowDue(t: Task, today = todayIso()): { text: string; cls: "od" | "td" | "none" | ""; late?: number } {
  if (t.status === "completed") {
    return { text: t.completedAt ? `Done ${relativeDayLabel(isoDate(new Date(t.completedAt)), today)}` : "Done", cls: "" };
  }
  if (!t.dueDate) return { text: "No date", cls: "none" };
  const diff = dayDiff(today, t.dueDate);
  const time = t.dueTime ? ` ${t.dueTime}` : "";
  const text = relativeDayLabel(t.dueDate, today) + time;
  if (diff < 0) return { text, cls: "od", late: -diff };
  if (diff === 0) return { text, cls: dueTone(t, today) === "overdue" ? "od" : "td" };
  return { text, cls: "" };
}

/** dataTransfer type that carries a task id, so the sidebar and calendar can tell task drags from other drags. */
export const TASK_DND = "application/x-tether-task";

export interface ListRowProps {
  task: Task;
  project?: Project;
  /** Open in the side panel (this is the selected row). */
  selected?: boolean;
  /** Keyboard cursor is on this row. */
  cursor?: boolean;
  /** Hide the project chip (the list is grouped by, or scoped to, one project). */
  hideProject?: boolean;
  /** Drag handle is live (date grouping, not on the Completed tab). */
  draggable?: boolean;
  dropTarget?: boolean;
  dragging?: boolean;
  onOpen: (id: string) => void;
  onToggle: (t: Task) => void;
  onReschedule: (t: Task, date: string | null) => void;
  onPriority: (t: Task, p: Priority) => void;
  onFullPage: (id: string) => void;
  onDuplicate: (t: Task) => void;
  onDelete: (t: Task) => void;
  onDragStart?: (e: DragEvent, id: string) => void;
  onDragOver?: (e: DragEvent, id: string) => void;
  onDrop?: (e: DragEvent, id: string) => void;
  onDragEnd?: () => void;
}

/** Bell (with the time of a one-off reminder) or the repeat sign; nothing when the task uses the default. */
function ReminderMark({ t }: { t: Task }) {
  const late = !!t.dueDate && t.dueDate < todayIso();
  if (t.reminderRepeat) {
    return (
      <span className={`trow-mk ${late ? "rem-late" : ""}`} title="Reminds every working morning until done">
        <Repeat size={12} strokeWidth={1.6} aria-label="Reminds every working morning until done" />
      </span>
    );
  }
  if (t.nextReminder) {
    const at = new Date(t.nextReminder);
    const hm = at.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
    return (
      <span className="trow-mk" title={`Reminder ${at.toLocaleString("en-IE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}>
        <Bell size={12} strokeWidth={1.6} aria-hidden /><span className="num">{hm}</span><span className="sr-only"> reminder</span>
      </span>
    );
  }
  if (t.reminderLead !== null) {
    const what = t.reminderLead === -1 ? "the morning it’s due" : t.reminderLead === 0 ? "at the due time" : `${t.reminderLead} min before`;
    return <span className="trow-mk" title={`Reminder ${what}`}><Bell size={12} strokeWidth={1.6} aria-label={`Reminder ${what}`} /></span>;
  }
  return null;
}

/** One row of the My Tasks list: grip, check, title, marks, project, due, priority; actions on hover. */
export function ListRow(p: ListRowProps) {
  const { task: t, project } = p;
  const resched = usePopover();
  const prio = usePopover();
  const more = usePopover();
  const done = t.status === "completed";
  const due = rowDue(t);
  const hovOpen = !!(resched.anchor || prio.anchor || more.anchor);
  const icon = { size: 15, strokeWidth: 1.6 };

  return (
    <div
      role="listitem"
      data-id={t.id}
      data-kb={p.cursor ? "true" : undefined}
      aria-current={p.selected ? "true" : undefined}
      className={`trow ${done ? "done" : ""} ${p.selected ? "sel" : ""} ${p.cursor ? "kb" : ""} ${p.draggable ? "" : "nodrag"} ${p.hideProject ? "np" : ""} ${hovOpen ? "hov-open" : ""} ${p.dragging ? "dragging" : ""} ${p.dropTarget ? "over" : ""}`}
      draggable
      onClick={(e) => {
        // Portalled popovers bubble through React; only clicks on the row itself open it.
        if (e.currentTarget.contains(e.target as Node) && !(e.target as HTMLElement).closest("button,a")) p.onOpen(t.id);
      }}
      onDragStart={(e) => {
        // Every row can be dragged to a project; only rows with a live grip also reorder inside the list.
        if (p.draggable) p.onDragStart?.(e, t.id);
        e.dataTransfer?.setData(TASK_DND, t.id);
      }}
      onDragOver={(e) => p.onDragOver?.(e, t.id)}
      onDrop={(e) => p.onDrop?.(e, t.id)}
      onDragEnd={p.onDragEnd}
    >
      <span className="trow-grip" aria-hidden="true"><GripVertical size={12} strokeWidth={1.6} /></span>
      <Check done={done} high={t.priority === 3} label={`${done ? "Reopen" : "Complete"} "${t.title}"`} onToggle={() => p.onToggle(t)} />
      <button type="button" className="trow-tt" onClick={() => p.onOpen(t.id)}>
        <span className="trow-name">{t.title}</span>
      </button>
      <div className="trow-meta">
        <span className="trow-marks">
          {t.subtaskCount > 0 && <span className="trow-mk"><SubtaskRing done={t.subtaskDone} total={t.subtaskCount} /></span>}
          {!done && <ReminderMark t={t} />}
          {t.source === "claude" && <span className="trow-mk"><ClaudeMark label="Suggested by Claude, approved by you" /></span>}
          {t.source === "chrome" && <span className="trow-mk" title="Captured in Chrome"><Globe size={12} strokeWidth={1.6} aria-label="Captured in Chrome" /></span>}
        </span>
        <span className="trow-pcell">
          {!p.hideProject && project && <span className="chip" style={toneStyle(project.color)} title={project.name}>{project.name}</span>}
        </span>
        <span className={`trow-due num ${due.cls}`}>
          {due.text}
          {due.late ? <span className="late"> · {due.late}d</span> : null}
        </span>
      </div>
      <span className="trow-pri"><PriorityBars priority={t.priority} /></span>
      {!done && (
        <span className="trow-hov">
          <button type="button" aria-label="Reschedule" title="Reschedule" onClick={(e) => resched.open(e.currentTarget)}><CalendarClock {...icon} /></button>
          <button type="button" aria-label="Set priority" title="Priority (0-3)" onClick={(e) => prio.open(e.currentTarget)}><Flag {...icon} /></button>
          <button type="button" aria-label="More actions" title="More" onClick={(e) => more.open(e.currentTarget)}><Ellipsis {...icon} /></button>
        </span>
      )}
      {resched.anchor && (
        <ReschedulePopover anchor={resched.anchor} value={t.dueDate} onClose={resched.close} onPick={(d) => p.onReschedule(t, d)} />
      )}
      {prio.anchor && (
        <Popover anchor={prio.anchor} onClose={prio.close} label="Priority" role="menu">
          {([3, 2, 1, 0] as Priority[]).map((n) => (
            <button key={n} type="button" role="menuitemradio" aria-checked={t.priority === n} className="pop-item"
              onClick={() => { prio.close(); p.onPriority(t, n); }}>
              <span className={`pri pri-${n}`} aria-hidden="true"><i /><i /><i /></span>
              {PRIORITY_LABEL[n]}<small>{n}</small>
            </button>
          ))}
        </Popover>
      )}
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} label="More actions" role="menu">
          <button type="button" role="menuitem" className="pop-item" onClick={() => { more.close(); p.onFullPage(t.id); }}>
            <Maximize2 {...icon} />Open full page<small>O</small>
          </button>
          <button type="button" role="menuitem" className="pop-item" onClick={() => { more.close(); p.onDuplicate(t); }}>
            <Copy {...icon} />Duplicate
          </button>
          <hr className="pop-sep" />
          <button type="button" role="menuitem" className="pop-item danger" onClick={() => { more.close(); p.onDelete(t); }}>
            <Trash2 {...icon} />Delete
          </button>
        </Popover>
      )}
    </div>
  );
}
