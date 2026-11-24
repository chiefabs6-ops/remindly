import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { CalendarDays, FolderKanban, Inbox, LayoutDashboard, ListTodo, Moon, NotebookPen, Plus, Search, Settings, Sun } from "lucide-react";
import type { TaskStatus } from "@tether/core";
import { api, errorMessage, onNavigate } from "../lib/api";
import { isPopoutWindow } from "../lib/taskActions";
import { toneDot } from "../lib/colors";
import { useInboxCounts } from "../lib/inboxCount";
import { useAction, useBackendSync, useInvalidateAll, useProjects, useSettings, useTasks } from "../lib/queries";
import { patchTask } from "../lib/taskActions";
import { CommandPalette } from "./CommandPalette";
import { TASK_DND } from "./TaskRow";
import { ToastProvider, useToast } from "./ui/Toast";

function NavItem({ to, icon, label, count, plainCount }: { to: string; icon: ReactNode; label: string; count?: number; plainCount?: number }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 ${isActive ? "bg-active font-medium text-ink" : "text-[color:var(--muted)] hover:bg-active/60 hover:text-ink"}`
      }
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {!!count && <span className="num rounded-full bg-[var(--pill-today-bg)] px-1.5 text-xs text-[var(--pill-today-ink)]" aria-label={`${count} waiting`}>{count}</span>}
      {!!plainCount && <span className="num text-xs text-faint" aria-label={`${plainCount} open`}>{plainCount}</span>}
    </NavLink>
  );
}

/** The product's mark: a tether knot drawn as two linked rings. */
function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <circle cx="7.5" cy="10" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12.5" cy="10" r="5" fill="none" stroke="var(--today)" strokeWidth="2" />
    </svg>
  );
}

export function useTheme() {
  const settings = useSettings();
  const theme = (settings.data?.theme as string | undefined) ?? "system";
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.setAttribute("data-theme", theme === "system" ? (mq.matches ? "dark" : "light") : theme);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return theme;
}

/** Top-level tasks that are still to do; matches the "All open" tab in My Tasks. */
const OPEN_FILTER = { statuses: ["inbox", "not_started", "in_progress", "waiting"] as TaskStatus[], topLevelOnly: true };

const PROJECT_DND = "application/x-tether-project";
const hasType = (e: DragEvent, type: string) => Array.from(e.dataTransfer?.types ?? []).includes(type);

export function Layout() {
  // The toast provider wraps the whole app frame so the sidebar can show toasts too.
  return (
    <ToastProvider>
      <Frame />
    </ToastProvider>
  );
}

function Frame() {
  useBackendSync();
  const theme = useTheme();
  const setTheme = useAction((t: string) => api.setSetting("theme", t));
  const projects = useProjects();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [palette, setPalette] = useState(false);
  // Sidebar drag and drop: which project link is under the pointer, and which project is being dragged.
  const [overProject, setOverProject] = useState<string | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  // Inbox badge: Chrome captures and other non-Claude suggestions, plus unsorted (inbox-status) tasks.
  // Claude task suggestions are counted in My Tasks' tray instead.
  const inboxCount = useInboxCounts().total;
  const openTasks = useTasks(OPEN_FILTER);
  const openCount = openTasks.data?.length;

  // Notification buttons ask the app to open a screen.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    // Pop-out task windows ignore notification navigation; only the main window follows it.
    if (isPopoutWindow()) return;
    onNavigate((path) => navigate(path)).then((u) => (cancelled ? u() : (stop = u)));
    api.takePendingRoute().then((p) => p && !cancelled && navigate(p)).catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const box = document.getElementById("quick-add");
        if (box) box.focus();
        else {
          navigate("/tasks");
          setTimeout(() => document.getElementById("quick-add")?.focus(), 50);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const closePalette = () => setPalette(false);

  const dropOnProject = async (e: DragEvent, target: { id: string; name: string }) => {
    setOverProject(null);
    const taskId = e.dataTransfer.getData(TASK_DND);
    const dragged = e.dataTransfer.getData(PROJECT_DND) || dragProject;
    const list = projects.data ?? [];
    if (taskId) {
      e.preventDefault();
      try {
        const before = await api.task(taskId);
        if (before.projectId === target.id) return;
        await patchTask(taskId, { projectId: target.id });
        invalidate();
        toast(`Moved to ${target.name}`, async () => {
          await patchTask(taskId, { projectId: before.projectId });
          invalidate();
        });
      } catch (err) {
        toast(errorMessage(err));
      }
    } else if (dragged && dragged !== target.id) {
      e.preventDefault();
      setDragProject(null);
      const at = list.findIndex((p) => p.id === target.id);
      if (at < 0 || !list.some((p) => p.id === dragged)) return;
      const ids = list.map((p) => p.id).filter((id) => id !== dragged);
      ids.splice(at, 0, dragged);
      try {
        await api.reorderProjects(ids);
        invalidate();
      } catch (err) {
        toast(errorMessage(err));
      }
    }
  };

  const icon = { size: 16, strokeWidth: 1.6 };
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  return (
    <div className="grid h-full grid-cols-[228px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] bg-ground max-lg:grid-cols-1 max-lg:grid-rows-[48px_minmax(0,1fr)_56px]">
      <nav aria-label="Main" className="row-span-2 flex min-h-0 flex-col gap-px px-2.5 py-3.5 max-lg:hidden">
        <div className="mb-3 flex h-[34px] items-center gap-2 px-2.5 font-semibold">
          <Mark /> Tether
        </div>
        <NavItem to="/" icon={<LayoutDashboard {...icon} />} label="Overview" />
        <NavItem to="/inbox" icon={<Inbox {...icon} />} label="Inbox" count={inboxCount} />
        <NavItem to="/tasks" icon={<ListTodo {...icon} />} label="My Tasks" plainCount={openCount} />
        <NavItem to="/calendar" icon={<CalendarDays {...icon} />} label="Calendar" />
        <NavItem to="/notes" icon={<NotebookPen {...icon} />} label="Notes" />

        <div className="mt-6 mb-1 flex items-center px-2.5">
          <p className="text-xs text-muted">Projects</p>
          <NavLink to="/projects" className="ml-auto text-xs text-muted hover:text-ink" aria-label="Manage projects">
            <FolderKanban size={14} />
          </NavLink>
        </div>
        <div className="flex min-h-0 flex-col gap-px overflow-y-auto">
          {projects.data?.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} data-project={p.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(PROJECT_DND, p.id);
                setDragProject(p.id);
              }}
              onDragEnd={() => { setDragProject(null); setOverProject(null); }}
              onDragOver={(e) => {
                if (!hasType(e, TASK_DND) && !(dragProject && hasType(e, PROJECT_DND))) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overProject !== p.id) setOverProject(p.id);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverProject((o) => (o === p.id ? null : o)); }}
              onDrop={(e) => void dropOnProject(e, p)}
              className={({ isActive }) => `flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 ${overProject === p.id ? "bg-active ring-2 ring-[var(--today)] ring-inset" : ""} ${dragProject === p.id ? "opacity-50" : ""} ${isActive ? "bg-active text-ink" : "text-[color:var(--muted)] hover:bg-active/60 hover:text-ink"}`}>
              <span className="size-2 flex-none rounded-[2px]" style={{ background: toneDot(p.color) }} />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="num text-xs">{p.openTasks || ""}</span>
            </NavLink>
          ))}
          {projects.data?.length === 0 && <p className="px-2.5 text-xs text-muted">None yet</p>}
        </div>

        <div className="mt-auto flex items-center gap-1 pt-4">
          <NavItem to="/settings" icon={<Settings {...icon} />} label="Settings" />
          <button className="btn btn-ghost ml-auto px-2" aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setTheme.mutate(dark ? "light" : "dark")} title={`Theme: ${theme}`}>
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </nav>

      {/* Top bar, on the same tinted frame as the sidebar (no rule between them). */}
      <div className="flex min-w-0 items-center gap-3 pr-4 pl-2 max-lg:px-4">
        <span className="flex items-center gap-2 font-semibold lg:hidden"><Mark /> Tether</span>
        <button type="button" aria-haspopup="dialog" aria-label="Search tasks, notes and projects" onClick={() => setPalette(true)}
          className="field relative flex h-8 w-full max-w-[420px] items-center border-line pl-8 text-left text-[13px] text-faint max-lg:hidden">
          <Search size={14} className="pointer-events-none absolute top-[8px] left-2.5 text-faint" aria-hidden />
          <span className="flex-1 truncate">Search tasks, notes and projects</span>
          <kbd className="text-xs text-faint">Ctrl K</kbd>
        </button>
        <button type="button" aria-haspopup="dialog" aria-label="Open search" title="Search (Ctrl+K)" onClick={() => setPalette(true)} className="btn btn-ghost ml-auto px-2 lg:hidden"><Search size={16} /></button>
        <NavLink to="/settings" aria-label="Settings" title="Settings" className="btn btn-ghost px-2 lg:hidden"><Settings size={16} /></NavLink>
        <button className="btn btn-primary h-8 max-lg:ml-0 lg:ml-auto flex-none whitespace-nowrap" onClick={() => { navigate("/tasks"); setTimeout(() => document.getElementById("quick-add")?.focus(), 50); }}>
          <Plus size={14} /> New task
        </button>
      </div>

      {/* The sheet: where the work sits. */}
      <main className="mr-2 mb-2 min-w-0 overflow-y-auto rounded-[14px] border border-line bg-surface shadow-[var(--sheet-light)] max-lg:m-0 max-lg:rounded-none max-lg:border-x-0">
        <Outlet />
      </main>

      {/* Phone/tablet: the sidebar folds into a bottom bar. */}
      <nav aria-label="Main" className="flex h-14 border-t border-line bg-surface lg:hidden">
        {[
          ["/", "Overview", <LayoutDashboard {...icon} />, 0],
          ["/inbox", "Inbox", <Inbox {...icon} />, inboxCount],
          ["/tasks", "My Tasks", <ListTodo {...icon} />, 0],
          ["/calendar", "Calendar", <CalendarDays {...icon} />, 0],
          ["/notes", "Notes", <NotebookPen {...icon} />, 0],
          ["/projects", "Projects", <FolderKanban {...icon} />, 0],
        ].map(([to, label, ic, badge]) => (
          <NavLink key={to as string} to={to as string} end={to === "/"}
            className={({ isActive }) => `relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? "text-ink" : "text-muted"}`}>
            {ic}
            {label as string}
            {!!badge && <span className="num absolute top-1.5 left-1/2 ml-2 rounded-full bg-[var(--pill-today-bg)] px-1.5 text-[10px] leading-4 text-[var(--pill-today-ink)]" aria-label={`${badge} waiting`}>{badge as number}</span>}
          </NavLink>
        ))}
      </nav>
      {palette && <CommandPalette onClose={closePalette} />}
    </div>
  );
}
