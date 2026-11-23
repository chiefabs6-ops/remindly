import { useParams, useSearchParams } from "react-router";
import type { TaskFilter, TaskStatus } from "@tether/core";
import { QuickAdd } from "../components/QuickAdd";
import { TaskPanel } from "../components/TaskPanel";
import { TaskList } from "../components/TaskRow";
import { errorMessage } from "../lib/api";
import { useNotes, useProjects, useTasks } from "../lib/queries";
import { Link } from "react-router";

const VIEWS: Record<string, { label: string; statuses: TaskStatus[] }> = {
  all: { label: "All", statuses: [] },
  open: { label: "Open", statuses: ["inbox", "not_started", "in_progress", "waiting"] },
  waiting: { label: "Waiting", statuses: ["waiting"] },
  done: { label: "Completed", statuses: ["completed"] },
  archived: { label: "Archived", statuses: ["archived"] },
};

/** All tasks, or one project's tasks when mounted at /projects/:projectId. */
export function TasksScreen() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  // A search looks across every status unless a view is picked.
  const view = VIEWS[params.get("view") ?? ""] ? params.get("view")! : q ? "all" : "open";
  const filterProject = projectId ?? params.get("project") ?? "";
  const filter: TaskFilter = {
    statuses: VIEWS[view].statuses,
    topLevelOnly: true,
    query: q || null,
    projectId: filterProject && filterProject !== "none" ? filterProject : null,
    noProject: filterProject === "none",
  };
  const tasks = useTasks(filter);
  const projects = useProjects();
  const notes = useNotes({ projectId: projectId ?? null, query: q || null, limit: 5 });
  const ps = projects.data ?? [];
  const project = projectId ? ps.find((p) => p.id === projectId) : undefined;
  const open = params.get("task");

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const count = tasks.data?.length ?? 0;

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-8">
        <header className="mb-4">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-[-0.01em]">
            {project && <span className="size-2.5 rounded-full" style={{ background: project.color ?? "var(--faint)" }} />}
            {project ? project.name : q ? `Search: ${q}` : "All tasks"}
          </h1>
          <p className="mt-1 text-muted">
            <span className="num">{count}</span> {VIEWS[view].label.toLowerCase()} {count === 1 ? "task" : "tasks"}
            {project?.description ? ` · ${project.description}` : ""}
          </p>
        </header>

        <div className="mb-4">
          <QuickAdd projects={ps} projectId={projectId ?? null} />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filters">
          <div className="flex rounded-[6px] bg-active p-0.5" role="group" aria-label="Status">
            {Object.entries(VIEWS).map(([k, v]) => (
              <button key={k} onClick={() => update({ view: k })}
                className={`h-7 rounded-[5px] px-3 text-[13px] ${view === k ? "bg-surface font-medium" : "text-muted hover:text-ink"}`}
                aria-pressed={view === k}>
                {v.label}
              </button>
            ))}
          </div>
          {!projectId && (
            <>
              <label htmlFor="f-project" className="sr-only">Project</label>
              <select id="f-project" className="field h-8 w-auto text-[13px]" value={filterProject}
                onChange={(e) => update({ project: e.target.value || null })}>
                <option value="">All projects</option>
                <option value="none">No project</option>
                {ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </>
          )}
          {q && <button className="btn btn-ghost h-8" onClick={() => update({ q: null })}>Clear search</button>}
        </div>

        <div className="rounded-[8px] border border-line bg-surface p-3">
          {tasks.isError ? (
            <p className="text-negative">Couldn’t load tasks: {errorMessage(tasks.error)} <button className="underline" onClick={() => tasks.refetch()}>Retry</button></p>
          ) : (
            <TaskList tasks={tasks.data ?? []} projects={ps} selectedId={open} onOpen={(id) => update({ task: id })}
              hideProject={!!projectId}
              empty={q ? `No ${VIEWS[view].label.toLowerCase()} tasks match “${q}”.` : `No ${VIEWS[view].label.toLowerCase()} tasks here.`} />
          )}
        </div>

        {(projectId || q) && (
          <section className="mt-6 rounded-[8px] border border-line bg-surface p-4" aria-labelledby="pn-h">
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
      </div>
      {open && (
        <div className="w-[400px] flex-none border-l border-line bg-surface max-lg:fixed max-lg:inset-0 max-lg:z-20 max-lg:w-full">
          <TaskPanel key={open} id={open} projects={ps} onClose={() => update({ task: null })} onOpen={(id) => update({ task: id })} />
        </div>
      )}
    </div>
  );
}
