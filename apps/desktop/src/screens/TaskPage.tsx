import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, Bot, Check, Copy, ExternalLink, Globe, Pencil, RotateCcw, StickyNote, Trash2 } from "lucide-react";
import { PRIORITY_LABEL, STATUS_LABEL, TASK_STATUSES, addDays, type HistoryEntry, type Priority, type TaskDetail, type TaskInput, type TaskStatus } from "@tether/core";
import { TaskPanel } from "../components/TaskPanel";
import { TaskList } from "../components/TaskRow";
import { api, errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { ago, dueTone, hostOf, todayIso } from "../lib/format";
import { keys, queryClient, useAction, useAiEnabled, useProjects, useTask } from "../lib/queries";

/** Tiny Markdown for notes and Claude context: paragraphs, "- " lists and **bold** only. */
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const bold = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : part,
    );
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={blocks.length} className="mb-3 list-disc space-y-0.5 pl-5">{list.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) list.push(line.replace(/^\s*[-*] /, ""));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length} className="mb-2">{bold(line)}</p>);
    }
  }
  flush();
  return <div className="leading-6">{blocks}</div>;
}

const SOURCE = {
  manual: { label: "Added by you", icon: null },
  chrome: { label: "Captured in Chrome", icon: <Globe size={14} /> },
  claude: { label: "Suggested by Claude Code", icon: <Bot size={14} /> },
  note: { label: "Made from a note", icon: <StickyNote size={14} /> },
  ai: { label: "Suggested by local AI", icon: <Bot size={14} /> },
} as const;

const FIELD: Record<string, string> = {
  title: "title", description: "description", notes: "notes", status: "status", priority: "priority",
  due_date: "due date", due_time: "due time", scheduled_date: "do-on date", project_id: "project", tags: "tags",
};
const WHO: Record<string, string> = { user: "You", claude: "Claude Code", chrome: "Chrome", system: "Tether", ai: "Local AI" };

function historyLine(h: HistoryEntry): string {
  const who = WHO[h.actor] ?? h.actor;
  switch (h.action) {
    case "created": return `${who} created the task`;
    case "suggested": return `Approved from ${WHO[h.actor] ?? "a suggestion"}`;
    case "duplicated": return `${who} duplicated it from another task`;
    case "deleted": return `${who} deleted it`;
    case "restored": return `${who} restored it`;
    case "status": return `${who} set status to ${STATUS_LABEL[h.newValue as keyof typeof STATUS_LABEL] ?? h.newValue}`;
    default: {
      const f = FIELD[h.field ?? ""] ?? h.field ?? "a field";
      if (h.field === "notes" || h.field === "description") return `${who} edited the ${f}`;
      if (h.field === "project_id") return `${who} changed the project`;
      if (h.field === "status") return `${who} set status to ${STATUS_LABEL[h.newValue as keyof typeof STATUS_LABEL] ?? h.newValue}`;
      if (!h.newValue) return `${who} cleared the ${f}`;
      return `${who} set the ${f} to ${h.newValue}`;
    }
  }
}

/** Every field of the task, so a one-field change can be saved with updateTask. */
function asInput(t: TaskDetail): TaskInput {
  return {
    title: t.title, description: t.description, notes: t.notes, status: t.status, priority: t.priority,
    dueDate: t.dueDate, dueTime: t.dueTime, scheduledDate: t.scheduledDate, projectId: t.projectId, tags: t.tags,
  };
}

const same = (a: string | null, b: string | null) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

