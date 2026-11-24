import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Bell, ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dayDiff, isoDate, type Project, type Task, type TaskStatus } from "@tether/core";
import { Segmented } from "../components/ui/Controls";
import { Popover, usePopover } from "../components/ui/Popover";
import { errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { dueTone, longDate, todayIso } from "../lib/format";
import { useProjects, useTasks } from "../lib/queries";

/** Everything with a due date except archived tasks; finished ones stay visible, dimmed and struck through. */
const STATUSES: TaskStatus[] = ["inbox", "not_started", "in_progress", "waiting", "completed"];
const PX = 48; // pixels per hour
const DEFAULT_START = 8;
const DEFAULT_END = 19;
const BLOCK_MIN = 30;
const CHIP_LIMIT = 3;

type View = "week" | "month";

const parse = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const toMin = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const mondayOf = (iso: string) => addDays(iso, -((parse(iso).getDay() + 6) % 7));
const validIso = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(parse(s)) === s;
const isDone = (t: Task) => t.status === "completed";
const byTime = (a: Task, b: Task) => (a.dueTime ?? "").localeCompare(b.dueTime ?? "") || a.sortOrder - b.sortOrder;
const MONTH = (d: Date, style: "long" | "short" = "long") => d.toLocaleDateString("en-IE", { month: style });

function weekLabel(monday: string): string {
  const a = parse(monday);
  const b = parse(addDays(monday, 6));
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()} – ${b.getDate()} ${MONTH(b)} ${b.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear()) return `${a.getDate()} ${MONTH(a, "short")} – ${b.getDate()} ${MONTH(b, "short")} ${b.getFullYear()}`;
  return `${a.getDate()} ${MONTH(a, "short")} ${a.getFullYear()} – ${b.getDate()} ${MONTH(b, "short")} ${b.getFullYear()}`;
}

const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split("-").map(Number);
  return isoDate(new Date(y, m - 1 + by, 1)).slice(0, 7);
};

interface Ctx {
  today: string;
  projectOf: (t: Task) => Project | undefined;
  open: (id: string) => void;
}

function Chip({ t, ctx, showTime }: { t: Task; ctx: Ctx; showTime?: boolean }) {
  const cls = isDone(t) ? "done" : dueTone(t, ctx.today) === "overdue" ? "od" : "";
  return (
    <a className={`adchip ${cls}`} href={`#/task/${t.id}`} title={t.title}
      onClick={(e) => { e.preventDefault(); ctx.open(t.id); }}>
      <i className="dot" style={{ background: toneDot(ctx.projectOf(t)?.color) }} />
      <span>{showTime && t.dueTime && <span className="num">{t.dueTime} </span>}{t.title}</span>
    </a>
  );
}

/** Up to three chips, then "+N more" with the rest in a small popover. */
function ChipList({ items, ctx, showTime, label }: { items: Task[]; ctx: Ctx; showTime?: boolean; label: string }) {
  const pop = usePopover();
  const rest = items.slice(CHIP_LIMIT);
  return (
    <>
      {items.slice(0, CHIP_LIMIT).map((t) => <Chip key={t.id} t={t} ctx={ctx} showTime={showTime} />)}
      {rest.length > 0 && (
        <button type="button" className="more" aria-label={`${rest.length} more, ${label}`} onClick={(e) => pop.open(e.currentTarget)}>
          +{rest.length} more
        </button>
      )}
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} label={`All tasks, ${label}`}>
          <div className="cal-more">
            {items.map((t) => <Chip key={t.id} t={t} ctx={ctx} showTime />)}
          </div>
        </Popover>
      )}
    </>
  );
}

interface Placed { t: Task; top: number; height: number; lane: number; lanes: number }

