// Reschedule menu: quick picks, "No date" and a month calendar. Dates are ISO "YYYY-MM-DD".
import { useState, type ReactNode } from "react";
import { CalendarCheck, CalendarDays, CalendarX, ChevronLeft, ChevronRight, Sun, Sunrise } from "lucide-react";
import { addDays } from "@tether/core";
import { todayIso } from "../../lib/format";
import { Popover } from "./Popover";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Quick picks relative to today: tomorrow, the coming Saturday, the coming Monday. */
export function quickDates(today = todayIso()) {
  const dow = parse(today).getDay();
  return {
    today,
    tomorrow: addDays(today, 1),
    weekend: addDays(today, ((6 - dow + 7) % 7) || 7),
    nextWeek: addDays(today, ((8 - dow) % 7) || 7),
  };
}

export function ReschedulePopover({ anchor, value, onPick, onClose }: {
  anchor: HTMLElement | null; value: string | null; onPick: (date: string | null) => void; onClose: () => void;
}) {
  const today = todayIso();
  const q = quickDates(today);
  const [month, setMonth] = useState(() => { const d = parse(value ?? today); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const pick = (d: string | null) => { onClose(); onPick(d); };
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const offset = (month.getDay() + 6) % 7; // Monday first
  const icon = { size: 15, strokeWidth: 1.6 };
  const quick: [string, string, ReactNode][] = [
    ["Today", q.today, <Sun {...icon} />],
    ["Tomorrow", q.tomorrow, <Sunrise {...icon} />],
    ["This weekend", q.weekend, <CalendarDays {...icon} />],
    ["Next week", q.nextWeek, <CalendarCheck {...icon} />],
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} label="Reschedule">
      {quick.map(([label, d, ic]) => (
        <button key={label} type="button" className="pop-item" onClick={() => pick(d)}>
          {ic}{label}<small>{WD[parse(d).getDay()]}</small>
        </button>
      ))}
      <button type="button" className="pop-item" onClick={() => pick(null)}><CalendarX {...icon} />No date</button>
      <hr className="pop-sep" />
      <div className="mcal">
        <div className="mcal-h">
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Previous month"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={14} /></button>
          <span>{month.toLocaleDateString("en-IE", { month: "long", year: "numeric" })}</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Next month"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={14} /></button>
        </div>
        <div className="mcal-g">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} aria-hidden>{d}</span>)}
          {Array.from({ length: offset }, (_, i) => <span key={`o${i}`} />)}
          {Array.from({ length: days }, (_, i) => {
            const d = iso(new Date(month.getFullYear(), month.getMonth(), i + 1));
            const cls = [d < today ? "past" : "", d === today ? "is-today" : "", d === value ? "is-current" : ""].join(" ");
            return (
              <button key={d} type="button" className={cls}
                aria-label={parse(d).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" })}
                aria-current={d === value ? "date" : undefined} onClick={() => pick(d)}>{i + 1}</button>
            );
          })}
        </div>
      </div>
    </Popover>
  );
}
