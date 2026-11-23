import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { NoteInput, Project, SuggestedTask, Suggestion } from "@tether/core";
import { QuickAdd } from "../components/QuickAdd";
import { TaskPanel } from "../components/TaskPanel";
import { SourceIcon, TaskList } from "../components/TaskRow";
import { api, errorMessage } from "../lib/api";
import { ago, dueLabel, hostOf } from "../lib/format";
import { useAction, useAiEnabled, useProjects, useSuggestions, useTask, useTasks } from "../lib/queries";

const ORIGIN = { chrome: "Chrome", claude: "Claude Code", ai: "Local AI", note: "Note" } as const;
const title = (s: Suggestion) =>
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
};

const PRI = ["None", "Low", "Medium", "High"];
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v).replace("_", " "));

/** A proposed change to an existing task: the task, then each field old → new. */
function UpdateReview({ s, onDone }: { s: Suggestion; onDone: () => void }) {
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
    <article className="mx-auto max-w-[720px] px-6 py-6" aria-label="Review change">
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

function Review({ s, projects, onDone }: { s: Suggestion; projects: Project[]; onDone: () => void }) {
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
    <article className="mx-auto max-w-[720px] px-6 py-6" aria-label="Review suggestion">
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
          <div className="grid grid-cols-3 gap-3">
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

export function InboxScreen() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "unsorted" ? "unsorted" : "suggestions";
  const sugg = useSuggestions("pending");
  const unsorted = useTasks({ statuses: ["inbox"], topLevelOnly: true });
  const projects = useProjects();
  const ps = projects.data ?? [];
  const list = sugg.data ?? [];
  const selectedId = params.get("s") ?? list[0]?.id ?? null;
  const selected = list.find((s) => s.id === selectedId) ?? list[0];
  const openTask = params.get("task");

  const tabCls = (on: boolean) => `h-9 border-b-2 px-1 ${on ? "border-ink font-medium" : "border-transparent text-muted hover:text-ink"}`;

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-[-0.01em]">Inbox</h1>
        <p className="mt-1 text-muted">Everything captured lands here first. Nothing becomes an active task until you approve it.</p>
        <div className="mt-4 flex gap-5 border-b border-line" role="tablist">
          <button role="tab" aria-selected={tab === "suggestions"} className={tabCls(tab === "suggestions")} onClick={() => setParams({})}>
            Suggestions <span className="num text-muted">{list.length}</span>
          </button>
          <button role="tab" aria-selected={tab === "unsorted"} className={tabCls(tab === "unsorted")} onClick={() => setParams({ tab: "unsorted" })}>
            Unsorted <span className="num text-muted">{unsorted.data?.length ?? 0}</span>
          </button>
        </div>
      </header>

      {tab === "suggestions" ? (
        <div className="flex min-h-0 flex-1">
          <ul className="w-[340px] flex-none overflow-y-auto border-r border-line p-2 max-md:w-full" aria-label="Pending suggestions">
            {sugg.isError && <li className="p-3 text-negative">{errorMessage(sugg.error)}</li>}
            {list.length === 0 && !sugg.isLoading && (
              <li className="m-2 rounded-[8px] border border-dashed border-line p-3 text-muted">
                No suggestions waiting. Right-click text in Chrome or ask Claude Code to save unfinished work, and it appears here.
              </li>
            )}
            {list.map((s) => (
              <li key={s.id}>
                <button onClick={() => setParams({ s: s.id })}
                  className={`block w-full rounded-[6px] px-3 py-2.5 text-left ${selected?.id === s.id ? "bg-active" : "hover:bg-raised"}`}>
                  <span className="flex items-baseline gap-2">
                    <span className="flex-1 truncate font-medium">{title(s)}</span>
                    <span className="flex-none text-xs text-muted">{ago(s.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
                    {ORIGIN[s.origin]}
                    {(s.payload as SuggestedTask).dueDate && <span>· due {dueLabel({ dueDate: (s.payload as SuggestedTask).dueDate ?? null, dueTime: null })}</span>}
                    {s.possibleDuplicateOf && <span className="pill pill-warning ml-auto">Possible duplicate</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-y-auto max-md:hidden">
            {selected ? (
              selected.kind === "task_update" ? (
                <UpdateReview key={selected.id} s={selected} onDone={() => setParams({})} />
              ) : (
                <Review key={selected.id} s={selected} projects={ps} onDone={() => setParams({})} />
              )
            ) : (
              <p className="p-8 text-muted">Select a suggestion to review it.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4 lg:px-8">
            <div className="mb-4"><QuickAdd projects={ps} status="inbox" placeholder="Jot something down — sort it later" /></div>
            <div className="rounded-[8px] border border-line bg-surface p-3">
              <TaskList tasks={unsorted.data ?? []} projects={ps} selectedId={openTask}
                onOpen={(id) => setParams({ tab: "unsorted", task: id })}
                empty="Nothing unsorted. Quick notes you add here wait until you give them a date or project." />
            </div>
          </div>
          {openTask && (
            <div className="w-[400px] flex-none border-l border-line bg-surface max-lg:fixed max-lg:inset-0 max-lg:z-20 max-lg:w-full">
              <TaskPanel key={openTask} id={openTask} projects={ps} onClose={() => setParams({ tab: "unsorted" })} onOpen={(id) => setParams({ tab: "unsorted", task: id })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
