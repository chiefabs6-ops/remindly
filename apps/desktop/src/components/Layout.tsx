import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { CalendarCheck, ClipboardCheck, FolderKanban, Inbox, ListTodo, Moon, NotebookPen, Search, Settings, Sun } from "lucide-react";
import { api, onNavigate } from "../lib/api";
import { useAction, useBackendSync, useDashboard, useProjects, useSettings } from "../lib/queries";

function NavItem({ to, icon, label, count }: { to: string; icon: ReactNode; label: string; count?: number }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 ${isActive ? "bg-active text-ink" : "text-muted hover:bg-active/60 hover:text-ink"}`
      }
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {!!count && <span className="num text-xs text-ink" aria-label={`${count} waiting`}>{count}</span>}
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
  const inboxTotal = pending + (dash.data?.inboxCount ?? 0);

  // Notification buttons ask the app to open a screen.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    onNavigate((path) => navigate(path)).then((u) => (cancelled ? u() : (stop = u)));
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
    <div className="flex h-full">
      <nav aria-label="Main" className="flex w-[232px] flex-none flex-col gap-1 border-r border-line bg-ground px-3 py-4 max-lg:hidden">
        <div className="mb-4 flex items-center gap-2 px-2.5 font-semibold">
          <Mark /> Tether
        </div>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/tasks?q=${encodeURIComponent(search)}`);
          }}
          className="relative mb-3"
        >
          <Search size={14} className="pointer-events-none absolute top-[9px] left-2.5 text-faint" />
          <label htmlFor="search" className="sr-only">Search tasks and notes</label>
          <input id="search" ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search  Ctrl K" className="field h-8 pl-8 text-[13px]" />
        </form>
        <NavItem to="/" icon={<CalendarCheck {...icon} />} label="Today" />
        <NavItem to="/inbox" icon={<Inbox {...icon} />} label="Inbox" count={inboxTotal} />
        <NavItem to="/tasks" icon={<ListTodo {...icon} />} label="All tasks" />
        <NavItem to="/notes" icon={<NotebookPen {...icon} />} label="Notes" />
        <NavItem to="/projects" icon={<FolderKanban {...icon} />} label="Projects" />
        <NavItem to="/review" icon={<ClipboardCheck {...icon} />} label="Review" />

        <p className="mt-6 mb-1 px-2.5 text-xs text-muted">Projects</p>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {projects.data?.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`}
              className={({ isActive }) => `flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 ${isActive ? "bg-active" : "text-muted hover:text-ink"}`}>
              <span className="size-2 flex-none rounded-full" style={{ background: p.color ?? "var(--faint)" }} />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="num text-xs text-faint">{p.openTasks || ""}</span>
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

      {/* Phone/tablet: the sidebar folds into a bottom bar. */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 flex h-14 border-t border-line bg-surface lg:hidden">
        {[
          ["/", "Today", <CalendarCheck {...icon} />],
          ["/inbox", "Inbox", <Inbox {...icon} />],
          ["/tasks", "Tasks", <ListTodo {...icon} />],
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

      <main className="min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4 font-semibold lg:hidden">
          <Mark /> Tether
        </div>
        <Outlet />
      </main>
    </div>
  );
}
