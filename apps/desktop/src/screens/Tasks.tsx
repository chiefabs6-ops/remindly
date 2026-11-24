import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Check as CheckIcon, ChevronDown, Folder, Layers } from "lucide-react";
import {
  addDays, dayDiff, isoDate, PRIORITY_LABEL, relativeDayLabel,
  type Priority, type Task, type TaskFilter, type TaskInput,
} from "@tether/core";
import { QuickAdd } from "../components/QuickAdd";
import { QuickPanel } from "../components/QuickPanel";
import { SuggestionTray } from "../components/SuggestionTray";
import { ListRow } from "../components/TaskRow";
import { Tabs } from "../components/ui/Controls";
import { Popover, usePopover } from "../components/ui/Popover";
import { useToast } from "../components/ui/Toast";
import { api, errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { longDate, todayIso } from "../lib/format";
import { useDashboard, useInvalidateAll, useNotes, useProjects, useTasks } from "../lib/queries";

type View = "all" | "today" | "upcoming" | "overdue" | "done";
type GroupBy = "date" | "project" | "priority";

const VIEW_LABEL: Record<View, string> = { all: "All open", today: "Today", upcoming: "Upcoming", overdue: "Overdue", done: "Completed" };
const VIEW_ORDER: View[] = ["all", "today", "upcoming", "overdue", "done"];
const GROUP_LABEL: Record<GroupBy, string> = { date: "Date", project: "Project", priority: "Priority" };
const OPEN_STATUSES = ["inbox", "not_started", "in_progress", "waiting"];
const LINGER_MS = 1400;

const isOpen = (t: Task) => OPEN_STATUSES.includes(t.status);
const trunc = (s: string) => (s.length > 38 ? `${s.slice(0, 38)}…` : s);

/** Every field of the task, so one change can be saved with updateTask (which replaces the whole task). */
function toInput(t: Task, patch: Partial<TaskInput> = {}): TaskInput {
  return {
    title: t.title, description: t.description, notes: t.notes, status: t.status, priority: t.priority,
    dueDate: t.dueDate, dueTime: t.dueTime, scheduledDate: t.scheduledDate, projectId: t.projectId, tags: t.tags,
    ...patch,
  };
}

interface Group { key: string; label: string; items: Task[]; late?: boolean; sub?: string }

const EMPTY: Record<View, [string, string]> = {
  all: ["No open tasks", "Add one above, or approve a suggestion."],
  today: ["Today is clear", "Nothing due today. Pull something forward from Upcoming."],
  upcoming: ["Nothing coming up", "Tasks with a future date show here."],
  overdue: ["Nothing overdue", "Everything late has a new date."],
  done: ["Nothing completed yet", "Finished tasks stay here for 30 days."],
};

/** My Tasks: every open task, or one project's tasks when mounted at /projects/:projectId. */
export function TasksScreen() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateAll();

  const q = params.get("q") ?? "";
  const rawView = params.get("view") ?? "";
  const view: View = (VIEW_ORDER as string[]).includes(rawView) ? (rawView as View) : "all";
  const filterProject = projectId ?? params.get("project") ?? "";
  const selectedId = params.get("task");
  const [group, setGroup] = useState<GroupBy>("date");
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [linger, setLinger] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const groupMenu = usePopover();
  const projMenu = usePopover();

  const filter: TaskFilter = {
    statuses: [],
    topLevelOnly: true,
    query: q || null,
    projectId: filterProject && filterProject !== "none" ? filterProject : null,
    noProject: filterProject === "none",
  };
  const tasks = useTasks(filter);
  const projects = useProjects();
  const dash = useDashboard();
  const notes = useNotes({ projectId: projectId ?? null, query: q || null, limit: 5 });
  const ps = projects.data ?? [];
  const project = projectId ? ps.find((p) => p.id === projectId) : undefined;
  const today = todayIso();

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
      return next;
    }, { replace: true });
  }, [setParams]);

  // ---- derived lists ----
  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const projectById = useMemo(() => new Map(ps.map((p) => [p.id, p])), [ps]);

  const counts = useMemo(() => {
    const open = all.filter(isOpen);
    const dated = open.filter((t) => t.dueDate);
    return {
      all: open.length,
      today: dated.filter((t) => t.dueDate! <= today).length,
      upcoming: dated.filter((t) => t.dueDate! > today).length,
      overdue: dated.filter((t) => t.dueDate! < today).length,
      done: all.filter((t) => t.status === "completed").length,
      dueToday: dated.filter((t) => t.dueDate === today).length,
    };
  }, [all, today]);

  const visible = useMemo(() => {
    return all.filter((t) => {
      if (view === "done") return t.status === "completed";
      const live = isOpen(t) || (t.status === "completed" && linger.has(t.id));
      if (!live) return false;
      if (view === "all") return true;
      if (!t.dueDate) return false;
      if (view === "today") return t.dueDate <= today;
      if (view === "upcoming") return t.dueDate > today;
      return t.dueDate < today;
    });
  }, [all, view, linger, today]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    const [y, m, d] = today.split("-").map(Number);
    const toSunday = (7 - new Date(y, m - 1, d).getDay()) % 7;
    const add = (key: string, label: string, t: Task, extra: Partial<Group> = {}) => {
      if (!map.has(key)) map.set(key, { key, label, items: [], ...extra });
      map.get(key)!.items.push(t);
    };
    for (const t of visible) {
      if (group === "date") {
        if (t.status === "completed" && !linger.has(t.id)) {
          const diff = t.completedAt ? dayDiff(today, isoDate(new Date(t.completedAt))) : -9;
          if (diff === 0) add("d0", "Completed today", t);
          else if (diff === -1) add("d1", "Yesterday", t);
          else add("d2", "Earlier", t);
        } else if (!t.dueDate) add("z", "No date", t);
        else {
          const n = dayDiff(today, t.dueDate);
          if (n < 0) add("a", "Overdue", t, { late: true });
          else if (n === 0) add("b", "Today", t, { sub: longDate(today) });
          else if (n === 1) add("c", "Tomorrow", t);
          else if (n <= toSunday) add("d", "Rest of this week", t);
          else add("e", "Later", t);
        }
      } else if (group === "project") {
        const p = t.projectId ? projectById.get(t.projectId) : undefined;
        const idx = p ? ps.indexOf(p) : 999;
        add(`p${String(idx).padStart(3, "0")}`, p ? p.name : "No project", t);
      } else {
        add(String(3 - t.priority), t.priority ? `${PRIORITY_LABEL[t.priority as Priority]} priority` : "No priority", t);
      }
    }
    const arr = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    if (group !== "date") {
      for (const g of arr) g.items.sort((a, b) => (a.dueDate ?? "9") < (b.dueDate ?? "9") ? -1 : (a.dueDate ?? "9") > (b.dueDate ?? "9") ? 1 : 0);
    } else if (view === "done") {
      for (const g of arr) g.items.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    }
    return arr;
  }, [visible, group, view, linger, today, projectById, ps]);

  const flat = useMemo(() => groups.filter((g) => !shut[g.key]).flatMap((g) => g.items.map((t) => t.id)), [groups, shut]);

  // ---- actions ----
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      invalidate();
    }
  };

  const clearLinger = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setLinger((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const complete = (t: Task) => {
    if (t.status === "completed") {
      clearLinger(t.id);
      void run(() => api.setStatus(t.id, "not_started", false));
      toast(`Reopened “${trunc(t.title)}”`);
      return;
    }
    const prev = t.status;
    setLinger((s) => new Set(s).add(t.id));
    timers.current.set(t.id, setTimeout(() => clearLinger(t.id), LINGER_MS));
    void run(() => api.setStatus(t.id, "completed", true));
    toast(`Completed “${trunc(t.title)}”`, () => {
      clearLinger(t.id);
      return run(() => api.setStatus(t.id, prev, false));
    });
  };

  const reschedule = (t: Task, date: string | null) => {
    const old = { d: t.dueDate, t: t.dueTime };
    void run(() => api.reschedule(t.id, date, date ? t.dueTime : null));
    toast(date ? `Moved to ${relativeDayLabel(date, today)}` : "Date removed", () => run(() => api.reschedule(t.id, old.d, old.t)));
  };

  const setPriority = (t: Task, p: Priority) => void run(() => api.updateTask(t.id, toInput(t, { priority: p })));

  const duplicate = (t: Task) => {
    void run(() => api.duplicate(t.id));
    toast(`Duplicated “${trunc(t.title)}”`);
  };

  const remove = (t: Task) => {
    if (selectedId === t.id) update({ task: null });
    void run(() => api.deleteTask(t.id));
    toast(`Deleted “${trunc(t.title)}”`, () => run(() => api.restoreTask(t.id)));
  };

  const moveAllToday = (list: Task[]) => {
    const old = list.map((t) => ({ id: t.id, d: t.dueDate, tm: t.dueTime }));
    void run(() => Promise.all(list.map((t) => api.reschedule(t.id, today, t.dueTime))));
    toast(`Moved ${list.length} ${list.length === 1 ? "task" : "tasks"} to today`, () =>
      run(() => Promise.all(old.map((o) => api.reschedule(o.id, o.d, o.tm)))));
  };

  const openFull = (id: string) => navigate(`/task/${id}`);
  const openTask = (id: string) => {
    setCursor(id);
    if (window.innerWidth < 1024) openFull(id);
    else update({ task: id });
  };

  // ---- drag to reorder inside one date group ----
  const dragEnabled = group === "date" && view !== "done";
  const groupOf = (id: string) => groups.find((g) => g.items.some((t) => t.id === id));
  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDrag({ id, over: null });
  };
  const onDragOver = (e: DragEvent, id: string) => {
    if (!drag || groupOf(drag.id)?.key !== groupOf(id)?.key) return;
    e.preventDefault();
    if (drag.over !== id) setDrag({ ...drag, over: id });
  };
  const onDrop = (e: DragEvent, id: string) => {
    if (!drag) return;
    const g = groupOf(id);
    if (!g || groupOf(drag.id)?.key !== g.key) return;
    e.preventDefault();
    setDrag(null);
    if (drag.id === id) return;
    const ids = g.items.map((t) => t.id).filter((x) => x !== drag.id);
    ids.splice(ids.indexOf(id), 0, drag.id);
    void run(() => api.reorderTasks(ids));
  };

  // ---- keyboard ----
  const kb = useRef({ flat, cursor, selectedId, byId });
  kb.current = { flat, cursor, selectedId, byId };
  const act = useRef({ complete, reschedule, setPriority, openTask, openFull, update, setCursor });
  act.current = { complete, reschedule, setPriority, openTask, openFull, update, setCursor };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']")) return;
      const { flat: ids, cursor: cur, selectedId: sel, byId: map } = kb.current;
      const a = act.current;
      if (e.key === "Escape") {
        if (sel && !document.querySelector(".pop")) a.update({ task: null });
        return;
      }
      if (document.querySelector(".pop")) return; // a menu has the keys
      const k = e.key.toLowerCase();
      const i = cur ? ids.indexOf(cur) : -1;
      const go = (to: string | undefined) => {
        if (!to) return;
        a.setCursor(to);
        if (sel && window.innerWidth >= 1024) a.update({ task: to });
      };
      if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); go(ids[Math.min(ids.length - 1, i + 1)]); return; }
      if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); go(ids[Math.max(0, i - 1)]); return; }
      const id = cur ?? sel;
      const t = id ? map.get(id) : undefined;
      if (!t) return;
      const onControl = !!el?.closest("button,a");
      if (e.key === "Enter") { if (!onControl) { e.preventDefault(); a.openTask(t.id); } return; }
      if (k === "o") a.openFull(t.id);
      else if (k === "x") a.complete(t);
      else if (k === "t" && t.status !== "completed") a.reschedule(t, todayIso());
      else if (k === "m" && t.status !== "completed") a.reschedule(t, addDays(todayIso(), 1));
      else if (["0", "1", "2", "3"].includes(k) && t.status !== "completed") a.setPriority(t, Number(k) as Priority);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (cursor) document.querySelector<HTMLElement>('[data-kb="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  // ---- render ----
  const prog = dash.data?.progress;
  const projLabel = filterProject === "none" ? "No project" : filterProject ? (projectById.get(filterProject)?.name ?? "All") : "All";
  const emptyMsg = EMPTY[view];

  return (
    <div className="tk">
      <section className="tk-list" aria-labelledby="tk-h1">
        <div className="tk-head">
          <div className="tk-titlerow">
            <div>
              <h1 id="tk-h1" className="tk-h1">
                {project && <span className="size-2.5 rounded-full" style={{ background: toneDot(project.color) }} />}
                {project ? project.name : q ? `Search: ${q}` : "My Tasks"}
              </h1>
              <div className="tk-summary">
                <b className="num">{counts.dueToday}</b> due today ·{" "}
                {counts.overdue > 0
                  ? <><b className="num od">{counts.overdue}</b> <span className="od">overdue</span></>
                  : <><span className="num">0</span> overdue</>}
                {" · "}<span className="num">{counts.upcoming}</span> coming up
                {project?.description ? ` · ${project.description}` : ""}
              </div>
            </div>
            {prog && (
              <div className="tk-dayprog">
                <span>Today <b className="num">{prog.done} of {prog.total}</b> done</span>
                <div className="tk-bar" role="progressbar" aria-label="Today's progress" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}>
                  <i style={{ width: `${prog.total ? Math.min(100, (prog.done / prog.total) * 100) : 0}%` }} />
                </div>
              </div>
            )}
          </div>
          <div className="tk-tabs">
            <Tabs label="Views" value={view} onChange={(k) => update({ view: k === "all" ? null : k, task: null })}
              items={VIEW_ORDER.map((k) => ({ key: k, label: VIEW_LABEL[k], count: counts[k], negative: k === "overdue" }))} />
          </div>
        </div>

        <div className="tk-tools" role="toolbar" aria-label="Filters">
          <QuickAdd projects={ps} projectId={projectId ?? null} prefill={prefill} />
          <button type="button" className="tk-menu-btn" aria-haspopup="menu" aria-label={`Group by: ${GROUP_LABEL[group]}`}
            onClick={(e) => groupMenu.open(e.currentTarget)}>
            <Layers size={14} strokeWidth={1.6} /><span className="lbl">Group:</span> <b>{GROUP_LABEL[group]}</b>
          </button>
          {!projectId && (
            <button type="button" className="tk-menu-btn" aria-haspopup="menu" aria-label={`Project: ${projLabel}`}
              onClick={(e) => projMenu.open(e.currentTarget)}>
              <Folder size={14} strokeWidth={1.6} /><span className="lbl">Project:</span> <b>{projLabel}</b>
            </button>
          )}
        </div>
        {groupMenu.anchor && (
          <Popover anchor={groupMenu.anchor} onClose={groupMenu.close} label="Group by" role="menu">
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
              <button key={g} type="button" role="menuitemradio" aria-checked={group === g} className="pop-item"
                onClick={() => { groupMenu.close(); setGroup(g); }}>
                {GROUP_LABEL[g]}{group === g && <CheckIcon size={14} style={{ marginLeft: "auto" }} />}
              </button>
            ))}
          </Popover>
        )}
        {projMenu.anchor && (
          <Popover anchor={projMenu.anchor} onClose={projMenu.close} label="Filter by project" role="menu">
            {[["", "All projects"], ["none", "No project"], ...ps.map((p) => [p.id, p.name])].map(([id, name]) => (
              <button key={id} type="button" role="menuitemradio" aria-checked={filterProject === id} className="pop-item"
                onClick={() => { projMenu.close(); update({ project: id || null }); }}>
                {name}{filterProject === id && <CheckIcon size={14} style={{ marginLeft: "auto" }} />}
              </button>
            ))}
          </Popover>
        )}

        <div className="tk-scroll">
          {view !== "done" && <SuggestionTray projects={ps} onEdit={(title) => setPrefill({ text: title, n: Date.now() })} />}

          {tasks.isError ? (
            <p className="px-2 py-4 text-negative">
              Couldn’t load tasks: {errorMessage(tasks.error)}{" "}
              <button type="button" className="underline" onClick={() => tasks.refetch()}>Retry</button>
            </p>
          ) : tasks.isPending ? null : groups.length === 0 ? (
            q ? (
              <div className="tk-empty">
                <h2>No tasks match “{q}”</h2>
                <p>Try another word, or clear the search.</p>
                <button type="button" className="btn btn-sm mt-3" onClick={() => update({ q: null })}>Clear search</button>
              </div>
            ) : (
              <div className="tk-empty">
                <div className="ok"><CheckIcon size={18} strokeWidth={2} aria-hidden="true" /></div>
                <h2>{emptyMsg[0]}</h2>
                <p>{emptyMsg[1]}</p>
              </div>
            )
          ) : (
            groups.map((g) => {
              const lateTasks = g.late ? g.items.filter((t) => t.status !== "completed") : [];
              return (
                <div key={g.key} className={`tk-grp ${shut[g.key] ? "shut" : ""}`}>
                  <div className={`tk-gh ${g.late ? "od" : ""}`}>
                    <h2>
                      <button type="button" className="tog" aria-expanded={!shut[g.key]} onClick={() => setShut({ ...shut, [g.key]: !shut[g.key] })}>
                        <ChevronDown size={14} strokeWidth={1.6} aria-hidden="true" />{g.label}
                      </button>
                    </h2>
                    <span className="c num">{g.items.length}</span>
                    {g.sub && <span className="sub">{g.sub}</span>}
                    {g.late && lateTasks.length > 0 && (
                      <button type="button" className="ga" onClick={() => moveAllToday(lateTasks)}>Move all to today</button>
                    )}
                  </div>
                  {!shut[g.key] && (
                    <div role="list" aria-label={g.label}>
                      {g.items.map((t) => (
                        <ListRow key={t.id} task={t} project={t.projectId ? projectById.get(t.projectId) : undefined}
                          hideProject={!!projectId} selected={selectedId === t.id} cursor={cursor === t.id}
                          draggable={dragEnabled}
                          dragging={drag?.id === t.id} dropTarget={drag?.over === t.id && drag.id !== t.id}
                          onOpen={openTask} onToggle={complete} onReschedule={reschedule} onPriority={setPriority}
                          onFullPage={openFull} onDuplicate={duplicate} onDelete={remove}
                          onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={() => setDrag(null)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {(projectId || q) && (
            <section className="tk-notes" aria-labelledby="pn-h">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 id="pn-h" className="font-medium">{q ? "Matching notes" : "Notes in this project"}</h2>
                <Link to={projectId ? `/notes?project=${projectId}` : "/notes"} className="text-xs underline">All notes</Link>
              </div>
              {notes.data?.length ? (
                <ul>{notes.data.map((n) => (
                  <li key={n.id}><Link to={`/notes?note=${n.id}`} className="block truncate rounded-[6px] px-2 py-1.5 hover:bg-raised">{n.title || n.bodyMd.split("\n")[0]}</Link></li>
                ))}</ul>
              ) : <p className="text-muted">{q ? `No notes match "${q}".` : "No notes linked to this project yet."}</p>}
            </section>
          )}

          <div className="tk-hint" aria-hidden="true">
            <span><kbd>J</kbd> <kbd>K</kbd> move</span><span><kbd>X</kbd> complete</span><span><kbd>T</kbd> today</span>
            <span><kbd>M</kbd> tomorrow</span><span><kbd>1</kbd>–<kbd>3</kbd> priority</span><span><kbd>Enter</kbd> details</span>
            <span><kbd>O</kbd> full page</span><span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      </section>

      {selectedId && (
        <>
          <div className="tk-scrim" onClick={() => update({ task: null })} aria-hidden="true" />
          <div className="tk-panel">
            <QuickPanel key={selectedId} id={selectedId} onClose={() => update({ task: null })} />
          </div>
        </>
      )}
    </div>
  );
}
