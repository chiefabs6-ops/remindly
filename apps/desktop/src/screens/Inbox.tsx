import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, CalendarDays, Check as CheckIcon, Copy, ExternalLink, Globe } from "lucide-react";
import type { NoteInput, Project, SuggestedTask, Suggestion, Task } from "@tether/core";
import { SourceIcon } from "../components/TaskRow";
import { asInput, openExternal } from "../components/task/model";
import { Check, ClaudeMark } from "../components/ui/Bits";
import { Tabs } from "../components/ui/Controls";
import { Popover, usePopover } from "../components/ui/Popover";
import { useToast } from "../components/ui/Toast";
import { api, errorMessage } from "../lib/api";
import { useBulkSuggestions } from "../lib/bulkSuggestions";
import { toneStyle } from "../lib/colors";
import { ago, dueLabel, hostOf } from "../lib/format";
import { useAction, useAiEnabled, useInvalidateAll, useProjects, useSuggestions, useTask, useTasks } from "../lib/queries";

export const ORIGIN = { chrome: "Chrome", claude: "Claude Code", ai: "Local AI", note: "Note" } as const;

/** "From meeting: <title>" for suggestions made from a meeting, else "From <origin>". */
export function originLabel(s: Suggestion): string {
  const m = s.context?.meeting as { title?: string | null } | undefined;
  return m ? `From meeting: ${m.title || "Untitled meeting"}` : `From ${ORIGIN[s.origin]}`;
}
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
      <p className="mb-1 text-xs text-muted">{originLabel(s)} · {ago(s.createdAt)}</p>
      <h2 className="mb-4 text-xl font-semibold">Apply this change?</h2>
      {target.isError ? (
        <p className="text-muted">The task this change was for no longer exists. Dismiss it.</p>
      ) : !t ? (
        <div className="h-24 rounded-[8px] bg-active" aria-busy="true" />
      ) : (
        <>
          <p className="label">Task</p>
          <p className="mb-4 font-medium">
            <Link className="underline" to={`/task/${t.id}`}>{t.title}</Link>
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
        {originLabel(s)} · {ago(s.createdAt)}
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
          <span>Looks like a task you already have. <Link className="underline" to={`/task/${s.possibleDuplicateOf}`}>Open it</Link> before approving.</span>
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
          {p.sourceUrl && /^https?:\/\//i.test(p.sourceUrl) && (
            <a href={p.sourceUrl} onClick={(e) => { e.preventDefault(); void openExternal(p.sourceUrl!); }} onAuxClick={(e) => e.preventDefault()}
              className="inline-flex items-center gap-1 text-muted underline">
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

/* ===================== Inbox page (mockup E) ===================== */

type Tab = "captures" | "claude" | "unsorted";

const confidenceWord = (n: number) => (n >= 0.8 ? "High" : n >= 0.5 ? "Medium" : "Low");

function ProjectChip({ s, projects }: { s: SuggestedTask; projects: Project[] }) {
  const proj = s.projectId ? projects.find((x) => x.id === s.projectId) : projects.find((x) => x.name.toLowerCase() === s.projectName?.toLowerCase());
  if (proj) return <span className="chip" style={toneStyle(proj.color)}>{proj.name}</span>;
  if (s.projectName) return <span className="chip ib-chip-plain">{s.projectName}</span>;
  return <span className="chip ib-chip-plain">No project</span>;
}

function CaptureCard({ s, projects, highlight }: { s: Suggestion; projects: Project[]; highlight: boolean }) {
  const p = s.payload as SuggestedTask;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const approve = useAction(() => api.approveSuggestion(s.id));
  const dismiss = useAction(() => api.dismissSuggestion(s.id));
  const merge = useAction((taskId: string) => api.mergeSuggestion(s.id, taskId));
  const dup = useTask(s.possibleDuplicateOf);
  const host = hostOf(p.sourceUrl ?? null);
  const url = p.sourceUrl && /^https?:\/\//i.test(p.sourceUrl) ? p.sourceUrl : null;
  const due = dueLabel({ dueDate: p.dueDate ?? null, dueTime: p.dueTime ?? null });
  const dueConf = s.confidence?.dueDate;
  const err = approve.error ?? dismiss.error ?? merge.error;
  const title = p.title || (s.payload as NoteInput).title || "Untitled";

  // No Undo here: the suggestion is used once approved, so undoing would lose the capture.
  const add = () => approve.mutate(undefined, { onSuccess: () => toast(`Added “${title}” to My Tasks`) });

  return (
    <article className={`capc ${highlight ? "hl" : ""}`} data-sid={s.id} aria-label={`Capture: ${title}`}>
      <div className="hd">
        {s.origin === "chrome" ? <Globe size={13} strokeWidth={1.6} /> : <SourceIcon source={s.origin === "claude" ? "claude" : "ai"} />}
        {s.origin === "chrome" ? `Captured in Chrome${host ? ` · ${host}` : ""}` : originLabel(s)}
        <span className="r">{ago(s.createdAt)}</span>
      </div>
      {editing ? (
        <div className="capc-edit">
          <Review s={s} projects={projects} onDone={() => { setEditing(false); toast(`Handled “${title}”`); }} />
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <>
          {p.sourceSelection && <blockquote>{p.sourceSelection}</blockquote>}
          <div className="prop-task">
            <div className="lb">{s.kind === "note" ? "Suggested note" : "Suggested task"}</div>
            <div className="tn">{title}</div>
            {s.kind === "note" ? (
              <p className="ib-body">{(s.payload as NoteInput).bodyMd}</p>
            ) : (
              <div className="meta">
                <ProjectChip s={p} projects={projects} />
                <span className="pill"><CalendarDays size={12} strokeWidth={1.6} /> {due ?? "No date"}</span>
                {due && dueConf !== undefined && <small>date guessed · {confidenceWord(dueConf)} confidence</small>}
              </div>
            )}
            {s.possibleDuplicateOf && (
              <div className="dupe">
                <Copy size={13} strokeWidth={1.6} />
                <span>Looks like an open task{dup.data ? <>: “{dup.data.title}”</> : "."}</span>
                <Link to={`/task/${s.possibleDuplicateOf}`}>Compare</Link>
              </div>
            )}
          </div>
          <div className="acts">
            <button className="btn btn-sm btn-primary" disabled={approve.isPending || (s.kind === "task" && !p.title)} onClick={add}>
              <CheckIcon size={13} strokeWidth={2} />{s.kind === "note" ? "Add note" : "Add task"}
            </button>
            {s.kind === "task" && <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit first</button>}
            {s.kind === "task" && s.possibleDuplicateOf && (
              <button className="btn btn-sm" disabled={merge.isPending}
                onClick={() => merge.mutate(s.possibleDuplicateOf!, { onSuccess: () => toast("Added to the existing task") })}>
                Add to existing task
              </button>
            )}
            {url && <button className="btn btn-sm btn-ghost" onClick={() => void openExternal(url)}><ExternalLink size={13} strokeWidth={1.6} />Open page</button>}
            <button className="btn btn-sm btn-ghost ib-end" disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(undefined, { onSuccess: () => toast("Dismissed") })}>Dismiss</button>
          </div>
        </>
      )}
      {err && <p className="ib-err" role="alert">{errorMessage(err)}</p>}
    </article>
  );
}

/** A Claude note or change to an existing task, waiting for a decision. */
function ClaudeCard({ s, highlight }: { s: Suggestion; highlight: boolean }) {
  const toast = useToast();
  const approve = useAction(() => api.approveSuggestion(s.id));
  const dismiss = useAction(() => api.dismissSuggestion(s.id));
  const n = s.payload as NoteInput;
  return (
    <div className={`capc ${highlight ? "hl" : ""} ${s.kind === "task_update" ? "flush" : ""}`} data-sid={s.id}>
      {s.kind === "task_update" ? (
        <UpdateReview s={s} onDone={() => toast("Done")} />
      ) : (
        <>
          <div className="hd"><ClaudeMark />{originLabel(s)}<span className="r">{ago(s.createdAt)}</span></div>
          <div className="prop-task">
            <div className="lb">Suggested note</div>
            <div className="tn">{n.title || "Untitled note"}</div>
            {n.bodyMd && <p className="ib-body">{n.bodyMd}</p>}
          </div>
          <div className="acts">
            <button className="btn btn-sm btn-primary" disabled={approve.isPending}
              onClick={() => approve.mutate(undefined, { onSuccess: () => toast("Note added") })}>
              <CheckIcon size={13} strokeWidth={2} />Add note
            </button>
            <button className="btn btn-sm btn-ghost ib-end" disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(undefined, { onSuccess: () => toast("Dismissed") })}>Dismiss</button>
          </div>
          {(approve.isError || dismiss.isError) && <p className="ib-err" role="alert">{errorMessage(approve.error ?? dismiss.error)}</p>}
        </>
      )}
    </div>
  );
}

/** One quick-added task with no project: open it, give it a project, or finish it. */
function UnsortedRow({ t, projects }: { t: Task; projects: Project[] }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const navigate = useNavigate();
  const menu = usePopover();
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await invalidate();
      toast(msg);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const setProject = (p: Project) =>
    run(async () => {
      const d = await api.task(t.id);
      await api.updateTask(t.id, { ...asInput(d), projectId: p.id, status: "not_started" });
    }, `Moved to ${p.name}`);
  return (
    <div className="ib-row" role="listitem" data-id={t.id}>
      <Check done={false} label={`Complete "${t.title}"`} onToggle={() => void run(() => api.setStatus(t.id, "completed"), `Completed “${t.title}”`)} />
      <button type="button" className="ib-title" onClick={() => navigate(`/task/${t.id}`)}>{t.title}</button>
      <button type="button" className="btn btn-sm" aria-label={`Set project for "${t.title}"`} onClick={(e) => menu.open(e.currentTarget)}>Set project</button>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} label="Project" role="menu">
          {projects.length === 0 && <p className="ib-none">No projects yet.</p>}
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="pop-item" onClick={() => { menu.close(); void setProject(p); }}>{p.name}</button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Approve all / Dismiss all for a list of suggestions. Shown only when there is more than one. */
export function BulkBar({ list, className = "ib-bulk" }: { list: Suggestion[]; className?: string }) {
  const { running, approveAll, dismissAll } = useBulkSuggestions();
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);
  if (list.length < 2) return null;
  return (
    <div className={className} role="group" aria-label="Handle all">
      <button type="button" className="btn btn-sm" disabled={running} onClick={() => { setSure(false); void approveAll(list); }}>
        Approve all
      </button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={running}
        onClick={() => { if (sure) { setSure(false); void dismissAll(list); } else setSure(true); }}>
        {sure ? `Dismiss ${list.length}?` : "Dismiss all"}
      </button>
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="tk-empty">
      <div className="ok"><CheckIcon size={18} strokeWidth={2} /></div>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function InboxScreen() {
  const sugg = useSuggestions("pending");
  const unsorted = useTasks({ statuses: ["inbox"], topLevelOnly: true });
  const projects = useProjects();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("captures");
  const [hl, setHl] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const all = sugg.data ?? [];
  const captures = all.filter((s) => s.origin !== "claude");
  const fromClaude = all.filter((s) => s.origin === "claude" && s.kind !== "task");
  const sortedTasks = unsorted.data ?? [];
  const total = captures.length + fromClaude.length + sortedTasks.length;

  // ?s=<id>: pick the tab, scroll to the card, highlight it. Claude task suggestions live in the My Tasks tray.
  const sid = params.get("s");
  useEffect(() => {
    if (!sid || !sugg.data || handled.current === sid) return;
    const s = sugg.data.find((x) => x.id === sid);
    if (!s) return;
    handled.current = sid;
    if (s.origin === "claude" && s.kind === "task") {
      navigate("/tasks?tray=1", { replace: true });
      return;
    }
    setTab(s.origin === "claude" ? "claude" : "captures");
    setHl(sid);
  }, [sid, sugg.data, navigate]);
  useEffect(() => {
    if (!hl) return;
    document.querySelector(`[data-sid="${hl}"]`)?.scrollIntoView?.({ block: "center" });
  }, [hl, tab, sugg.data]);

  const items = [
    { key: "captures" as const, label: "Captures", count: captures.length },
    ...(fromClaude.length > 0 || tab === "claude" ? [{ key: "claude" as const, label: "From Claude", count: fromClaude.length }] : []),
    { key: "unsorted" as const, label: "Unsorted", count: sortedTasks.length },
  ];
  const error = sugg.error ?? unsorted.error;

  return (
    <div className="pg ib">
      <header className="ib-h">
        <h1>Inbox</h1>
        <div className="summary">
          {sugg.isSuccess && unsorted.isSuccess
            ? total > 0 ? `${total} ${total === 1 ? "item needs" : "items need"} a decision. Nothing here is a task yet.` : "All clear."
            : " "}
        </div>
      </header>
      <Tabs label="Inbox" items={items} value={tab} onChange={setTab} />
      {error ? (
        <div className="tk-empty" role="alert">
          <h2>Could not load the inbox</h2>
          <p>{errorMessage(error)}</p>
          <button className="btn" onClick={() => { void sugg.refetch(); void unsorted.refetch(); }}>Retry</button>
        </div>
      ) : !sugg.data || !unsorted.data ? (
        <div className="ib-skel skel" aria-busy="true" />
      ) : tab === "captures" ? (
        captures.length ? <>
          <BulkBar list={captures} />
          {captures.map((s) => s.kind === "task_update"
            ? <ClaudeCard key={s.id} s={s} highlight={hl === s.id} />
            : <CaptureCard key={s.id} s={s} projects={projects.data ?? []} highlight={hl === s.id} />)}
        </>
          : <Empty title="Nothing to sort" text="Right-click any text in Chrome and choose “Create Task”." />
      ) : tab === "claude" ? (
        fromClaude.length ? <>
          <BulkBar list={fromClaude} />
          {fromClaude.map((s) => <ClaudeCard key={s.id} s={s} highlight={hl === s.id} />)}
        </>
          : <Empty title="Nothing from Claude" text="Notes and changes Claude proposes show up here." />
      ) : sortedTasks.length ? (
        <div role="list" className="ib-list">
          {sortedTasks.map((t) => <UnsortedRow key={t.id} t={t} projects={projects.data ?? []} />)}
        </div>
      ) : (
        <Empty title="Nothing to sort" text="Things you jot down to sort later land here." />
      )}
      <div className="note-line">
        <ClaudeMark />
        <span>Claude’s new-task suggestions wait at the top of <Link to="/tasks?tray=1">My Tasks</Link>.</span>
      </div>
    </div>
  );
}
