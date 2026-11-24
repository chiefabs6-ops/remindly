import { useState } from "react";
import { Bell } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { errorMessage } from "../../lib/api";
import { localIso } from "./model";
import type { TaskEdit } from "./useTaskEdit";

const PRESETS = ["At due time", "15 min before", "1 hour before", "Morning of", "Custom…"] as const;
type Preset = (typeof PRESETS)[number];

/** Preset reminders worked out from the due date and time. (The API cannot say which reminder exists, so only the one set here is shown.) */
function presetTime(t: TaskDetail, p: Exclude<Preset, "Custom…">): string | null {
  if (!t.dueDate) return null;
  const [hh, mm] = (t.dueTime ?? "09:00").split(":").map(Number);
  switch (p) {
    case "At due time": return localIso(t.dueDate, hh, mm);
    case "15 min before": return localIso(t.dueDate, hh, mm, 15);
    case "1 hour before": return localIso(t.dueDate, hh, mm, 60);
    case "Morning of": return localIso(t.dueDate, 9, 0);
  }
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ReminderCard({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const [chosen, setChosen] = useState<{ preset: Preset; at: string } | null>(null);
  const [custom, setCustom] = useState(false);
  const [local, setLocal] = useState("");
  if (ed.done) return null;
  const set = (preset: Preset, iso: string) => {
    ed.remind.reset();
    ed.remind.mutate(iso, { onSuccess: () => setChosen({ preset, at: iso }) });
  };
  const noDate = !t.dueDate;
  return (
    <div className="sec">
      <div className="sec-h"><Bell size={14} strokeWidth={1.6} />Reminder</div>
      <div className={chosen ? "remcard" : undefined}>
        {chosen && <div className="remline"><Bell size={15} /><div><div className="when">{when(chosen.at)}</div><div className="sub">{chosen.preset === "Custom…" ? "Custom time" : chosen.preset}</div></div></div>}
        <div className="presets" role="group" aria-label="Remind me">
          {PRESETS.map((p) => (
            <button key={p} type="button" aria-pressed={chosen?.preset === p} disabled={noDate && p !== "Custom…"} title={noDate && p !== "Custom…" ? "Set a due date first" : undefined}
              onClick={() => {
                if (p === "Custom…") { setCustom((c) => !c); return; }
                setCustom(false);
                const iso = presetTime(t, p);
                if (iso) set(p, iso);
              }}>{p}</button>
          ))}
        </div>
        {custom && (
          <form className="remcustom" onSubmit={(e) => { e.preventDefault(); if (local) { set("Custom…", new Date(local).toISOString()); setCustom(false); setLocal(""); } }}>
            <input type="datetime-local" className="tinput wide" aria-label="Remind me at" value={local} onChange={(e) => { setLocal(e.target.value); ed.remind.reset(); }} />
            <button type="submit" className="btn btn-sm" disabled={!local || ed.remind.isPending}>Set</button>
          </form>
        )}
        {ed.remind.isError && <p className="td-err">{errorMessage(ed.remind.error)}</p>}
      </div>
    </div>
  );
}
