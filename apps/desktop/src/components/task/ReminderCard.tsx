// Per-task reminder (mockup E): when to be reminded, plus "keep reminding me until it's done".
// lead: null = the app default (Settings → Reminders), minutes before the due time, or -1 = the morning of.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Repeat } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { Toggle } from "../ui/Controls";
import type { TaskEdit } from "./useTaskEdit";
import { DEFAULT_RULES, nextMoment, type ReminderRules } from "../../lib/reminderPlan";

type Lead = number | null;
const PRESETS: { label: string; lead: Lead; needsTime: boolean }[] = [
  { label: "At due time", lead: 0, needsTime: true },
  { label: "15 min before", lead: 15, needsTime: true },
  { label: "1 hour before", lead: 60, needsTime: true },
  { label: "Morning of", lead: -1, needsTime: false },
];

const fmt = (d: Date) => d.toLocaleString("en-IE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function minutesLabel(m: number) {
  if (m === 0) return "At the due time";
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"} before`;
  return `${m} min before`;
}

export function ReminderCard({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const settings = useQuery({ queryKey: ["tether", "reminder-settings"], queryFn: api.reminders });
  const [custom, setCustom] = useState(false);
  const [local, setLocal] = useState("");
  if (ed.done) return null;

  const rules: ReminderRules = settings.data
    ? { enabled: settings.data.enabled, dueSoonMinutes: settings.data.dueSoonMinutes, overdueAfterMinutes: settings.data.overdueAfterMinutes, workStart: settings.data.workStart, workDays: settings.data.workDays }
    : DEFAULT_RULES;
  const workStart = rules.workStart;
  const lead = t.reminderLead;
  const repeat = t.reminderRepeat;
  const save = (next: { lead: Lead; repeat: boolean }) => ed.setReminder.mutate(next);

  // The same planner as Overview and the scheduler, so the card never promises a reminder that won't fire.
  const next = nextMoment(t, rules);
  const morningTooLate = !!t.dueTime && t.dueTime <= workStart;
  const leadNeedsTime = lead !== null && lead >= 0 && !t.dueTime;
  const title = !rules.enabled ? "Reminders are off" : next ? fmt(next.at) : "Nothing planned";
  const sub = !rules.enabled
    ? "Turn them on in Settings → Reminders"
    : t.snoozedUntil
      ? `Snoozed until ${fmt(new Date(t.snoozedUntil))} · other reminders wait until then`
      : leadNeedsTime
        ? `${minutesLabel(lead!)} · needs a due time`
        : lead === -1 && morningTooLate
          ? "Morning of · due before work starts, so only at the due time"
          : lead === null
            ? `Default · ${t.dueTime ? minutesLabel(rules.dueSoonMinutes).toLowerCase() : "add a due time for an early reminder"}`
            : lead === -1
              ? `Morning of · ${workStart}`
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
            {t.nextReminder && <div className="sub">Also a one-off reminder {fmt(new Date(t.nextReminder))}</div>}
          </div>
          {lead !== null && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}
              onClick={() => save({ lead: null, repeat })} title="Use the default from Settings">Default</button>
          )}
        </div>
        <div className="presets" role="group" aria-label="Remind me">
          {PRESETS.map((p) => {
            const off = !t.dueDate || (p.needsTime && !t.dueTime) || (p.lead === -1 && morningTooLate);
            return (
              <button key={p.label} type="button" aria-pressed={lead === p.lead} disabled={off || ed.setReminder.isPending}
                title={!t.dueDate ? "Set a due date first" : p.lead === -1 && morningTooLate ? "Due before work starts" : off ? "Add a due time first" : undefined}
                onClick={() => save({ lead: p.lead, repeat })}>{p.label}</button>
            );
          })}
          <button type="button" aria-pressed={!!t.nextReminder} aria-expanded={custom} onClick={() => setCustom((c) => !c)}>Custom…</button>
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
            <small>Every working day at {workStart} once it’s overdue</small>
          </div>
          <Toggle checked={repeat} label="Keep reminding me until it’s done" disabled={ed.setReminder.isPending}
            onChange={(v) => save({ lead, repeat: v })} />
        </div>
        {(ed.setReminder.isError || ed.remind.isError) && <p className="td-err">{errorMessage(ed.setReminder.error ?? ed.remind.error)}</p>}
      </div>
    </section>
  );
}
