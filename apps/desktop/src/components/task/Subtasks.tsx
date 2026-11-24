import { useState } from "react";
import { Link } from "react-router";
import { Plus, X } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { keys, queryClient, useAction, useAiEnabled } from "../../lib/queries";
import { Check, ClaudeMark } from "../ui/Bits";
import { useToast } from "../ui/Toast";

export function Subtasks({ t }: { t: TaskDetail }) {
  const toast = useToast();
  const aiOn = useAiEnabled();
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<{ text: string; on: boolean }[] | null>(null);
  const add = useAction((x: string) => api.createTask({ title: x }, t.id));
  const toggle = useAction((s: { id: string; done: boolean }) => api.setStatus(s.id, s.done ? "not_started" : "completed", !s.done));
  const remove = useAction((s: { id: string; title: string }) =>
    api.deleteTask(s.id).then(() => toast(`Removed “${s.title}”`, () => api.restoreTask(s.id).then(() => queryClient.invalidateQueries({ queryKey: keys.all })))));
  const breakdown = useAction(() => api.aiBreakdown(t.id));
  const addSteps = useAction(async (titles: string[]) => {
    for (const x of titles) {
      await api.createTask({ title: x }, t.id);
      // Drop each step once added, so a retry after a failure never duplicates.
      setSteps((cur) => cur?.filter((s) => s.text !== x) ?? null);
    }
  });
  const total = t.subtasks.length;
  const done = t.subtasks.filter((s) => s.status === "completed").length;
  const err = add.error ?? toggle.error ?? remove.error ?? addSteps.error;

  return (
    <section className="sec" aria-labelledby={`sub-h-${t.id}`}>
      <div className="sec-h">
        <span id={`sub-h-${t.id}`}>Subtasks</span>
        {total > 0 && (
          <>
            <span className="c num">{done}/{total}</span>
            <span className="sprog" role="progressbar" aria-label="Subtasks done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><i style={{ width: `${(done / total) * 100}%` }} /></span>
          </>
        )}
        {aiOn && !steps && (
          <button type="button" className="a" disabled={breakdown.isPending} title="Break this task into steps with local AI"
            onClick={() => breakdown.mutate(undefined, { onSuccess: (r) => setSteps(r.value.map((text) => ({ text, on: true }))) })}>
            <ClaudeMark size={12} />{breakdown.isPending ? "Thinking…" : "Break down"}
          </button>
        )}
      </div>
      {breakdown.isError && <p className="td-err">{errorMessage(breakdown.error)}</p>}
      {steps && (
        <fieldset className="steps">
          <legend className="label">Suggested steps — pick the ones to add</legend>
          {steps.map((st, i) => (
            <label key={i} className="flex items-center gap-2 py-1">
              <input type="checkbox" checked={st.on} onChange={() => setSteps(steps.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
              {st.text}
            </label>
          ))}
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn btn-sm btn-primary" disabled={addSteps.isPending || !steps.some((x) => x.on)}
              onClick={() => addSteps.mutate(steps.filter((x) => x.on).map((x) => x.text), { onSuccess: () => setSteps(null) })}>
              Add {steps.filter((x) => x.on).length} subtasks
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSteps(null)}>Cancel</button>
          </div>
        </fieldset>
      )}
      <ul className="stl">
        {t.subtasks.map((s) => {
          const d = s.status === "completed";
          return (
            <li key={s.id} className={`st ${d ? "done" : ""}`}>
              <Check done={d} label={`${d ? "Reopen" : "Complete"} subtask ${s.title}`} size={16} onToggle={() => toggle.mutate({ id: s.id, done: d })} />
              <Link to={`/task/${s.id}`} className="st-t">{s.title}</Link>
              <button type="button" className="rm" aria-label={`Remove subtask ${s.title}`} onClick={() => remove.mutate({ id: s.id, title: s.title })}><X size={13} /></button>
            </li>
          );
        })}
      </ul>
      <form className="addst" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(title.trim(), { onSuccess: () => setTitle("") }); }}>
        <Plus size={14} aria-hidden />
        <label htmlFor={`new-sub-${t.id}`} className="sr-only">Add a subtask</label>
        <input id={`new-sub-${t.id}`} placeholder="Add a subtask" value={title} onChange={(e) => setTitle(e.target.value)} />
      </form>
      {err && <p className="td-err">{errorMessage(err)}</p>}
    </section>
  );
}
