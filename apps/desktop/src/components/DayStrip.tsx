import { addDays, type Task } from "@tether/core";

/**
 * Tether's signature element: the next 14 days as one strip, a column per day whose height is
 * the number of open tasks due that day. Today is in the data hue; overdue work collects in a
 * "Late" column on the left in the negative colour.
 */
export function DayStrip({ today, tasks, overdue }: { today: string; tasks: Task[]; overdue: number }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const counts = days.map((d) => tasks.filter((t) => t.dueDate === d).length);
  const max = Math.max(1, overdue, ...counts);
  const H = 56;

  const col = (key: string, label: string, sub: string, n: number, tone: "late" | "today" | "plain", weekend = false, narrowHide = false) => (
    <li key={key} className={`flex min-w-0 flex-1 flex-col items-center gap-1 ${narrowHide ? "max-sm:hidden" : ""}`} aria-label={`${label} ${sub}: ${n} due`}>
      <span className={`num text-xs ${n === 0 ? "text-faint" : tone === "late" ? "text-negative" : ""}`}>{n}</span>
      <span className="flex w-full items-end justify-center" style={{ height: H }}>
        <span
          className="w-[min(100%,20px)] rounded-t-[2px]"
          style={{
            height: n === 0 ? 1 : Math.max(3, Math.round((n / max) * H)),
            background:
              n === 0
                ? "var(--border)"
                : tone === "late"
                  ? "var(--negative)"
                  : tone === "today"
                    ? "var(--today)"
                    : "var(--text)",
          }}
        />
      </span>
      <span
        className={`text-xs ${tone === "today" ? "font-medium text-today" : weekend ? "text-faint" : "text-muted"}`}
      >
        {label}
      </span>
      <span className="num text-[11px] text-faint">{sub}</span>
    </li>
  );

  return (
    <ol className="flex gap-1" aria-label="Open tasks due over the next 14 days">
      {col("late", "Late", "before", overdue, "late")}
      <li aria-hidden className="mx-1 w-px self-stretch bg-rule" />
      {days.map((d, i) => {
        const dt = new Date(`${d}T12:00:00`);
        const wd = dt.getDay();
        return col(
          d,
          i === 0 ? "Today" : dt.toLocaleDateString("en-IE", { weekday: "short" }),
          String(dt.getDate()),
          counts[i],
          i === 0 ? "today" : "plain",
          wd === 0 || wd === 6,
          i >= 7, // phones show one week
        );
      })}
    </ol>
  );
}
