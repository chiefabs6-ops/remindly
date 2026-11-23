import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Bot, Check, Copy, ExternalLink, Globe, Pencil, RotateCcw, StickyNote, Trash2 } from "lucide-react";
import { PRIORITY_LABEL, STATUS_LABEL, addDays, type HistoryEntry, type Priority, type TaskDetail } from "@tether/core";
import { TaskPanel } from "../components/TaskPanel";
import { TaskList } from "../components/TaskRow";
import { api, errorMessage } from "../lib/api";
import { toneStyle } from "../lib/colors";
import { ago, dueLabel, dueTone, hostOf, longDate, todayIso } from "../lib/format";
import { useAction, useAiEnabled, useProjects, useTask } from "../lib/queries";

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
  const tomorrow = useAction(() => api.reschedule(t.id, addDays(today, 1), t.dueTime));
  const duplicate = useAction(() => api.duplicate(t.id));
  const remove = useAction(() => api.deleteTask(t.id));
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
  const err = toggle.error ?? tomorrow.error ?? duplicate.error ?? remove.error ?? addSub.error;
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate("/"));

  if (editing) {
    return (
      <div className="mx-auto max-w-[760px] py-4">
        <TaskPanel id={t.id} projects={ps} onClose={() => setEditing(false)} onOpen={(id) => navigate(`/task/${id}`)} />
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-[760px] px-6 pt-5 pb-12" aria-labelledby="task-title">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost -ml-2 h-8" onClick={back}><ArrowLeft size={15} /> Back</button>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn h-8" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
          {!done && <button className="btn h-8" disabled={tomorrow.isPending} onClick={() => tomorrow.mutate(undefined)}>Tomorrow</button>}
          <button className="btn btn-primary h-8" disabled={toggle.isPending} onClick={() => toggle.mutate(undefined)}>
            {done ? <><RotateCcw size={14} /> Reopen</> : <><Check size={14} /> Done</>}
          </button>
          <button className="btn btn-ghost h-8 px-2" aria-label="Duplicate task" title="Duplicate"
            onClick={() => duplicate.mutate(undefined, { onSuccess: (c) => navigate(`/task/${c.id}`) })}><Copy size={15} /></button>
          <button className="btn btn-ghost btn-danger h-8 px-2" aria-label="Delete task" title="Delete"
            onClick={() => confirm(`Delete "${t.title}"${t.subtaskCount ? ` and its ${t.subtaskCount} subtasks` : ""}?`) && remove.mutate(undefined, { onSuccess: back })}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {t.parentId && (
        <p className="mb-2 text-[13px] text-muted">Subtask of <Link className="underline" to={`/task/${t.parentId}`}>the parent task</Link></p>
      )}
      <h1 id="task-title" className={`text-2xl leading-8 font-semibold tracking-[-0.01em] ${done ? "text-muted line-through" : ""}`}>{t.title}</h1>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
        <span className={`pill ${done ? "" : t.status === "in_progress" ? "pill-today" : ""}`}>{STATUS_LABEL[t.status]}</span>
        {t.dueDate ? (
          <span className={`pill ${tone === "overdue" ? "pill-negative" : tone === "today" ? "pill-today" : ""}`}>
            Due {dueLabel(t)}{tone === "plain" ? ` · ${longDate(t.dueDate)}` : ""}
          </span>
        ) : <span className="text-muted">No due date</span>}
        {t.scheduledDate && <span className="pill">Do on {dueLabel({ dueDate: t.scheduledDate, dueTime: null })}</span>}
        {project && <span className="chip" style={toneStyle(project.color)}>{project.name}</span>}
        {t.priority > 0 && <span className="pill">{PRIORITY_LABEL[t.priority as Priority]} priority</span>}
        {t.tags.map((g) => <span key={g} className="text-muted">#{g}</span>)}
      </div>

      {t.description && <p className="mt-5 text-[15px] leading-6">{t.description}</p>}

      {(t.source !== "manual" || t.sourceSelection || t.sourceUrl) && (
        <section className="mt-6 rounded-[8px] bg-raised p-4" aria-label="Where it came from">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] text-muted">
            {SOURCE[t.source].icon}{SOURCE[t.source].label} · {ago(t.createdAt)}
          </p>
          {t.sourceSelection && <blockquote className="mb-2 border-l-2 border-today pl-3 text-[15px] leading-6">“{t.sourceSelection}”</blockquote>}
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

      <section className="mt-8" aria-labelledby="hist-h">
        <h2 id="hist-h" className="mb-2 font-semibold">History</h2>
        <ol className="space-y-1.5 text-[13px]">
          {t.history.slice(0, 12).map((h) => (
            <li key={h.id} className="flex gap-3">
              <span className="num w-28 flex-none text-muted">{ago(h.at)}</span>
              <span>{historyLine(h)}</span>
            </li>
          ))}
          {t.history.length === 0 && <li className="text-muted">Created {ago(t.createdAt)}.</li>}
        </ol>
      </section>

      {err && <p className="mt-4 text-negative">{errorMessage(err)}</p>}
    </article>
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const q = useTask(id);
  if (q.isError) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-8">
        <h1 className="text-[22px] font-semibold">Task not found</h1>
        <p className="mt-1 text-muted">It may have been deleted. {errorMessage(q.error)}</p>
        <Link to="/" className="btn mt-4">Back to Today</Link>
      </div>
    );
  }
  if (!q.data) return <div className="mx-auto max-w-[760px] px-6 py-8" aria-busy="true"><div className="h-8 w-2/3 rounded bg-active" /></div>;
  return <Body key={q.data.id} t={q.data} />;
}
