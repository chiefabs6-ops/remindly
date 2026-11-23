import { useState } from "react";
import { useSearchParams, Link } from "react-router";
import type { Task } from "@tether/core";
import { DayStrip } from "../components/DayStrip";
import { QuickAdd } from "../components/QuickAdd";
import { TaskPanel } from "../components/TaskPanel";
import { TaskList } from "../components/TaskRow";
import { errorMessage } from "../lib/api";
import { ago, longDate } from "../lib/format";
import { useDashboard, useProjects } from "../lib/queries";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

function Section({ title, count, tone, children }: { title: string; count: number; tone?: "late"; children: React.ReactNode }) {
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="mb-1 flex items-baseline gap-2 px-2 font-medium">
        {title}
        <span className={`num text-xs ${tone === "late" && count ? "text-negative" : "text-muted"}`}>{count}</span>
      </h2>
      {children}
    </section>
  );
}

const ORIGIN_LABEL = { chrome: "Chrome", claude: "Claude Code", ai: "Local AI", note: "Note" };

export function TodayScreen() {
  const dash = useDashboard();
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const open = params.get("task");
  const openTask = (id: string | null) => setParams(id ? { task: id } : {}, { replace: true });
  const ps = projects.data ?? [];
  const [showPlan, setShowPlan] = useState(false);
  const plan = useQuery({ queryKey: ["tether", "plan"], queryFn: api.planDay, enabled: showPlan });

  if (dash.isError) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="mt-2 text-muted">Couldn’t load today’s tasks: {errorMessage(dash.error)}</p>
        <button className="btn mt-3" onClick={() => dash.refetch()}>Retry</button>
      </div>
    );
  }
  const d = dash.data;
  const late = d?.overdue.length ?? 0;
  const dueToday = d?.dueToday.length ?? 0;
  const upcomingAll: Task[] = d ? [...d.dueToday, ...d.dueSoon, ...d.upcoming] : [];
  const pendingTotal = d?.pending.reduce((n, p) => n + p.count, 0) ?? 0;

  // The finding: what needs attention first, in words.
  const finding = !d
    ? " "
    : late
      ? `${late} overdue — start there. ${dueToday} due today, ${d.progress.done} of ${d.progress.total} done.`
      : dueToday
        ? `${dueToday} due today, ${d.progress.done} of ${d.progress.total} done.`
        : d.progress.done
          ? `Everything due today is done (${d.progress.done}).`
          : "Nothing due today.";

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-[-0.01em]">Today</h1>
          <p className="mt-1 text-muted">
            <span>{d ? longDate(d.today) : " "}</span>
            <span className="mx-2 text-faint">·</span>
            <span className={late ? "text-negative" : ""}>{finding}</span>
          </p>
        </header>

        <div className="mb-5">
          <QuickAdd projects={ps} onCreated={(id) => openTask(id)} />
        </div>

        <div className="mb-5">
          {!showPlan ? (
            <button className="btn" onClick={() => setShowPlan(true)}>Plan my day</button>
          ) : (
            <section className="rounded-[8px] border border-line bg-surface p-4" aria-labelledby="plan-h">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 id="plan-h" className="font-medium">Plan for today</h2>
                <button className="text-xs underline" onClick={() => setShowPlan(false)}>Hide</button>
              </div>
              {plan.data ? (
                <>
                  <p className="mb-2">{plan.data.summary}</p>
                  {plan.data.items.length > 0 && (
                    <ol className="list-decimal space-y-1 pl-5">
                      {plan.data.items.map((i) => (
                        <li key={i.task.id}>
                          <button className="text-left hover:underline" onClick={() => openTask(i.task.id)}>{i.task.title}</button>
                          <span className="text-muted"> — {i.reason}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              ) : plan.isError ? (
                <p className="text-negative">{errorMessage(plan.error)}</p>
              ) : (
                <div className="h-12 rounded bg-active" aria-busy="true" />
              )}
            </section>
          )}
        </div>

        <div className="mb-6 rounded-[8px] border border-line bg-surface px-4 pt-3 pb-2">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-medium">Next two weeks</h2>
            <span className="text-xs text-muted">Open tasks by due date</span>
          </div>
          {d ? <DayStrip today={d.today} tasks={upcomingAll} overdue={late} /> : <div className="h-[104px]" aria-busy="true" />}
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <div className="min-w-0 rounded-[8px] border border-line bg-surface p-3">
            {late > 0 && (
              <Section title="Overdue" count={late} tone="late">
                <TaskList tasks={d!.overdue} projects={ps} selectedId={open} onOpen={openTask} empty="" />
              </Section>
            )}
            <Section title="Due today" count={dueToday}>
              <TaskList tasks={d?.dueToday ?? []} projects={ps} selectedId={open} onOpen={openTask}
                empty="Nothing due today. Add one above, or pull something forward from below." />
            </Section>
            {!!d?.carriedOver.length && (
              <Section title="Carried over" count={d.carriedOver.length}>
                <TaskList tasks={d.carriedOver} projects={ps} selectedId={open} onOpen={openTask} empty="" />
              </Section>
            )}
            <Section title="Due in the next 3 days" count={d?.dueSoon.length ?? 0}>
              <TaskList tasks={d?.dueSoon ?? []} projects={ps} selectedId={open} onOpen={openTask} empty="Nothing due in the next 3 days." />
            </Section>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <section className="rounded-[8px] border border-line bg-surface p-4" aria-labelledby="sugg-h">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 id="sugg-h" className="font-medium">Waiting for approval <span className="num text-muted">{pendingTotal}</span></h2>
                <Link to="/inbox" className="text-xs underline">Review</Link>
              </div>
              {d?.suggestions.length ? (
                <ul className="space-y-1">
                  {d.suggestions.slice(0, 4).map((s) => (
                    <li key={s.id}>
                      <Link to={`/inbox?s=${s.id}`} className="block rounded-[6px] px-2 py-1.5 hover:bg-raised">
                        <span className="block truncate">{(s.payload as { title?: string }).title ?? "Note"}</span>
                        <span className="text-xs text-muted">{ORIGIN_LABEL[s.origin]} · {ago(s.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No suggestions waiting. Captures from Chrome and Claude Code land here.</p>
              )}
            </section>

            <section className="rounded-[8px] border border-line bg-surface p-4" aria-labelledby="done-h">
              <h2 id="done-h" className="mb-2 font-medium">
                Done today <span className="num text-muted">{d?.completedToday.length ?? 0}</span>
              </h2>
              {d && d.progress.total > 0 && (
                <div className="mb-3">
                  <div className="h-2 rounded-full bg-active" role="progressbar" aria-valuemin={0}
                    aria-valuemax={d.progress.total} aria-valuenow={d.progress.done} aria-label="Today's progress">
                    {d.progress.done > 0 && (
                      <div className="h-2 rounded-full bg-today" style={{ width: `${(d.progress.done / d.progress.total) * 100}%` }} />
                    )}
                  </div>
                  <p className="num mt-1 flex justify-between text-xs text-muted">
                    <span>{d.progress.done} done</span><span>{d.progress.total} for today</span>
                  </p>
                </div>
              )}
              <TaskList tasks={(d?.completedToday ?? []).slice(0, 5)} projects={ps} onOpen={openTask} compact
                empty="Nothing finished yet today." />
            </section>

            <section className="flex-1 rounded-[8px] border border-line bg-surface p-4" aria-labelledby="up-h">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 id="up-h" className="font-medium">Later this fortnight <span className="num text-muted">{d?.upcoming.length ?? 0}</span></h2>
                <Link to="/tasks" className="text-xs underline">All tasks</Link>
              </div>
              <TaskList tasks={(d?.upcoming ?? []).slice(0, 6)} projects={ps} selectedId={open} onOpen={openTask} compact
                empty="Nothing else due in the next two weeks." />
            </section>
          </div>
        </div>
      </div>
      {open && (
        <div className="w-[400px] flex-none border-l border-line bg-surface max-lg:fixed max-lg:inset-0 max-lg:z-20 max-lg:w-full">
          <TaskPanel key={open} id={open} projects={ps} onClose={() => openTask(null)} onOpen={openTask} />
        </div>
      )}
    </div>
  );
}
