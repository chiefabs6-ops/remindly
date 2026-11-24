// One project (mockup E): project list on the left; header, stats, tasks, notes and repos on the right.
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Code2, GitBranch, StickyNote } from "lucide-react";
import { addDays, relativeDayLabel, type Priority, type Task, type TaskStatus } from "@tether/core";
import { QuickAdd } from "../components/QuickAdd";
import { SkeletonPage, SkeletonRows } from "../components/Skeleton";
import { ListRow } from "../components/TaskRow";
import { useToast } from "../components/ui/Toast";
import { api, errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { ago, dueTone, todayIso } from "../lib/format";
import { useInvalidateAll, useNotes, useProjects, useTasks } from "../lib/queries";
import { completeTask, patchTask, rescheduleTask } from "../lib/taskActions";
import { useLinkedProjectIds, useOverdueByProject } from "./Projects";

const OPEN: TaskStatus[] = ["inbox", "not_started", "in_progress", "waiting"];
const trunc = (s: string) => (s.length > 38 ? `${s.slice(0, 38)}…` : s);

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const projects = useProjects();
  const tasks = useTasks({ statuses: OPEN, topLevelOnly: true, projectId });
  const notes = useNotes({ projectId, limit: 200 });
  const folders = useQuery({ queryKey: ["tether", "code-projects"], queryFn: api.codeProjects });
  const overdueBy = useOverdueByProject();
  const linkedIds = useLinkedProjectIds();
  const today = todayIso();

  const list = projects.data ?? [];
  const project = list.find((p) => p.id === projectId);
  const open = useMemo(() => tasks.data ?? [], [tasks.data]);
  const repos = (folders.data ?? []).filter((f) => f.projectId === projectId);

  const { groups, overdue, week } = useMemo(() => {
    const [y, m, d] = today.split("-").map(Number);
    const endOfWeek = addDays(today, (7 - new Date(y, m - 1, d).getDay()) % 7);
    const g = { overdue: [] as Task[], week: [] as Task[], later: [] as Task[], none: [] as Task[] };
    for (const t of open) {
      if (dueTone(t, today) === "overdue") g.overdue.push(t);
      else if (!t.dueDate) g.none.push(t);
      else if (t.dueDate <= endOfWeek) g.week.push(t);
      else g.later.push(t);
    }
    return {
      overdue: g.overdue.length,
      week: g.week.length,
      groups: [
        { key: "overdue", label: "Overdue", items: g.overdue, late: true },
        { key: "week", label: "This week", items: g.week, late: false },
        { key: "later", label: "Later", items: g.later, late: false },
        { key: "none", label: "No date", items: g.none, late: false },
      ].filter((x) => x.items.length > 0),
    };
  }, [open, today]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      invalidate();
    }
  };
  const complete = (t: Task) => {
    void run(async () => {
      const undo = await completeTask(t.id);
      toast(`Completed “${trunc(t.title)}”`, () => run(undo));
    });
  };
  const reschedule = (t: Task, date: string | null) => {
    void run(async () => {
      const undo = await rescheduleTask(t.id, date);
      toast(date ? `Moved to ${relativeDayLabel(date, today)}` : "Date removed", () => run(undo));
    });
  };
  const setPriority = (t: Task, p: Priority) => void run(() => patchTask(t.id, { priority: p }));
  const duplicate = (t: Task) => {
    void run(() => api.duplicate(t.id));
    toast(`Duplicated “${trunc(t.title)}”`);
  };
  const remove = (t: Task) => {
    void run(() => api.deleteTask(t.id));
    toast(`Deleted “${trunc(t.title)}”`, () => run(() => api.restoreTask(t.id)));
  };
  const openFull = (id: string) => navigate(`/task/${id}`);
  const openTask = (id: string) => (window.innerWidth < 1024 ? openFull(id) : navigate(`/tasks?task=${id}`));

  return (
    <div className="split pj-page has-item">
      <nav className="lp" aria-label="Projects">
        <div className="lp-h">
          <h2>Projects</h2>
          <Link to="/projects" className="btn btn-sm">Manage</Link>
        </div>
        {list.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className={`li ${p.id === projectId ? "on" : ""}`} aria-current={p.id === projectId ? "page" : undefined}>
            <span className="t"><i className="dot" style={{ background: toneDot(p.color) }} aria-hidden="true" /><span className="name">{p.name}</span></span>
            <span className="m">
              <span className="num">{p.openTasks} open</span>
              {(overdueBy.get(p.id) ?? 0) > 0 && <span className="num od">{overdueBy.get(p.id)} overdue</span>}
              <span className="r">{linkedIds.has(p.id) && <Code2 size={13} strokeWidth={1.6} aria-label="Claude Code repo linked" />}</span>
            </span>
          </Link>
        ))}
      </nav>

      <div className="rp">
        <div className="pj-back"><Link to="/projects" className="btn btn-sm btn-ghost"><ChevronLeft size={14} aria-hidden="true" />Projects</Link></div>
        {projects.isPending ? <SkeletonPage lines={3} label="Loading project" /> : !project ? (
          <div className="pj-empty">
            <h1>Project not found</h1>
            <p>It may have been archived or deleted.</p>
            <Link to="/projects" className="btn mt-3">Back to Projects</Link>
          </div>
        ) : (
          <>
            <header className="ph">
              <h1><i className="dot" style={{ background: toneDot(project.color) }} aria-hidden="true" />{project.name}</h1>
              {project.description && <p>{project.description}</p>}
              <div className="stats" aria-label="Project numbers">
                <div><b className="num">{open.length}</b>Open</div>
                <div><b className={`num ${overdue > 0 ? "od" : ""}`}>{overdue}</b>Overdue</div>
                <div><b className="num">{week}</b>Due this week</div>
                <div><b className="num">{project.doneRecent}</b>Done in 30 days</div>
              </div>
            </header>

            <div className="pbody">
              <section className="card" aria-labelledby="pj-tasks">
                <div className="card-h">
                  <h2 id="pj-tasks">Tasks</h2><span className="c num">{open.length}</span>
                  <Link className="a" to={`/tasks?project=${project.id}`}>Open in My Tasks<ChevronRight size={13} aria-hidden="true" /></Link>
                </div>
                <div className="card-b">
                  <div className="pj-add"><QuickAdd projects={list} projectId={project.id} /></div>
                  {tasks.isError ? (
                    <p className="pj-none">Couldn’t load tasks: {errorMessage(tasks.error)}</p>
                  ) : tasks.isPending ? (
                    <SkeletonRows n={3} label="Loading tasks" />
                  ) : groups.length === 0 ? (
                    <p className="pj-none">No tasks in this project. Add one above.</p>
                  ) : groups.map((g) => (
                    <div key={g.key} className="pj-grp">
                      <h3 className={`gh ${g.late ? "od" : ""}`}>{g.label}<span className="c num">{g.items.length}</span></h3>
                      <div role="list" aria-label={g.label}>
                        {g.items.map((t) => (
                          <ListRow key={t.id} task={t} hideProject onOpen={openTask} onToggle={complete} onReschedule={reschedule}
                            onPriority={setPriority} onFullPage={openFull} onDuplicate={duplicate} onDelete={remove} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <div className="pj-side">
                <section className="card" aria-labelledby="pj-notes">
                  <div className="card-h">
                    <h2 id="pj-notes">Notes in this project</h2><span className="c num">{notes.data?.length ?? 0}</span>
                    <Link className="a" to={`/notes?project=${project.id}`}>All notes</Link>
                  </div>
                  <div className="card-b">
                    {notes.data?.length ? notes.data.slice(0, 8).map((n) => (
                      <Link key={n.id} to={`/notes?note=${n.id}`} className="wl">
                        <StickyNote size={14} strokeWidth={1.6} aria-hidden="true" />
                        <span className="tx">{n.title || n.bodyMd.split("\n")[0] || "Untitled"}<small>{n.kind === "meeting" ? "Meeting" : "Note"} · {ago(n.updatedAt)}</small></span>
                      </Link>
                    )) : <p className="pj-none">No notes in this project yet.</p>}
                  </div>
                </section>
                <section className="card" aria-labelledby="pj-repos">
                  <div className="card-h"><Code2 size={14} strokeWidth={1.6} aria-hidden="true" /><h2 id="pj-repos">Code repos</h2></div>
                  <div className="card-b repos">
                    {repos.map((r) => (
                      <div key={r.id} className="repo"><GitBranch size={13} strokeWidth={1.6} aria-hidden="true" /><span className="mono">{r.name}</span><small title="Last seen">{ago(r.lastSeenAt)}</small></div>
                    ))}
                    {repos.length === 0 && <p className="pj-hint">Claude Code links a repo here the first time it suggests a task from it.</p>}
                  </div>
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
