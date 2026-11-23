import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { Task } from "@tether/core";
import { DayStrip } from "../components/DayStrip";
import { QuickAdd } from "../components/QuickAdd";
import { TaskPanel } from "../components/TaskPanel";
import { TaskList } from "../components/TaskRow";
import { api, errorMessage } from "../lib/api";
import { ago, longDate } from "../lib/format";
import { useDashboard, useProjects, useSuggestions } from "../lib/queries";
import { ORIGIN, Review, UpdateReview, suggestionTitle } from "./Inbox";

type View = "today" | "fortnight";

function Group({ title, count, tone, children }: { title: string; count: number; tone?: "late"; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="flex items-baseline gap-2 px-2 pt-4 pb-1.5 text-[13px] font-medium text-muted">
        <span className="text-ink">{title}</span>
        <span className={`num ${tone === "late" && count ? "text-negative" : ""}`}>{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** Right-hand panel when no task is open: approvals first (Chrome / Claude Code), then the plan. */
function Rail({ onOpenTask, selectedSuggestion, onSelectSuggestion }: {
  onOpenTask: (id: string) => void;
  selectedSuggestion: string | null;
  onSelectSuggestion: (id: string | null) => void;
}) {
  const sugg = useSuggestions("pending");
  const projects = useProjects();
  const dash = useDashboard();
  const [showPlan, setShowPlan] = useState(true);
  const plan = useQuery({ queryKey: ["tether", "plan"], queryFn: api.planDay, enabled: showPlan });
  const list = sugg.data ?? [];
  const current = list.find((s) => s.id === selectedSuggestion);
  const d = dash.data;

  if (current) {
    return (
      <div>
        <button className="flex items-center gap-1 px-5 pt-4 text-[13px] text-muted hover:text-ink" onClick={() => onSelectSuggestion(null)}>
          <ChevronLeft size={14} /> Back to approvals
        </button>
        {current.kind === "task_update" ? (
          <UpdateReview key={current.id} s={current} onDone={() => onSelectSuggestion(null)} />
        ) : (
          <Review key={current.id} s={current} projects={projects.data ?? []} onDone={() => onSelectSuggestion(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <section aria-labelledby="ap-h">
        <h2 id="ap-h" className="mb-1 flex items-baseline gap-2 font-semibold">
          Needs your approval <span className="num text-[13px] font-normal text-muted">{list.length}</span>
        </h2>
        <p className="mb-2 text-[13px] text-muted">Captured in Chrome or suggested by Claude Code. Nothing becomes a task until you approve it.</p>
        {list.length === 0 ? (
          <p className="rounded-[8px] bg-raised px-3 py-2.5 text-muted">All clear.</p>
        ) : (
          <ul className="overflow-hidden rounded-[8px] border border-line">
            {list.slice(0, 6).map((s) => (
              <li key={s.id} className="border-t border-rule first:border-t-0">
                <button onClick={() => onSelectSuggestion(s.id)} className="block w-full px-3 py-2.5 text-left hover:bg-raised">
                  <span className="flex items-baseline gap-2">
                    <span className="flex-1 truncate font-medium">{suggestionTitle(s)}</span>
                    <span className="flex-none text-xs text-muted">{ago(s.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
                    {ORIGIN[s.origin]}
                    {s.possibleDuplicateOf && <span className="pill pill-warning">Possible duplicate</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.length > 6 && <p className="mt-2 text-xs text-muted">{list.length - 6} more after these.</p>}
      </section>

      <section aria-labelledby="plan-h">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 id="plan-h" className="font-semibold">Plan for today</h2>
          <button className="text-xs text-muted underline" onClick={() => setShowPlan(!showPlan)}>{showPlan ? "Hide" : "Show"}</button>
        </div>
        {showPlan && (plan.data ? (
          <>
            <p className="mb-2 text-[13px] text-muted">{plan.data.summary}</p>
            {plan.data.items.length > 0 && (
              <ol className="list-decimal space-y-1 pl-5">
                {plan.data.items.map((i) => (
                  <li key={i.task.id}>
                    <button className="text-left hover:underline" onClick={() => onOpenTask(i.task.id)}>{i.task.title}</button>
                    <span className="text-[13px] text-muted"> — {i.reason}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : plan.isError ? <p className="text-negative">{errorMessage(plan.error)}</p> : <div className="h-12 rounded bg-active" aria-busy="true" />)}
      </section>

      <section aria-labelledby="done-h">
        <h2 id="done-h" className="mb-2 font-semibold">Done today <span className="num text-[13px] font-normal text-muted">{d?.completedToday.length ?? 0}</span></h2>
        {d && d.progress.total > 0 && (
          <div className="h-1.5 rounded-full bg-active" role="progressbar" aria-valuemin={0} aria-valuemax={d.progress.total}
            aria-valuenow={d.progress.done} aria-label="Today's progress">
            {d.progress.done > 0 && <div className="h-1.5 rounded-full bg-today" style={{ width: `${(d.progress.done / d.progress.total) * 100}%` }} />}
          </div>
        )}
        <p className="num mt-1 text-xs text-muted">{d ? `${d.progress.done} of ${d.progress.total} for today` : " "}</p>
      </section>
    </div>
  );
}

export function TodayScreen() {
  const dash = useDashboard();
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const open = params.get("task");
  const suggestion = params.get("s");
  const [view, setView] = useState<View>("today");
  const setParam = (k: "task" | "s", v: string | null) => {
    const next = new URLSearchParams();
    if (v) next.set(k, v);
    setParams(next, { replace: true });
  };
  const openTask = (id: string | null) => setParam("task", id);
  const ps = projects.data ?? [];

  if (dash.isError) {
    return (
      <div className="p-8">
        <h1 className="text-[22px] font-semibold">Today</h1>
        <p className="mt-2 text-muted">Couldn’t load today’s tasks: {errorMessage(dash.error)}</p>
        <button className="btn mt-3" onClick={() => dash.refetch()}>Retry</button>
      </div>
    );
  }
  const d = dash.data;
  const late = d?.overdue.length ?? 0;
  const dueToday = d?.dueToday.length ?? 0;
  const strip: Task[] = d ? [...d.dueToday, ...d.dueSoon, ...d.upcoming] : [];

  return (
    <div className="flex min-h-full max-xl:flex-col">
      <div className="min-w-0 flex-1 px-6 pt-6 pb-10">
        <header className="mb-4">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">Today</h1>
          <p className="mt-1 text-muted">
            {d ? longDate(d.today) : " "}
            {d && (
              <>
                {" · "}
                {late > 0 && <span className="font-medium text-negative">{late} overdue · </span>}
                {dueToday} due today · {d.progress.done} of {d.progress.total} done
              </>
            )}
          </p>
        </header>

        <div className="mb-4"><QuickAdd projects={ps} onCreated={(id) => openTask(id)} /></div>

        <div className="flex gap-5 border-b border-line" role="tablist">
          {([["today", "Today"], ["fortnight", "Next 14 days"]] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={`-mb-px h-9 border-b-2 font-medium ${view === v ? "border-today text-ink" : "border-transparent text-muted hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="py-3">
          {d ? <DayStrip today={d.today} tasks={strip} overdue={late} /> : <div className="h-[104px]" aria-busy="true" />}
        </div>

        {view === "today" ? (
          <div>
            {late > 0 && (
              <Group title="Overdue" count={late} tone="late">
                <TaskList tasks={d!.overdue} projects={ps} selectedId={open} onOpen={openTask} empty="" />
              </Group>
            )}
            <Group title="Today" count={dueToday}>
              <TaskList tasks={d?.dueToday ?? []} projects={ps} selectedId={open} onOpen={openTask}
                empty="Nothing due today. Add one above, or pull something forward from the next 14 days." />
            </Group>
            {!!d?.carriedOver.length && (
              <Group title="Carried over" count={d.carriedOver.length}>
                <TaskList tasks={d.carriedOver} projects={ps} selectedId={open} onOpen={openTask} empty="" />
              </Group>
            )}
            <Group title="Next 3 days" count={d?.dueSoon.length ?? 0}>
              <TaskList tasks={d?.dueSoon ?? []} projects={ps} selectedId={open} onOpen={openTask} empty="Nothing due in the next 3 days." />
            </Group>
          </div>
        ) : (
          <div>
            <Group title="Next 3 days" count={d?.dueSoon.length ?? 0}>
              <TaskList tasks={d?.dueSoon ?? []} projects={ps} selectedId={open} onOpen={openTask} empty="Nothing due in the next 3 days." />
            </Group>
            <Group title="Later this fortnight" count={d?.upcoming.length ?? 0}>
              <TaskList tasks={d?.upcoming ?? []} projects={ps} selectedId={open} onOpen={openTask} empty="Nothing else due in the next two weeks." />
            </Group>
          </div>
        )}
      </div>

      <aside className="w-[380px] flex-none border-l border-line max-xl:w-full max-xl:border-t max-xl:border-l-0" aria-label={open ? "Task details" : "Approvals and plan"}>
        {open ? (
          <div className="xl:sticky xl:top-0 xl:h-[calc(100vh-56px)]">
            <TaskPanel key={open} id={open} projects={ps} onClose={() => openTask(null)} onOpen={openTask} />
          </div>
        ) : (
          <Rail onOpenTask={(id) => openTask(id)} selectedSuggestion={suggestion} onSelectSuggestion={(id) => setParam("s", id)} />
        )}
      </aside>
    </div>
  );
}
