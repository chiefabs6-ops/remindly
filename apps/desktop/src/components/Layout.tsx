import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { CalendarCheck, ClipboardCheck, FolderKanban, ListTodo, Moon, NotebookPen, Plus, Search, Settings, Sun } from "lucide-react";
import type { TaskStatus } from "@tether/core";
import { api, onNavigate } from "../lib/api";
import { toneDot } from "../lib/colors";
import { useAction, useBackendSync, useDashboard, useProjects, useSettings, useTasks } from "../lib/queries";
import { ToastProvider } from "./ui/Toast";

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
      {!!count && <span className="num rounded-full bg-[var(--pill-today-bg)] px-1.5 text-xs text-[var(--pill-today-ink)]" aria-label={`${count} waiting for approval`}>{count}</span>}
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

export function Layout() {
  useBackendSync();
  const theme = useTheme();
  const setTheme = useAction((t: string) => api.setSetting("theme", t));
  const dash = useDashboard();
  const projects = useProjects();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const pending = dash.data?.pending.reduce((n, p) => n + p.count, 0) ?? 0;
  const openTasks = useTasks(OPEN_FILTER);
  const openCount = openTasks.data?.length;

  // Notification buttons ask the app to open a screen.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
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
        searchRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        document.getElementById("quick-add")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const icon = { size: 16, strokeWidth: 1.6 };
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  return (
    <div className="grid h-full grid-cols-[228px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] bg-ground max-lg:grid-cols-1 max-lg:grid-rows-[48px_minmax(0,1fr)_56px]">
      <nav aria-label="Main" className="row-span-2 flex min-h-0 flex-col gap-px px-2.5 py-3.5 max-lg:hidden">
        <div className="mb-3 flex h-[34px] items-center gap-2 px-2.5 font-semibold">
          <Mark /> Tether
        </div>
        <NavItem to="/" icon={<CalendarCheck {...icon} />} label="Today" count={pending} />
        <NavItem to="/tasks" icon={<ListTodo {...icon} />} label="My Tasks" plainCount={openCount} />
        <NavItem to="/notes" icon={<NotebookPen {...icon} />} label="Notes" />
        <NavItem to="/review" icon={<ClipboardCheck {...icon} />} label="Review" />

        <div className="mt-6 mb-1 flex items-center px-2.5">
          <p className="text-xs text-muted">Projects</p>
          <NavLink to="/projects" className="ml-auto text-xs text-muted hover:text-ink" aria-label="Manage projects">
            <FolderKanban size={14} />
          </NavLink>
        </div>
        <div className="flex min-h-0 flex-col gap-px overflow-y-auto">
          {projects.data?.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`}
              className={({ isActive }) => `flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 ${isActive ? "bg-active text-ink" : "text-[color:var(--muted)] hover:bg-active/60 hover:text-ink"}`}>
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
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/tasks?q=${encodeURIComponent(search)}`);
          }}
          className="relative w-full max-w-[420px] max-lg:hidden"
        >
          <Search size={14} className="pointer-events-none absolute top-[9px] left-2.5 text-faint" />
          <label htmlFor="search" className="sr-only">Search tasks and notes</label>
          <input id="search" ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks and notes" className="field h-8 border-line pl-8 text-[13px]" />
          <kbd className="pointer-events-none absolute top-[7px] right-2.5 text-xs text-faint">Ctrl K</kbd>
        </form>
        <button className="btn btn-primary ml-auto h-8 flex-none whitespace-nowrap" onClick={() => { navigate("/"); setTimeout(() => document.getElementById("quick-add")?.focus(), 50); }}>
          <Plus size={14} /> New task
        </button>
      </div>

      {/* The sheet: where the work sits. */}
      <main className="mr-2 mb-2 min-w-0 overflow-y-auto rounded-[14px] border border-line bg-surface shadow-[var(--sheet-light)] max-lg:m-0 max-lg:rounded-none max-lg:border-x-0">
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      </main>

      {/* Phone/tablet: the sidebar folds into a bottom bar. */}
      <nav aria-label="Main" className="flex h-14 border-t border-line bg-surface lg:hidden">
        {[
          ["/", "Today", <CalendarCheck {...icon} />],
          ["/tasks", "My Tasks", <ListTodo {...icon} />],
          ["/notes", "Notes", <NotebookPen {...icon} />],
          ["/settings", "Settings", <Settings {...icon} />],
        ].map(([to, label, ic]) => (
          <NavLink key={to as string} to={to as string} end={to === "/"}
            className={({ isActive }) => `flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? "text-ink" : "text-muted"}`}>
            {ic}
            {label as string}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
