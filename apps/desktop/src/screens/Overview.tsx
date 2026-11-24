import { Fragment, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronRight, ClipboardCheck, FileText, Sparkles, Video } from "lucide-react";
import { addDays, isoDate, isoTime, relativeDayLabel, type Priority, type Task, type TaskStatus } from "@tether/core";
import { ClaudeMark } from "../components/ui/Bits";
import { ListRow } from "../components/TaskRow";
import { useToast } from "../components/ui/Toast";
import { api, errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { longDate, todayIso } from "../lib/format";
import { useInboxCounts } from "../lib/inboxCount";
import { DEFAULT_RULES, dayMoments, type MomentKind, type ReminderRules } from "../lib/reminderPlan";
import { completeTask, patchTask, rescheduleTask } from "../lib/taskActions";
import { useAiEnabled, useDashboard, useInvalidateAll, useNotes, useProjects, useTasks } from "../lib/queries";

/** Same filter as the sidebar count, so both share one cached query. */
const OPEN_FILTER = { statuses: ["inbox", "not_started", "in_progress", "waiting"] as TaskStatus[], topLevelOnly: true };

interface Moment { key: string; time: string; title: string; note?: string }

const NOTE: Partial<Record<MomentKind, string>> = { repeat: "daily", once: "one-off", snooze: "snoozed" };

/**
 * Today's reminders, planned with the scheduler's own rules (lib/reminderPlan): the early reminder
 * (or the due time when there is none), one-offs, snoozes and "keep reminding" mornings. The
 * follow-up after a missed due time is left out of this list.
 */
export function reminderMoments(tasks: Task[], today: string, rules: ReminderRules): Moment[] {
  const all = dayMoments(tasks, rules, today);
  const early = new Set(all.filter((m) => m.kind === "early").map((m) => m.taskId));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return all
    .filter((m) => m.kind !== "followup" && !(m.kind === "due" && early.has(m.taskId)))
    .map((m, i) => {
      const due = byId.get(m.taskId)?.dueTime;
      const note = NOTE[m.kind] ?? (m.kind === "early" && due ? `due ${due}` : m.kind === "due" ? "due" : undefined);
      return { key: `${m.taskId}:${m.kind}:${i}`, time: isoTime(m.at), title: m.title, note };
    });
}

function Card({ title, count, icon, link, children, label }: {
  title: string; count?: number; icon?: React.ReactNode; link?: { to: string; text: string }; children: React.ReactNode; label?: string;
}) {
  return (
    <section className="card" aria-label={label ?? title}>
      <div className="card-h">
        {icon}{title}
        {count !== undefined && <span className="c num">{count}</span>}
        {link && <Link className="a" to={link.to}>{link.text} <ChevronRight size={12} /></Link>}
      </div>
      {children}
    </section>
  );
}

export function OverviewScreen() {
  const dash = useDashboard();
  const tasks = useTasks(OPEN_FILTER);
  const projects = useProjects();
  const notes = useNotes({ limit: 3 });
  const settings = useQuery({ queryKey: ["tether", "reminder-settings"], queryFn: api.reminders });
  const aiOn = useAiEnabled();
  const inbox = useInboxCounts();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [planOn, setPlanOn] = useState(false);
  const plan = useQuery({ queryKey: ["tether", "plan"], queryFn: api.planDay, enabled: planOn });
  const today = dash.data?.today ?? todayIso();
  const open = useMemo(() => tasks.data ?? [], [tasks.data]);
  const ps = projects.data ?? [];
  const projectById = useMemo(() => new Map(ps.map((p) => [p.id, p])), [ps]);

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(errorMessage(e)); } finally { invalidate(); }
  };
  const openTask = (id: string) => navigate(window.innerWidth < 1024 ? `/task/${id}` : `/tasks?task=${id}`);
  const trunc = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

  if (dash.isError) {
    return (
      <div className="ov-page">
        <h1>Overview</h1>
        <p className="summary">Couldn’t load your overview: {errorMessage(dash.error)}</p>
        <button className="btn mt-3" onClick={() => dash.refetch()}>Retry</button>
      </div>
    );
  }
  const d = dash.data;

  const focus: Task[] = [];
  if (d) {
    const seen = new Set<string>();
    for (const t of [...d.overdue, ...d.dueToday, ...d.carriedOver]) if (!seen.has(t.id)) { seen.add(t.id); focus.push(t); }
  }
  const late = d?.overdue.length ?? 0;
  const dueToday = d?.dueToday.length ?? 0;
  const comingUp = (d?.dueSoon.length ?? 0) + (d?.upcoming.length ?? 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(today, i + 1);
    const [y, m, dd] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, dd);
    const items = open
      .filter((t) => t.dueDate === iso)
      .sort((a, b) => (a.dueTime ?? "99") < (b.dueTime ?? "99") ? -1 : (a.dueTime ?? "99") > (b.dueTime ?? "99") ? 1 : 0);
    return { iso, wd: dt.toLocaleDateString("en-IE", { weekday: "short" }), day: dt.getDate(), items };
  });

  const rules: ReminderRules = settings.data
    ? { enabled: settings.data.enabled, dueSoonMinutes: settings.data.dueSoonMinutes, overdueAfterMinutes: settings.data.overdueAfterMinutes, workStart: settings.data.workStart, workDays: settings.data.workDays }
    : DEFAULT_RULES;
  const moments = reminderMoments(open, today, rules);
  const nowHm = isoTime(new Date());
  const firstNext = moments.findIndex((m) => m.time >= nowHm);

  const projRows = ps.map((p) => {
    const mine = open.filter((t) => t.projectId === p.id);
    const od = mine.filter((t) => t.dueDate && t.dueDate < today).length;
    const total = p.doneRecent + p.openTasks;
    return { p, od, open: p.openTasks, done: p.doneRecent, pct: total ? (p.doneRecent / total) * 100 : 0 };
  });

  const complete = (t: Task) => {
    if (t.status === "completed") { void run(() => api.setStatus(t.id, "not_started", false)); return; }
    void run(async () => {
      const undo = await completeTask(t.id);
      toast(`Completed “${trunc(t.title)}”`, () => run(undo));
    });
  };
  const reschedule = (t: Task, date: string | null) =>
    void run(async () => {
      const undo = await rescheduleTask(t.id, date);
      toast(date ? `Moved to ${relativeDayLabel(date, today)}` : "Date removed", () => run(undo));
    });
  const setPriority = (t: Task, p: Priority) => void run(() => patchTask(t.id, { priority: p }));
  const duplicate = (t: Task) => { void run(() => api.duplicate(t.id)); toast(`Duplicated “${trunc(t.title)}”`); };
  const remove = (t: Task) => {
    void run(() => api.deleteTask(t.id));
    toast(`Deleted “${trunc(t.title)}”`, () => run(() => api.restoreTask(t.id)));
  };

  const prog = d?.progress;
  const claudeTitles = inbox.claude.map((s) => (s.payload as { title?: string }).title ?? "Suggestion");

  return (
    <div className="ov-page">
      <header className="pg-h">
        <div>
          <h1>Overview</h1>
          <div className="summary">
            {d ? longDate(d.today) : " "}
            {d && (
              <>
                {" · "}<b className="num">{dueToday}</b> due today{" · "}
                {late > 0 ? <span className="od"><b className="num od">{late}</b> overdue</span> : <><span className="num">0</span> overdue</>}
                {" · "}<span className="num">{comingUp}</span> coming up
              </>
            )}
          </div>
        </div>
        <div className="right ov-actions">
          {aiOn && (
            <button type="button" className="btn" onClick={() => setPlanOn(true)} disabled={plan.isFetching}>
              <Sparkles size={14} /> Plan my day
            </button>
          )}
          <Link className="btn" to="/review"><ClipboardCheck size={14} /> End-of-day review</Link>
          {prog && (
            <div className="dayprog">
              <span>Today <b className="num">{prog.done} of {prog.total}</b> done</span>
              <div className="bar" role="progressbar" aria-label="Today's progress" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}>
                <i style={{ width: `${prog.total ? Math.min(100, (prog.done / prog.total) * 100) : 0}%` }} />
              </div>
            </div>
          )}
        </div>
      </header>

      {planOn && (
        <section className="card ov-plan" aria-label="Plan for today">
          <div className="card-h"><Sparkles size={14} /> Plan for today
            <button type="button" className="a" onClick={() => setPlanOn(false)}>Hide</button>
          </div>
          <div className="card-b ov-plan-b">
            {plan.data ? (
              <>
                <p className="muted">{plan.data.summary}</p>
                {plan.data.items.length > 0 && (
                  <ol>
                    {plan.data.items.map((i) => (
                      <li key={i.task.id}>
                        <button type="button" onClick={() => openTask(i.task.id)}>{i.task.title}</button>
                        <span className="muted"> — {i.reason}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : plan.isError ? <p className="od">{errorMessage(plan.error)}</p> : <div className="ov-skel" aria-busy="true" />}
          </div>
        </section>
      )}

      <div className="ov">
        <div>
          <Card title="Today’s focus" count={focus.length} link={{ to: "/tasks", text: "Open My Tasks" }} label="Today's focus">
            <div className="card-b" role="list">
              {!d ? <div className="ov-skel" aria-busy="true" />
                : focus.length === 0 ? <p className="ov-empty">Nothing due today.</p>
                : focus.map((t) => (
                  <ListRow key={t.id} task={t} project={t.projectId ? projectById.get(t.projectId) : undefined}
                    onOpen={openTask} onToggle={complete} onReschedule={reschedule} onPriority={setPriority}
                    onFullPage={(id) => navigate(`/task/${id}`)} onDuplicate={duplicate} onDelete={remove} />
                ))}
            </div>
          </Card>

          <Card title="Next 7 days" link={{ to: "/tasks?view=upcoming", text: "Upcoming" }}>
            <div className="week">
              {days.map((x) => (
                <Link key={x.iso} className="wd" to="/tasks?view=upcoming" aria-label={`${x.wd} ${x.day}: ${x.items.length} due`}>
                  <div className="dn"><span>{x.wd}</span><b className="num">{x.day}</b><span className="n num">{x.items.length || ""}</span></div>
                  <ul>
                    {x.items.slice(0, 3).map((t) => (
                      <li key={t.id}>
                        <i className="dot" style={{ background: toneDot(t.projectId ? projectById.get(t.projectId)?.color ?? null : null) }} />
                        <span>{t.dueTime && <span className="num ov-time">{t.dueTime} </span>}{t.title}</span>
                      </li>
                    ))}
                  </ul>
                  {x.items.length > 3 && <div className="more">+{x.items.length - 3} more</div>}
                  {x.items.length === 0 && <div className="more">Nothing due</div>}
                </Link>
              ))}
            </div>
          </Card>
        </div>

        <div>
          <Card title="Reminders today" count={moments.length} icon={<Bell size={14} />}>
            {moments.length === 0 ? <p className="ov-empty">No reminders today.</p> : (
              <ul className="tl">
                {moments.map((m, i) => (
                  <Fragment key={m.key}>
                    {i === firstNext && <li className="nowline" aria-hidden="true" />}
                    <li className={m.time < nowHm ? "past" : i === firstNext ? "next" : ""}>
                      <time className="num">{m.time}</time><i className="pt" />
                      <span>{m.title}{m.note && <span className="muted"> · {m.note}</span>}</span>
                    </li>
                  </Fragment>
                ))}
                {firstNext === -1 && <li className="nowline" aria-hidden="true" />}
              </ul>
            )}
          </Card>

          <Card title="Waiting for you">
            <div className="card-b">
              <Link className="wl" to="/inbox">
                <span className="big num">{inbox.total}</span>
                <span className="tx">In your Inbox<small>{inbox.captures} to review · {inbox.unsorted} unsorted</small></span>
                <ChevronRight size={14} />
              </Link>
              <Link className="wl" to="/tasks?tray=1">
                <span className="big num">{inbox.claude.length}</span>
                <span className="tx"><span className="claude-g"><ClaudeMark /></span> Claude suggestions
                  <small>{claudeTitles.join(" · ") || "None waiting"}</small></span>
                <ChevronRight size={14} />
              </Link>
            </div>
          </Card>

          <Card title="Projects">
            <div className="card-b">
              {projects.isError ? <p className="ov-empty">Couldn’t load projects.</p>
                : projRows.length === 0 ? <p className="ov-empty">No projects yet.</p>
                : projRows.map(({ p, od, open: o, done, pct }) => (
                  <Link key={p.id} className="pl" to={`/projects/${p.id}`}>
                    <span className="nm">
                      <i className="dot" style={{ background: toneDot(p.color) }} />
                      <span>{p.name}</span>
                      {od > 0 && <span className="pill od">{od} late</span>}
                    </span>
                    <span className="o num" aria-label={`${o} open`}>{o}</span>
                    <span className="bar grey" title={`${done} done in the last 30 days, ${o} open`}><i style={{ width: `${pct}%` }} /></span>
                  </Link>
                ))}
            </div>
          </Card>

          <Card title="Recent notes" link={{ to: "/notes", text: "All notes" }}>
            <div className="card-b">
              {notes.isError ? <p className="ov-empty">Couldn’t load notes.</p>
                : (notes.data ?? []).length === 0 ? <p className="ov-empty">No notes yet.</p>
                : (notes.data ?? []).slice(0, 3).map((n) => (
                  <Link key={n.id} className="wl ov-note" to={`/notes?note=${n.id}`}>
                    {n.kind === "meeting" ? <Video size={16} /> : <FileText size={16} />}
                    <span className="tx">{n.title}<small>{n.kind} · {relativeDayLabel(isoDate(new Date(n.updatedAt)), today)}</small></span>
                  </Link>
                ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