/** Side-by-side lanes for blocks that overlap in time. */
function place(items: Task[], start: number): Placed[] {
  const sorted = [...items].sort(byTime);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const close = () => { for (const p of cluster) p.lanes = laneEnds.length; cluster = []; laneEnds.length = 0; };
  for (const t of sorted) {
    const s = toMin(t.dueTime!);
    if (s >= clusterEnd) close();
    let lane = laneEnds.findIndex((e) => e <= s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = s + BLOCK_MIN;
    clusterEnd = Math.max(clusterEnd, s + BLOCK_MIN);
    const p = { t, top: ((s - start * 60) / 60) * PX + 1, height: Math.max(22, (BLOCK_MIN / 60) * PX - 3), lane, lanes: 1 };
    cluster.push(p);
    out.push(p);
  }
  close();
  return out;
}

function WeekGrid({ days, tasks, ctx }: { days: string[]; tasks: Task[]; ctx: Ctx }) {
  const timed = tasks.filter((t) => t.dueTime);
  let start = DEFAULT_START;
  let end = DEFAULT_END;
  for (const t of timed) {
    start = Math.min(start, Math.floor(toMin(t.dueTime!) / 60));
    end = Math.min(24, Math.max(end, Math.ceil((toMin(t.dueTime!) + BLOCK_MIN) / 60)));
  }
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMin - start * 60) / 60) * PX;
  const showNow = nowMin >= start * 60 && nowMin < end * 60;

  return (
    <div className="cw" role="group" aria-label="Week">
      <div className="corner" />
      {days.map((s) => {
        const d = parse(s);
        return (
          <div key={s} className={`dh ${s === ctx.today ? "td" : ""}`} role="columnheader" aria-label={longDate(s)}>
            {d.toLocaleDateString("en-IE", { weekday: "short" })}<b className="num">{d.getDate()}</b>
          </div>
        );
      })}
      <div className="adl">Due</div>
      {days.map((s) => (
        <div key={s} className="ad" data-date={s} aria-label={`Due ${longDate(s)}`}>
          <ChipList items={tasks.filter((t) => t.dueDate === s && !t.dueTime)} ctx={ctx} label={longDate(s)} />
        </div>
      ))}
      <div className="hrs">
        {Array.from({ length: end - start }, (_, i) => <div key={i} className="num">{i ? `${String(start + i).padStart(2, "0")}:00` : ""}</div>)}
      </div>
      {days.map((s) => (
        <div key={s} className={`dcol ${s === ctx.today ? "td" : ""}`} data-date={s} aria-label={`Timed ${longDate(s)}`} style={{ height: (end - start) * PX }}>
          {place(timed.filter((t) => t.dueDate === s), start).map(({ t, top, height, lane, lanes }) => (
            <a key={t.id} className={`ev task ${t.priority === 3 ? "hi" : ""} ${isDone(t) ? "done" : dueTone(t, ctx.today) === "overdue" ? "od" : ""}`} href={`#/task/${t.id}`}
              style={{ top, height, left: `calc(${(lane / lanes) * 100}% + 4px)`, right: `calc(${((lanes - lane - 1) / lanes) * 100}% + 4px)` }}
              onClick={(e) => { e.preventDefault(); ctx.open(t.id); }}>
              <b>{t.title}</b>
              <small className="num">Due {t.dueTime}</small>
              {t.reminderLead !== null && <Bell size={11} className="bell" aria-label="Has a reminder" />}
            </a>
          ))}
          {s === ctx.today && showNow && <div className="now" aria-hidden="true" data-testid="now-line" title={`Now ${hm(nowMin)}`} style={{ top: nowTop }} />}
        </div>
      ))}
    </div>
  );
}

