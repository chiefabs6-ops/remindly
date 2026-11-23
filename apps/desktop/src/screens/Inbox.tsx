import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { NoteInput, Project, SuggestedTask, Suggestion } from "@tether/core";
import { SourceIcon } from "../components/TaskRow";
import { api, errorMessage } from "../lib/api";
import { ago, hostOf } from "../lib/format";
import { useAction, useAiEnabled, useTask } from "../lib/queries";

export const ORIGIN = { chrome: "Chrome", claude: "Claude Code", ai: "Local AI", note: "Note" } as const;
export const suggestionTitle = (s: Suggestion) =>
  s.kind === "task_update"
    ? "Change to an existing task"
    : (s.payload as SuggestedTask).title || (s.payload as NoteInput).title || "Untitled note";

type UpdatePayload = {
  title?: string;
  status?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: number;
  appendNote?: string;
  addSubtasks?: string[];
};

const PRI = ["None", "Low", "Medium", "High"];
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v).replace("_", " "));

/** A proposed change to an existing task: the task, then each field old → new. */
export function UpdateReview({ s, onDone }: { s: Suggestion; onDone: () => void }) {
  const target = useTask(s.targetTaskId);
  const p = s.payload as UpdatePayload;
  const approve = useAction(() => api.approveSuggestion(s.id));
  const dismiss = useAction(() => api.dismissSuggestion(s.id));
  const t = target.data;
  const rows: [string, string, string][] = [];
  if (t) {
    if (p.title !== undefined) rows.push(["Title", t.title, p.title]);
    if (p.status !== undefined) rows.push(["Status", show(t.status), show(p.status)]);
    if (p.dueDate !== undefined) rows.push(["Due date", show(t.dueDate), p.dueDate === null ? "cleared" : show(p.dueDate)]);
    if (p.dueTime !== undefined) rows.push(["Due time", show(t.dueTime), p.dueTime === null ? "cleared" : show(p.dueTime)]);
    if (p.priority !== undefined) rows.push(["Priority", PRI[t.priority], PRI[p.priority] ?? String(p.priority)]);
  }
  return (
    <article className="px-5 py-4" aria-label="Review change">
      <p className="mb-1 text-xs text-muted">From {ORIGIN[s.origin]} · {ago(s.createdAt)}</p>
      <h2 className="mb-4 text-xl font-semibold">Apply this change?</h2>
      {target.isError ? (
        <p className="text-muted">The task this change was for no longer exists. Dismiss it.</p>
      ) : !t ? (
        <div className="h-24 rounded-[8px] bg-active" aria-busy="true" />
      ) : (
        <>
          <p className="label">Task</p>
          <p className="mb-4 font-medium">
            <Link className="underline" to={`/tasks?task=${t.id}`}>{t.title}</Link>
          </p>
          {rows.length > 0 && (
            <table className="mb-4 w-full text-left">
              <thead>
                <tr className="text-xs text-muted"><th className="py-1 font-normal">Field</th><th className="font-normal">Now</th><th className="font-normal">After approval</th></tr>
              </thead>
              <tbody>
                {rows.map(([f, a, b]) => (
                  <tr key={f} className="border-t border-rule"><td className="py-2 text-muted">{f}</td><td>{a}</td><td className="font-medium">{b}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {p.addSubtasks && p.addSubtasks.length > 0 && (
            <div className="mb-4 rounded-[8px] bg-raised p-3">
              <p className="label">Subtasks to add</p>
              <ul className="list-disc pl-5">{p.addSubtasks.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {p.appendNote && (
            <div className="rounded-[8px] bg-raised p-3">
              <p className="label">Note added to the task</p>
              <p className="whitespace-pre-wrap">{p.appendNote}</p>
            </div>
          )}
        </>
      )}
      <div className="mt-6 flex items-center gap-2">
        <button className="btn btn-primary" disabled={!t || approve.isPending} onClick={() => approve.mutate(undefined, { onSuccess: onDone })}>
          Apply change
        </button>
        <button className="btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate(undefined, { onSuccess: onDone })}>Dismiss</button>
        {(approve.isError || dismiss.isError) && <span className="text-negative">{errorMessage(approve.error ?? dismiss.error)}</span>}
      </div>
    </article>
  );
}

/** Free-form context from Claude Code (completed / remaining / why / resume hint). */
function Context({ ctx }: { ctx: Record<string, unknown> }) {
  const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  return (
    <dl className="space-y-3">
      {Object.entries(ctx).map(([k, v]) =>
        Array.isArray(v) ? (
          <div key={k}>
            <dt className="label">{label(k)}</dt>
            <dd><ul className="list-disc space-y-0.5 pl-5">{v.map((x, i) => <li key={i}>{String(x)}</li>)}</ul></dd>
          </div>
        ) : (
          <div key={k}>
            <dt className="label">{label(k)}</dt>
            <dd className="break-words">{String(v)}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

export function Review({ s, projects, onDone }: { s: Suggestion; projects: Project[]; onDone: () => void }) {
  const p = s.payload as SuggestedTask;
  const initialProject = p.projectId ?? projects.find((x) => x.name.toLowerCase() === p.projectName?.toLowerCase())?.id ?? "";
  const [form, setForm] = useState({ title: p.title ?? "", description: p.description ?? "", dueDate: p.dueDate ?? "", projectId: initialProject, priority: p.priority ?? 0 });
  useEffect(() => setForm({ title: p.title ?? "", description: p.description ?? "", dueDate: p.dueDate ?? "", projectId: initialProject, priority: p.priority ?? 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.id]);
  const approve = useAction(() =>
    api.approveSuggestion(s.id, s.kind === "task"
      ? { ...p, ...form, projectId: form.projectId || null, projectName: null, dueDate: form.dueDate || null, dueTime: form.dueDate ? (p.dueTime ?? null) : null, priority: Number(form.priority) }
      : undefined),
  );
  const dismiss = useAction(() => api.dismissSuggestion(s.id));
  const aiOn = useAiEnabled();
  const ai = useAction(() => api.aiExtract(p.sourceSelection ?? p.title ?? "", p.sourceTitle ?? null));
  const applyAi = () =>
    ai.mutate(undefined, {
      onSuccess: ({ value: v }) =>
        setForm((f) => ({
          ...f,
          title: v.title || f.title,
          description: v.description ?? f.description,
          dueDate: v.dueDate ?? f.dueDate,
          priority: (v.priority ?? f.priority) as typeof f.priority,
          projectId: projects.find((x) => x.name === v.projectName)?.id ?? f.projectId,
        })),
    });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const deadlineGuess = s.confidence?.dueDate !== undefined && s.confidence.dueDate < 0.8;

  return (
    <article className="px-5 py-4" aria-label="Review suggestion">
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
        <SourceIcon source={s.origin === "chrome" ? "chrome" : s.origin === "claude" ? "claude" : "ai"} />
        From {ORIGIN[s.origin]} · {ago(s.createdAt)}
      </p>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-xl font-semibold">{s.kind === "note" ? "Save this note?" : "Add this task?"}</h2>
        {aiOn && s.kind === "task" && (
          <button className="btn ml-auto" disabled={ai.isPending} onClick={applyAi} title="Fills the form; nothing is saved until you approve">
            {ai.isPending ? "Thinking…" : "Suggest with AI"}
          </button>
        )}
      </div>
      {ai.isError && <p className="mb-3 text-negative">{errorMessage(ai.error)}</p>}
      {ai.isSuccess && <p className="mb-3 rounded-[8px] bg-[var(--pill-today-bg)] px-3 py-2 text-[var(--pill-today-ink)]">The fields below were filled by local AI. Check them before approving.</p>}

      {s.possibleDuplicateOf && (
        <p className="mb-4 flex items-start gap-2 rounded-[8px] bg-[var(--pill-warning-bg)] px-3 py-2 text-[var(--pill-warning-ink)]">
          <AlertTriangle size={15} className="mt-0.5 flex-none" />
          <span>Looks like a task you already have. <Link className="underline" to={`/tasks?task=${s.possibleDuplicateOf}`}>Open it</Link> before approving.</span>
        </p>
      )}

      {s.kind === "task" ? (
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="s-title">Title</label>
            <input id="s-title" className="field text-base font-medium" value={form.title} onChange={set("title")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="s-due">Due date {deadlineGuess && <span className="pill pill-warning ml-1">Guessed</span>}</label>
              <input id="s-due" type="date" className="field" value={form.dueDate} onChange={set("dueDate")} />
            </div>
            <div>
              <label className="label" htmlFor="s-project">Project</label>
              <select id="s-project" className="field" value={form.projectId} onChange={set("projectId")}>
                <option value="">No project</option>
                {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="s-pri">Priority</label>
              <select id="s-pri" className="field" value={form.priority} onChange={set("priority")}>
                <option value={0}>None</option><option value={1}>Low</option><option value={2}>Medium</option><option value={3}>High</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="s-desc">Description</label>
            <textarea id="s-desc" className="field" rows={3} value={form.description} onChange={set("description")} />
          </div>
        </div>
      ) : (
        <div className="rounded-[8px] bg-raised p-3 whitespace-pre-wrap">{(s.payload as NoteInput).bodyMd}</div>
      )}

      {(p.sourceSelection || p.sourceUrl) && (
        <div className="mt-4 rounded-[8px] bg-raised p-3">
          <p className="label">Selected text</p>
          {p.sourceSelection && <blockquote className="mb-2">“{p.sourceSelection}”</blockquote>}
          {p.sourceUrl && (
            <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted underline">
              {p.sourceTitle || hostOf(p.sourceUrl)} <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
      {s.context && Object.keys(s.context).length > 0 && (
        <div className="mt-4 rounded-[8px] bg-raised p-3"><Context ctx={s.context} /></div>
      )}

      <div className="mt-6 flex items-center gap-2">
        <button className="btn btn-primary" disabled={approve.isPending || (s.kind === "task" && !form.title.trim())}
          onClick={() => approve.mutate(undefined, { onSuccess: onDone })}>
          {s.kind === "note" ? "Save note" : "Approve task"}
        </button>
        <button className="btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate(undefined, { onSuccess: onDone })}>Dismiss</button>
        {(approve.isError || dismiss.isError) && <span className="text-negative">{errorMessage(approve.error ?? dismiss.error)}</span>}
      </div>
    </article>
  );
}
