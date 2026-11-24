// Per-task reminder (mockup E): when to be reminded, plus "keep reminding me until it's done".
// lead: null = the app default (Settings → Reminders), minutes before the due time, or -1 = the morning of.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Repeat } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { Toggle } from "../ui/Controls";
import type { TaskEdit } from "./useTaskEdit";

type Lead = number | null;
const PRESETS: { label: string; lead: Lead; needsTime: boolean }[] = [
  { label: "At due time", lead: 0, needsTime: true },
  { label: "15 min before", lead: 15, needsTime: true },
  { label: "1 hour before", lead: 60, needsTime: true },
  { label: "Morning of", lead: -1, needsTime: false },
];

const fmt = (d: Date) => d.toLocaleString("en-IE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtTime = (hm: string) => hm;

function minutesLabel(m: number) {
  if (m === 0) return "At the due time";
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"} before`;
  return `${m} min before`;
}

/** The moment the task will remind, worked out like the scheduler does. */
function nextMoment(t: TaskDetail, lead: Lead, defaultMin: number, workStart: string): Date | null {
  if (!t.dueDate) return null;
  const [y, m, d] = t.dueDate.split("-").map(Number);
  const [wh, wm] = workStart.split(":").map(Number);
  if (lead === -1) return new Date(y, m - 1, d, wh || 9, wm || 0);
  if (!t.dueTime) return null;
  const [hh, mm] = t.dueTime.split(":").map(Number);
  const mins = lead ?? defaultMin;
  return new Date(y, m - 1, d, hh, mm - Math.max(0, mins));
}

export function ReminderCard({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const settings = useQuery({ queryKey: ["tether", "reminder-settings"], queryFn: api.reminders });
  const [custom, setCustom] = useState(false);
  const [local, setLocal] = useState("");
  if (ed.done) return null;

  const defaultMin = settings.data?.dueSoonMinutes ?? 15;
  const workStart = settings.data?.workStart ?? "09:00";
  const lead = t.reminderLead;
  const repeat = t.reminderRepeat;
  const save = (next: { lead: Lead; repeat: boolean }) => ed.setReminder.mutate(next);

  const oneOff = t.nextReminder ? new Date(t.nextReminder) : null;
  const at = nextMoment(t, lead, defaultMin, workStart);
  const title = oneOff ? fmt(oneOff) : at ? fmt(at) : t.dueDate ? "When it’s due" : "No due date";
  const sub = oneOff
    ? "One-off reminder"
    : lead === null
      ? `Default · ${t.dueTime ? minutesLabel(defaultMin).toLowerCase() : "set a due time for an early reminder"}`
      : lead === -1
        ? `Morning of · ${fmtTime(workStart)}`
        : minutesLabel(lead);

  return (
    <section className="sec" aria-label="Reminder">
      <div className="sec-h"><Bell size={14} strokeWidth={1.6} />Reminder</div>
      <div className="remcard">
        <div className="remline">
          {repeat ? <Repeat size={15} aria-hidden /> : <Bell size={15} aria-hidden />}
          <div>
            <div className="when">{title}</div>
            <div className="sub">{sub}</div>
          </div>
          {lead !== null && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}
              onClick={() => save({ lead: null, repeat })} title="Use the default from Settings">Default</button>
          )}
        </div>
        <div className="presets" role="group" aria-label="Remind me">
          {PRESETS.map((p) => {
            const off = !t.dueDate || (p.needsTime && !t.dueTime);
            return (
              <button key={p.label} type="button" aria-pressed={!oneOff && lead === p.lead} disabled={off || ed.setReminder.isPending}
                title={!t.dueDate ? "Set a due date first" : off ? "Add a due time first" : undefined}
                onClick={() => save({ lead: p.lead, repeat })}>{p.label}</button>
            );
          })}
          <button type="button" aria-pressed={!!oneOff} aria-expanded={custom} onClick={() => setCustom((c) => !c)}>Custom…</button>
        </div>
        {custom && (
          <form className="remcustom" onSubmit={(e) => {
            e.preventDefault();
            if (!local) return;
            ed.remind.mutate(new Date(local).toISOString(), { onSuccess: () => { setCustom(false); setLocal(""); } });
          }}>
            <input type="datetime-local" className="tinput wide" aria-label="Remind me at" value={local} onChange={(e) => { setLocal(e.target.value); ed.remind.reset(); }} />
            <button type="submit" className="btn btn-sm" disabled={!local || ed.remind.isPending}>Set</button>
          </form>
        )}
        <div className="sw">
          <div className="txt">
            Keep reminding me until it’s done
            <small>Every working day at {fmtTime(workStart)} once it’s overdue</small>
          </div>
          <Toggle checked={repeat} label="Keep reminding me until it’s done" disabled={ed.setReminder.isPending}
            onChange={(v) => save({ lead, repeat: v })} />
        </div>
        {(ed.setReminder.isError || ed.remind.isError) && <p className="td-err">{errorMessage(ed.setReminder.error ?? ed.remind.error)}</p>}
      </div>
    </section>
  );
}