/** Phone: the grid hides and each day of the week is a short list. */
function Agenda({ days, tasks, ctx }: { days: string[]; tasks: Task[]; ctx: Ctx }) {
  return (
    <div className="agenda" aria-label="Agenda">
      {days.map((s) => {
        const items = tasks.filter((t) => t.dueDate === s).sort((a, b) => (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
        return (
          <section key={s} aria-label={`Agenda ${longDate(s)}`}>
            <div className="gh">{longDate(s)}{s === ctx.today && <span className="pill pill-today">Today</span>}</div>
            {items.length === 0 ? <p className="muted">Nothing planned</p> : items.map((t) => (
              <a key={t.id} className={`ag ${isDone(t) ? "done" : ""}`} href={`#/task/${t.id}`}
                onClick={(e) => { e.preventDefault(); ctx.open(t.id); }}>
                <span className="num tm">{t.dueTime ?? "Due"}</span>
                <i className="dot" style={{ background: toneDot(ctx.projectOf(t)?.color) }} />
                <span className="tt">{t.title}</span>
              </a>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function MonthGrid({ cells, month, tasks, ctx }: { cells: string[]; month: string; tasks: Task[]; ctx: Ctx }) {
  return (
    <div className="mg" role="group" aria-label="Month">
      {cells.slice(0, 7).map((s) => <div key={s} className="mh" role="columnheader">{parse(s).toLocaleDateString("en-IE", { weekday: "short" })}</div>)}
      {cells.map((s) => {
        const items = tasks.filter((t) => t.dueDate === s).sort(byTime);
        return (
          <div key={s} className={`mc ${s.slice(0, 7) !== month ? "out" : ""} ${s === ctx.today ? "td" : ""}`} data-date={s}>
            <b className="num">{parse(s).getDate()}</b>
            {items.length > 0 && <a className="mcount num" href={`#/calendar?week=${mondayOf(s)}`} aria-label={`${items.length} due ${longDate(s)}: show that week`}>{items.length}</a>}
            <div className="mchips"><ChipList items={items} ctx={ctx} showTime label={longDate(s)} /></div>
          </div>
        );
      })}
    </div>
  );
}

export function CalendarScreen() {
  const [params, setParams] = useSearchParams();
  // Re-render every minute so the "now" line moves and "today" turns over at midnight.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const navigate = useNavigate();
  const today = todayIso();
  const projects = useProjects();

  const view: View = params.get("view") === "month" ? "month" : "week";
  const weekParam = params.get("week");
  const monday = mondayOf(validIso(weekParam) ? weekParam : today);
  const monthParam = params.get("month");
  const month = monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : today.slice(0, 7);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const cells = useMemo(() => {
    const first = `${month}-01`;
    const gridStart = mondayOf(first);
    const last = addDays(shiftMonth(month, 1) + "-01", -1);
    const weeks = Math.ceil((dayDiff(gridStart, last) + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  }, [month]);

  const range = view === "week" ? { from: days[0], to: days[6] } : { from: cells[0], to: cells[cells.length - 1] };
  const tasksQ = useTasks({ statuses: STATUSES, topLevelOnly: true, dueFrom: range.from, dueTo: range.to });
  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const ctx: Ctx = {
    today,
    projectOf: (t) => (t.projectId ? projectById.get(t.projectId) : undefined),
    open: (id) => navigate(window.innerWidth < 1024 ? `/task/${id}` : `/tasks?task=${id}`),
  };

  const go = (next: Record<string, string>) => setParams(next, { replace: true });
  const goWeek = (m: string) => go(m === mondayOf(today) ? {} : { week: m });
  const goMonth = (ym: string) => go({ view: "month", month: ym });
  const prev = () => (view === "week" ? goWeek(addDays(monday, -7)) : goMonth(shiftMonth(month, -1)));
  const next = () => (view === "week" ? goWeek(addDays(monday, 7)) : goMonth(shiftMonth(month, 1)));
  const todayBtn = () => (view === "week" ? goWeek(mondayOf(today)) : goMonth(today.slice(0, 7)));
  const switchView = (v: View) => {
    if (v === view) return;
    if (v === "month") goMonth(addDays(monday, 3).slice(0, 7));
    else goWeek(mondayOf(month === today.slice(0, 7) ? today : `${month}-01`));
  };

  const shown = tasks.filter((t) => t.dueDate && t.dueDate >= range.from && t.dueDate <= range.to && (view === "week" || t.dueDate.slice(0, 7) === month));
  const late = shown.filter((t) => dueTone(t, today) === "overdue").length;
  const label = view === "week" ? weekLabel(monday) : parse(`${month}-01`).toLocaleDateString("en-IE", { month: "long", year: "numeric" });
  const period = view === "week" ? "this week" : `in ${parse(`${month}-01`).toLocaleDateString("en-IE", { month: "long" })}`;
  const unit = view === "week" ? "week" : "month";

  return (
    <div className="cal-page">
      <header className="pg-h">
        <div>
          <h1>Calendar</h1>
          <div className="summary">
            {tasksQ.data
              ? <><b className="num">{shown.length}</b> due {period}{late > 0 && <> · <span className="od"><b className="num od">{late}</b> overdue</span></>}</>
              : " "}
          </div>
        </div>
        <div className="right calbar">
          <button type="button" className="btn btn-sm btn-icon" aria-label={`Previous ${unit}`} onClick={prev}><ChevronLeft size={14} /></button>
          <button type="button" className="btn btn-sm" onClick={todayBtn}>Today</button>
          <button type="button" className="btn btn-sm btn-icon" aria-label={`Next ${unit}`} onClick={next}><ChevronRight size={14} /></button>
          <span className="wk num">{label}</span>
          <Segmented<View> label="Calendar view" value={view} onChange={switchView}
            options={[{ value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        </div>
      </header>

      {tasksQ.isError ? (
        <div>
          <p className="od">Couldn’t load the calendar: {errorMessage(tasksQ.error)}</p>
          <button type="button" className="btn mt-3" onClick={() => void tasksQ.refetch()}>Retry</button>
        </div>
      ) : !tasksQ.data ? (
        <div className="cal-skel" aria-busy="true" />
      ) : view === "month" ? (
        <MonthGrid cells={cells} month={month} tasks={tasks} ctx={ctx} />
      ) : shown.length === 0 ? (
        <p className="cal-empty">Nothing due this week.</p>
      ) : (
        <>
          <div className="legend">
            <span><i className="lg-task" />Task due</span>
            <span><i className="lg-hi" />High priority</span>
          </div>
          <WeekGrid days={days} tasks={tasks} ctx={ctx} />
          <Agenda days={days} tasks={tasks} ctx={ctx} />
        </>
      )}
    </div>
  );
}
