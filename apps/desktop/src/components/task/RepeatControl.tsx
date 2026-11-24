import { useState } from "react";
import { Repeat as RepeatIcon } from "lucide-react";
import { nextRepeatDue, relativeDayLabel, repeatLabel, type Repeat, type RepeatUnit, type TaskDetail } from "@tether/core";
import { todayIso } from "../../lib/format";
import { Popover, usePopover } from "../ui/Popover";
import type { TaskEdit } from "./useTaskEdit";

const PRESETS: { label: string; value: Repeat | null }[] = [
  { label: "Does not repeat", value: null },
  { label: "Every day", value: { every: 1, unit: "day" } },
  { label: "Every working day", value: { every: 1, unit: "weekday" } },
  { label: "Every week", value: { every: 1, unit: "week" } },
  { label: "Every month", value: { every: 1, unit: "month" } },
];
const UNITS: { unit: RepeatUnit; one: string; many: string }[] = [
  { unit: "day", one: "day", many: "days" },
  { unit: "weekday", one: "working day", many: "working days" },
  { unit: "week", one: "week", many: "weeks" },
  { unit: "month", one: "month", many: "months" },
];
const same = (a: Repeat | null, b: Repeat | null) => (a === null || b === null ? a === b : a.every === b.every && a.unit === b.unit);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The "Repeat" row of the Properties card. Not shown for subtasks: only the parent task repeats. */
export function RepeatControl({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const menu = usePopover();
  const custom = usePopover();
  const [every, setEvery] = useState("2");
  const [unit, setUnit] = useState<RepeatUnit>("week");
  if (t.parentId) return null;

  const r = t.repeat;
  const n = Number(every);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;
  const pick = (v: Repeat | null) => { menu.close(); if (!same(v, r)) ed.setRepeat.mutate(v); };
  const isPreset = PRESETS.some((p) => p.value && same(p.value, r));
  const today = todayIso();

  return (
    <>
      <dt><RepeatIcon size={14} strokeWidth={1.6} />Repeat</dt>
      <dd>
        <button type="button" className="val" aria-label={`Repeat: ${r ? cap(repeatLabel(r.every, r.unit)) : "does not repeat"}. Change`} aria-haspopup="menu"
          onClick={(e) => menu.open(e.currentTarget)}>
          {r ? cap(repeatLabel(r.every, r.unit)) : <span className="muted">Does not repeat</span>}
        </button>
        {r && t.status !== "completed" && (
          <span className="rep-hint">Next one is due {relativeDayLabel(nextRepeatDue(today, r.every, r.unit), today)} after you complete it</span>
        )}
        <Popover anchor={menu.anchor} onClose={menu.close} label="Repeat" role="menu">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" role="menuitemradio" aria-checked={same(p.value, r)} className="pop-item" onClick={() => pick(p.value)}>{p.label}</button>
          ))}
          <button type="button" role="menuitemradio" aria-checked={!!r && !isPreset} className="pop-item"
            onClick={() => {
              const anchor = menu.anchor;
              menu.close();
              if (r) { setEvery(String(r.every)); setUnit(r.unit); }
              if (anchor) custom.open(anchor);
            }}>Custom…</button>
        </Popover>
        {custom.anchor && (
          <Popover anchor={custom.anchor} onClose={custom.close} label="Custom repeat">
            <form className="rep-custom" onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              custom.close();
              ed.setRepeat.mutate({ every: n, unit });
            }}>
              <span>Every</span>
              <input type="number" className="tinput" min={1} max={365} step={1} aria-label="Repeat every" value={every} onChange={(e) => setEvery(e.target.value)} />
              <select className="tinput" aria-label="Repeat unit" value={unit} onChange={(e) => setUnit(e.target.value as RepeatUnit)}>
                {UNITS.map((u) => <option key={u.unit} value={u.unit}>{n === 1 ? u.one : u.many}</option>)}
              </select>
              <div className="rep-acts">
                <button type="button" className="btn btn-sm" onClick={custom.close}>Cancel</button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={!valid}>Save</button>
              </div>
            </form>
          </Popover>
        )}
      </dd>
    </>
  );
}