function Prop({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-[13px]">
      {htmlFor ? <label htmlFor={htmlFor} className="text-muted">{label}</label> : <span className="text-muted">{label}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Quiet inline control: looks like text until hovered or focused. */
const QUIET = "h-8 w-full min-w-0 rounded-[6px] border border-transparent bg-transparent px-2 text-[13px] hover:bg-active focus:border-line focus:bg-raised focus:outline-none";

/** An input that saves once, on blur or Enter (not on every keystroke), and follows the saved value while idle. */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (draft !== value) onCommit(draft);
  };
  return (
    <input {...rest} value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
  );
}

function Body({ t }: { t: TaskDetail }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const ps = projects.data ?? [];
  const project = ps.find((p) => p.id === t.projectId);
  const [editing, setEditing] = useState(false);
  const [subtask, setSubtask] = useState("");
  const done = t.status === "completed";
  const today = todayIso();
  const toggle = useAction(() => api.setStatus(t.id, done ? "not_started" : "completed", !done));
  const duplicate = useAction(() => api.duplicate(t.id));
  // Leave the page before the data refresh, so the deleted task is never shown as "not found".
  const remove = useAction(async () => {
    await api.deleteTask(t.id);
    back();
  });
  const addSub = useAction((title: string) => api.createTask({ title }, t.id));
  const aiOn = useAiEnabled();
  const [steps, setSteps] = useState<{ text: string; on: boolean }[] | null>(null);
  const breakdown = useAction(() => api.aiBreakdown(t.id));
  const addSteps = useAction(async (titles: string[]) => {
    for (const title of titles) {
      await api.createTask({ title }, t.id);
      setSteps((cur) => cur?.filter((x) => x.text !== title) ?? null);
    }
  });
  const tone = dueTone(t);
  // Build each save from the newest copy of the task, so overlapping edits never send stale fields back.
  const latest = () => queryClient.getQueryData<TaskDetail>(keys.task(t.id)) ?? t;
  const patch = useAction((p: Partial<TaskInput>) => api.updateTask(t.id, { ...asInput(latest()), ...p }));
  const setStatus = useAction((s: TaskStatus) => api.setStatus(t.id, s, s === "completed"));
  // Moving the date keeps the saved time; a cleared time stays cleared.
  const reschedule = useAction((d: string | null) => api.reschedule(t.id, d, d ? latest().dueTime : null));
  const busy = patch.isPending || setStatus.isPending || reschedule.isPending || toggle.isPending;
  const [remindAt, setRemindAt] = useState("");
  const remind = useAction((local: string) => api.remindAt(t.id, new Date(local).toISOString()));
  const saveTags = (text: string) => {
    const tags = [...new Set(text.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean))];
    if (tags.join(",") !== latest().tags.join(",")) patch.mutate({ tags });
  };
  const err = toggle.error ?? duplicate.error ?? remove.error ?? addSub.error ?? patch.error ?? setStatus.error ?? reschedule.error ?? remind.error;
  const location = useLocation();
  // Opened directly (e.g. from a notification): no in-app history to go back to.
  const back = () => (location.key !== "default" ? navigate(-1) : navigate("/", { replace: true }));

  if (editing) {
    return (
      <div className="max-w-[900px] px-6 py-4 lg:px-10">
        <TaskPanel id={t.id} projects={ps} onClose={() => setEditing(false)} onDeleted={back} onOpen={(id) => navigate(`/task/${id}`)} />
      </div>
    );
  }

  const showDescription = t.description && !same(t.description, t.sourceSelection);
  const ps2 = ps.filter((p) => !p.archivedAt || p.id === t.projectId);

  return (
    <div className="flex min-h-full flex-col overflow-x-clip lg:flex-row">
    <article className="min-w-0 flex-1 px-6 pt-5 pb-12 lg:px-10" aria-labelledby="task-title">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost -ml-2 h-8" onClick={back}><ArrowLeft size={15} /> Back</button>
        {project && (
          <Link to={`/projects/${project.id}`} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
            <span className="text-faint">/</span>
            <span className="h-2 w-2 rounded-[2px]" style={{ background: toneDot(project.color) }} />{project.name}
          </Link>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn h-8" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
          <button className="btn btn-primary h-8" disabled={busy} onClick={() => toggle.mutate(undefined)}>
            {done ? <><RotateCcw size={14} /> Reopen</> : <><Check size={14} /> Mark done</>}
          </button>
          <button className="btn btn-ghost h-8 px-2" aria-label="Duplicate task" title="Duplicate"
            onClick={() => duplicate.mutate(undefined, { onSuccess: (c) => navigate(`/task/${c.id}`) })}><Copy size={15} /></button>
          <button className="btn btn-ghost btn-danger h-8 px-2" aria-label="Delete task" title="Delete"
            onClick={() => confirm(`Delete "${t.title}"${t.subtaskCount ? ` and its ${t.subtaskCount} subtasks` : ""}?`) && remove.mutate(undefined)}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="max-w-[900px]">
      {t.parentId && (
        <p className="mb-2 text-[13px] text-muted">Subtask of <Link className="underline" to={`/task/${t.parentId}`}>the parent task</Link></p>
      )}
      <h1 id="task-title" className={`text-2xl leading-8 font-semibold tracking-[-0.01em] ${done ? "text-muted line-through" : ""}`}>{t.title}</h1>

      {showDescription ? <p className="mt-3 text-[15px] leading-6 whitespace-pre-wrap">{t.description}</p>
        : !t.sourceSelection && <p className="mt-3 text-muted"><button className="underline" onClick={() => setEditing(true)}>Add a description</button></p>}

      {(t.sourceSelection || t.sourceUrl) && (
        <section className="mt-6 rounded-[10px] bg-raised p-4" aria-label="Where it came from">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] text-muted">
            {SOURCE[t.source].icon}{SOURCE[t.source].label} · {ago(t.createdAt)}
          </p>
          {t.sourceSelection && <blockquote className="mb-2 border-l-2 border-today pl-3 text-[15px] leading-6 whitespace-pre-wrap">“{t.sourceSelection}”</blockquote>}
          {t.sourceUrl && (
            <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] underline">
              {t.sourceTitle || hostOf(t.sourceUrl)} <span className="text-muted">· {hostOf(t.sourceUrl)}</span> <ExternalLink size={12} />
            </a>
          )}
        </section>
      )}

      <section className="mt-8" aria-labelledby="sub-h">
        <h2 id="sub-h" className="mb-1 flex items-baseline gap-2 font-semibold">
          Subtasks <span className="num text-[13px] font-normal text-muted">{t.subtaskDone}/{t.subtaskCount}</span>
        </h2>
        {t.subtasks.length > 0 && <TaskList tasks={t.subtasks} projects={ps} onOpen={(id) => navigate(`/task/${id}`)} hideProject empty="" />}
        {aiOn && !steps && (
          <button type="button" className="btn mt-2" disabled={breakdown.isPending}
            onClick={() => breakdown.mutate(undefined, { onSuccess: (res) => setSteps(res.value.map((text) => ({ text, on: true }))) })}>
            {breakdown.isPending ? "Thinking…" : "Break into steps with AI"}
          </button>
        )}
        {breakdown.isError && <p className="mt-2 text-negative">{errorMessage(breakdown.error)}</p>}
        {steps && (
          <fieldset className="mt-2 rounded-[8px] bg-raised p-3">
            <legend className="label">Suggested steps — pick the ones to add</legend>
            {steps.map((st, i) => (
              <label key={i} className="flex items-center gap-2 py-1">
                <input type="checkbox" checked={st.on} onChange={() => setSteps(steps.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
                {st.text}
              </label>
            ))}
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn btn-primary" disabled={addSteps.isPending || !steps.some((x) => x.on)}
                onClick={() => addSteps.mutate(steps.filter((x) => x.on).map((x) => x.text), { onSuccess: () => setSteps(null) })}>
                Add {steps.filter((x) => x.on).length} subtasks
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setSteps(null)}>Cancel</button>
            </div>
          </fieldset>
        )}
        <form className="mt-2" onSubmit={(e) => { e.preventDefault(); if (subtask.trim()) addSub.mutate(subtask.trim(), { onSuccess: () => setSubtask("") }); }}>
          <label htmlFor="new-sub" className="sr-only">Add a subtask</label>
          <input id="new-sub" className="field" placeholder="+ Add a subtask" value={subtask} onChange={(e) => setSubtask(e.target.value)} />
        </form>
      </section>

      <section className="mt-8" aria-labelledby="notes-h">
        <h2 id="notes-h" className="mb-2 font-semibold">Notes</h2>
        {t.notes ? <Markdown text={t.notes} /> : (
          <p className="text-muted">No notes yet. <button className="underline" onClick={() => setEditing(true)}>Add notes</button></p>
        )}
      </section>

      {err && <p className="mt-4 text-negative">{errorMessage(err)}</p>}
      </div>
    </article>

    <aside className="min-w-0 flex-none border-line px-6 py-5 max-lg:border-t lg:w-[320px] lg:border-l lg:px-5" aria-label="Properties">
      <h2 className="mb-2 text-xs font-medium text-muted">Properties</h2>
      <fieldset disabled={busy} aria-busy={busy} className="contents">
      <Prop label="Status" htmlFor="p-status">
        <select id="p-status" className={QUIET} value={t.status}
          onChange={(e) => setStatus.mutate(e.target.value as TaskStatus)}>
          {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </Prop>
      <Prop label="Due" htmlFor="p-due">
        <CommitInput id="p-due" type="date" className={`${QUIET} ${tone === "overdue" ? "text-negative" : tone === "today" ? "text-today" : ""}`}
          value={t.dueDate ?? ""} onCommit={(v) => reschedule.mutate(v || null)} />
      </Prop>
      {t.dueDate && (
        <Prop label="Due time" htmlFor="p-time">
          <CommitInput id="p-time" type="time" className={QUIET} value={t.dueTime ?? ""}
            onCommit={(v) => patch.mutate({ dueTime: v || null })} />
        </Prop>
      )}
      <Prop label="Do on" htmlFor="p-do">
        <CommitInput id="p-do" type="date" className={QUIET} value={t.scheduledDate ?? ""}
          onCommit={(v) => patch.mutate({ scheduledDate: v || null })} />
      </Prop>
      <Prop label="Project" htmlFor="p-project">
        <select id="p-project" className={QUIET} value={t.projectId ?? ""}
          onChange={(e) => patch.mutate({ projectId: e.target.value || null })}>
          <option value="">No project</option>
          {ps2.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Prop>
      <Prop label="Priority" htmlFor="p-priority">
        <select id="p-priority" className={QUIET} value={t.priority}
          onChange={(e) => patch.mutate({ priority: Number(e.target.value) as Priority })}>
          {([0, 1, 2, 3] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
      </Prop>
      <Prop label="Tags" htmlFor="p-tags">
        <CommitInput id="p-tags" className={QUIET} placeholder="Add tags" value={t.tags.join(", ")} onCommit={saveTags} />
      </Prop>
      {!done && (
        <form className="contents" onSubmit={(e) => { e.preventDefault(); if (remindAt) remind.mutate(remindAt, { onSuccess: () => setRemindAt("") }); }}>
          <Prop label="Remind me" htmlFor="p-remind">
            <div className="flex gap-1">
              <input id="p-remind" type="datetime-local" className={QUIET} value={remindAt} onChange={(e) => { setRemindAt(e.target.value); remind.reset(); }} />
              {remindAt && <button type="submit" className="btn h-8 flex-none px-2" disabled={remind.isPending}>Set</button>}
            </div>
          </Prop>
          {remind.isSuccess && <p className="text-[13px] text-muted">Reminder set.</p>}
        </form>
      )}
      {!done && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" className="btn h-8 justify-center" onClick={() => reschedule.mutate(addDays(today, 1))}>Tomorrow</button>
          <button type="button" className="btn h-8 justify-center" onClick={() => reschedule.mutate(addDays(today, 7))}>Next week</button>
        </div>
      )}
      </fieldset>

      <div className="my-4 h-px bg-line" />
      <h2 className="mb-2 text-xs font-medium text-muted">Source</h2>
      <p className="text-[13px] leading-5">
        {t.sourceUrl ? <a className="underline" href={t.sourceUrl} target="_blank" rel="noreferrer">{hostOf(t.sourceUrl)}</a>
          : t.sourceSelection ? null : SOURCE[t.source].label}
        <br /><span className="text-muted">Created {ago(t.createdAt)} · updated {ago(t.updatedAt)}</span>
      </p>

      <div className="my-4 h-px bg-line" />
      <h2 id="hist-h" className="mb-2 text-xs font-medium text-muted">History</h2>
            <ol className="space-y-1.5 text-[13px]">
              {t.history.slice(0, 12).map((h) => (
                <li key={h.id} className="flex gap-3">
                  <span className="num w-20 flex-none text-muted">{ago(h.at)}</span>
                  <span>{historyLine(h)}</span>
                </li>
              ))}
              {t.history.length === 0 && <li className="text-muted">Created {ago(t.createdAt)}.</li>}
            </ol>
    </aside>
    </div>
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const q = useTask(id);
  if (q.isError) {
    return (
      <div className="px-6 py-8 lg:px-10">
        <h1 className="text-[22px] font-semibold">Task not found</h1>
        <p className="mt-1 text-muted">It may have been deleted. {errorMessage(q.error)}</p>
        <Link to="/" className="btn mt-4">Back to Today</Link>
      </div>
    );
  }
  if (!q.data) return <div className="px-6 py-8 lg:px-10" aria-busy="true"><div className="h-8 w-2/3 rounded bg-active" /></div>;
  return <Body key={q.data.id} t={q.data} />;
}
