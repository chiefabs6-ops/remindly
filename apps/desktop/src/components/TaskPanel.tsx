import { useEffect, useState } from "react";
import { Copy, ExternalLink, Trash2, X } from "lucide-react";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_STATUSES,
  addDays,
  type Priority,
  type Project,
  type TaskDetail,
  type TaskInput,
  type TaskStatus,
} from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { ago, hostOf, todayIso } from "../lib/format";
import { useAction, useAiEnabled, useTask } from "../lib/queries";
import { TaskList } from "./TaskRow";

function toForm(t: TaskDetail): Required<TaskInput> & { tagText: string } {
  return {
    title: t.title,
    description: t.description ?? "",
    notes: t.notes ?? "",
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate ?? "",
    dueTime: t.dueTime ?? "",
    scheduledDate: t.scheduledDate ?? "",
    projectId: t.projectId ?? "",
    tags: t.tags,
    tagText: t.tags.join(", "),
  };
}

const SOURCE_LABEL = { manual: "Added by you", chrome: "Captured in Chrome", claude: "Suggested by Claude Code", note: "Made from a note", ai: "Suggested by local AI" };

/** Right-hand detail pane for one task: edit, subtasks, reschedule, duplicate, delete. */
export function TaskPanel({ id, projects, onClose, onOpen }: {
  id: string;
  projects: Project[];
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const q = useTask(id);
  const [form, setForm] = useState<ReturnType<typeof toForm> | null>(null);
  const [subtask, setSubtask] = useState("");

  useEffect(() => {
    if (q.data) setForm(toForm(q.data));
  }, [q.data]);

  const save = useAction((f: NonNullable<typeof form>) =>
    api.updateTask(id, {
      ...f,
      status: f.status as TaskStatus,
      priority: Number(f.priority) as Priority,
      dueTime: f.dueDate ? f.dueTime : "",
      tags: f.tagText.split(",").map((s) => s.trim()).filter(Boolean),
    }),
  );
  const reschedule = useAction((d: string | null) => api.reschedule(id, d, null));
  const [remindAt, setRemindAt] = useState("");
  const remind = useAction((local: string) => api.remindAt(id, new Date(local).toISOString()));
  const duplicate = useAction(() => api.duplicate(id));
  const remove = useAction(() => api.deleteTask(id));
  const addSub = useAction((title: string) => api.createTask({ title }, id));
  const aiOn = useAiEnabled();
  const [steps, setSteps] = useState<{ text: string; on: boolean }[] | null>(null);
  const breakdown = useAction(() => api.aiBreakdown(id));
  const addSteps = useAction(async (titles: string[]) => {
    for (const title of titles) {
      await api.createTask({ title }, id);
      // Drop each step once added, so a retry after a failure never duplicates.
      setSteps((cur) => cur?.filter((x) => x.text !== title) ?? null);
    }
  });

  if (q.isError) {
    return (
      <aside className="p-5">
        <p className="text-muted">This task no longer exists. {errorMessage(q.error)}</p>
        <button className="btn mt-3" onClick={onClose}>Close</button>
      </aside>
    );
  }
  if (!q.data || !form) {
    return <aside className="p-5" aria-busy="true"><div className="h-6 w-2/3 rounded bg-active" /></aside>;
  }
  const t = q.data;
  const dirty = JSON.stringify(toForm(t)) !== JSON.stringify(form);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const today = todayIso();

  return (
    <aside className="flex h-full flex-col" aria-label="Task details">
      <div className="flex items-center gap-2 border-b border-rule px-5 py-3">
        <span className="text-xs text-muted">{SOURCE_LABEL[t.source]} · {ago(t.createdAt)}</span>
        <div className="ml-auto flex gap-1">
          <button className="btn btn-ghost px-2" aria-label="Duplicate task" title="Duplicate"
            onClick={() => duplicate.mutate(undefined, { onSuccess: (c) => onOpen(c.id) })}>
            <Copy size={15} />
          </button>
          <button className="btn btn-ghost btn-danger px-2" aria-label="Delete task" title="Delete"
            onClick={() => {
              if (confirm(`Delete "${t.title}"${t.subtaskCount ? ` and its ${t.subtaskCount} subtasks` : ""}?`))
                remove.mutate(undefined, { onSuccess: onClose });
            }}>
            <Trash2 size={15} />
          </button>
          <button className="btn btn-ghost px-2" aria-label="Close details" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <form
        className="flex-1 space-y-4 overflow-y-auto px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <div>
          <label className="label" htmlFor="t-title">Title</label>
          <input id="t-title" className="field text-base font-medium" value={form.title} onChange={set("title")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="t-status">Status</label>
            <select id="t-status" className="field" value={form.status ?? ""} onChange={set("status")}>
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-priority">Priority</label>
            <select id="t-priority" className="field" value={form.priority} onChange={set("priority")}>
              {[0, 1, 2, 3].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p as Priority]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-due">Due date</label>
            <input id="t-due" type="date" className="field" value={form.dueDate ?? ""} onChange={set("dueDate")} />
          </div>
          <div>
            <label className="label" htmlFor="t-time">Due time</label>
            <input id="t-time" type="time" className="field" value={form.dueTime ?? ""} onChange={set("dueTime")}
              disabled={!form.dueDate} title={form.dueDate ? undefined : "Set a due date first"} />
          </div>
          <div>
            <label className="label" htmlFor="t-project">Project</label>
            <select id="t-project" className="field" value={form.projectId ?? ""} onChange={set("projectId")}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-sched">Do on</label>
            <input id="t-sched" type="date" className="field" value={form.scheduledDate ?? ""} onChange={set("scheduledDate")} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Reschedule">
          <button type="button" className="btn" onClick={() => reschedule.mutate(today)}>Today</button>
          <button type="button" className="btn" onClick={() => reschedule.mutate(addDays(today, 1))}>Tomorrow</button>
          <button type="button" className="btn" onClick={() => reschedule.mutate(addDays(today, 7))}>Next week</button>
          {t.dueDate && <button type="button" className="btn btn-ghost" onClick={() => reschedule.mutate(null)}>No date</button>}
        </div>

        <div>
          <label className="label" htmlFor="t-remind">Remind me at</label>
          <div className="flex gap-2">
            <input id="t-remind" type="datetime-local" className="field" value={remindAt} onChange={(e) => { setRemindAt(e.target.value); remind.reset(); }} />
            <button type="button" className="btn" disabled={!remindAt || remind.isPending}
              onClick={() => remind.mutate(remindAt, { onSuccess: () => setRemindAt("") })}>Set</button>
          </div>
          {remind.isSuccess && <p className="mt-1 text-xs text-muted">Reminder set.</p>}
          {remind.isError && <p className="mt-1 text-negative">{errorMessage(remind.error)}</p>}
        </div>

        <div>
          <label className="label" htmlFor="t-tags">Tags</label>
          <input id="t-tags" className="field" value={form.tagText} onChange={set("tagText")} placeholder="writing, phone" />
        </div>
        <div>
          <label className="label" htmlFor="t-desc">Description</label>
          <textarea id="t-desc" className="field" rows={3} value={form.description ?? ""} onChange={set("description")} />
        </div>
        <div>
          <label className="label" htmlFor="t-notes">Notes and context</label>
          <textarea id="t-notes" className="field" rows={5} value={form.notes ?? ""} onChange={set("notes")} />
        </div>

        {(t.sourceUrl || t.sourceSelection) && (
          <div className="rounded-[8px] bg-raised p-3">
            <p className="label">Captured from</p>
            {t.sourceSelection && <blockquote className="mb-2 text-muted">“{t.sourceSelection}”</blockquote>}
            {t.sourceUrl && (
              <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                {t.sourceTitle || hostOf(t.sourceUrl)} <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          {!dirty && save.isSuccess && <span className="text-xs text-muted">Saved</span>}
          {save.isError && <span className="text-negative">{errorMessage(save.error)}</span>}
        </div>
      </form>

      <section className="border-t border-rule px-5 py-4" aria-labelledby="subtasks-h">
        <h2 id="subtasks-h" className="mb-2 font-medium">
          Subtasks <span className="num text-muted">{t.subtaskDone}/{t.subtaskCount}</span>
        </h2>
        <TaskList tasks={t.subtasks} projects={projects} onOpen={onOpen} hideProject empty="No subtasks. Break this into steps below." />
        {aiOn && !steps && (
          <button type="button" className="btn mt-2" disabled={breakdown.isPending}
            onClick={() => breakdown.mutate(undefined, { onSuccess: (r) => setSteps(r.value.map((text) => ({ text, on: true }))) })}>
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
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (subtask.trim()) addSub.mutate(subtask.trim(), { onSuccess: () => setSubtask("") });
          }}
        >
          <label htmlFor="t-sub" className="sr-only">Add a subtask</label>
          <input id="t-sub" className="field" placeholder="Add a subtask and press Enter" value={subtask}
            onChange={(e) => setSubtask(e.target.value)} />
        </form>
      </section>
    </aside>
  );
}
