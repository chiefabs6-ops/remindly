import * as chrono from "chrono-node";

/** Local date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local time as HH:MM. */
export function isoTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

export interface FoundDate {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM when the text named a time. */
  time: string | null;
  /** The exact text that was matched, including a leading "by/before/on/due". */
  text: string;
  index: number;
}

// Words that only introduce a deadline ("before Friday") and should go with the date text.
const LEAD_IN = /(?:\b(?:by|before|on|due|until|till|no later than)\s+)$/i;

/**
 * Find the first date/time phrase in `text` (English), resolving to the future
 * relative to `ref` (so "Friday" means the coming Friday).
 */
export function findDate(text: string, ref: Date = new Date()): FoundDate | null {
  const results = chrono.parse(text, ref, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  let index = r.index;
  let matched = r.text;
  const lead = text.slice(0, index).match(LEAD_IN);
  if (lead) {
    index -= lead[0].length;
    matched = lead[0] + matched;
  }
  const when = r.start.date();
  const hasTime = r.start.isCertain("hour");
  return {
    date: isoDate(when),
    time: hasTime ? isoTime(when) : null,
    text: matched,
    index,
  };
}

/** Friendly label: Today / Tomorrow / Yesterday / weekday within a week / "3 Dec". */
export function relativeDayLabel(date: string, today: string): string {
  const diff = dayDiff(today, date);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (diff > 1 && diff < 7) return dt.toLocaleDateString("en-IE", { weekday: "long" });
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return dt.toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
