import { useState } from "react";
import { addDays, type Task } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { dueLabel, dueTone, longDate, todayIso } from "../lib/format";
import { useAction, useDashboard } from "../lib/queries";

/** End-of-day review: decide what happens to each task still open for today. */
function ReviewRow({ t }: { t: Task }) {
  const today = todayIso();
  const [date, setDate] = useState("");
  const move = useAction(async (d: string) => {
    if (t.dueDate) {
      await api.reschedule(t.id, d, t.dueTime);
      // A "do on" date of today or earlier would keep it on today's list.
      if (t.scheduledDate && t.scheduledDate <= today) return api.schedule(t.id, null);
      return t;
    }
    return api.schedule(t.id, d);
  });
  const backlog = useAction(async () => {
    await api.reschedule(t.id, null, null);
    return api.schedule(t.id, null);
  });
  const done = useAction(() => api.setStatus(t.id, "completed", false));
  const busy = move.isPending || backlog.isPending || done.isPending;
  const tone = dueTone(t);
  const err = move.error ?? backlog.error ?? done.error;

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-rule px-2 py-3 last:border-0">
      <div className="min-w-[220px] flex-1">
        <p className="font-medium">{t.title}</p>
        <p className={`text-xs ${tone === "overdue" ? "text-negative" : "text-muted"}`}>
          {dueLabel(t) ?? (t.scheduledDate ? "Planned for today" : "No date")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`What to do with ${t.title}`}>
        <button className="btn h-8" disabled={busy} onClick={() => move.mutate(addDays(today, 1))}>Tomorrow</button>
        <label htmlFor={`d-${t.id}`} className="sr-only">Pick a date</label>
        <input id={`d-${t.id}`} type="date" className="field h-8 w-[150px]" value={date} min={today}
          onChange={(e) => setDate(e.target.value)} />
        <button className="btn h-8" disabled={busy || !date} onClick={() => move.mutate(date)}>Move</button>
        <button className="btn h-8" disabled={busy} onClick={() => backlog.mutate(undefined)} title="Remove the dates; keep the task">Backlog</button>
        <button className="btn btn-primary h-8" disabled={busy} onClick={() => done.mutate(undefined)}>Done</button>
      </div>
      {err && <p className="w-full text-negative">{errorMessage(err)}</p>}
    </li>
  );
}

export function ReviewScreen() {
  const dash = useDashboard();
  const d = dash.data;
  const open = d ? [...d.overdue, ...d.dueToday, ...d.carriedOver] : [];
  return (
    <div className="px-6 py-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">End of day review</h1>
      <p className="mt-1 text-muted">
        {d ? longDate(d.today) : " "} · <span className="num">{open.length}</span> still open · <span className="num">{d?.completedToday.length ?? 0}</span> done today
      </p>
      <p className="mt-1 text-muted">Move each one to tomorrow, another day or the backlog — or mark it done. Anything you skip stays as it is.</p>
      <ul className="mt-5 rounded-[8px] border border-line bg-surface px-2" aria-label="Open tasks for today">
        {dash.isError && <li className="p-3 text-negative">{errorMessage(dash.error)}</li>}
        {d && open.length === 0 && <li className="p-3 text-muted">Nothing left open for today.</li>}
        {open.map((t) => <ReviewRow key={t.id} t={t} />)}
      </ul>
    </div>
  );
}
