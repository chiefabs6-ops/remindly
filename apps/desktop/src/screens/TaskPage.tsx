import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AppWindow, ArrowLeft, CalendarClock, Check, RotateCcw } from "lucide-react";
import { type TaskDetail } from "@tether/core";
import { Activity } from "../components/task/Activity";
import { CapturedText, ClaudeContext } from "../components/task/ClaudeContext";
import { Description } from "../components/task/Description";
import { Links } from "../components/task/Links";
import { MoreMenu } from "../components/task/MoreMenu";
import { same } from "../components/task/model";
import { Notes } from "../components/task/Notes";
import { Properties } from "../components/task/Properties";
import { ReminderCard } from "../components/task/ReminderCard";
import { Subtasks } from "../components/task/Subtasks";
import { TitleBlock } from "../components/task/TitleBlock";
import { useTaskEdit } from "../components/task/useTaskEdit";
import { usePopover } from "../components/ui/Popover";
import { ReschedulePopover } from "../components/ui/Reschedule";
import { api, errorMessage } from "../lib/api";
import { isPopoutWindow } from "../lib/taskActions";
import { toneDot } from "../lib/colors";
import { ago } from "../lib/format";
import { useProjects, useTask } from "../lib/queries";

function Body({ t }: { t: TaskDetail }) {
  const navigate = useNavigate();
  const ed = useTaskEdit(t);
  const project = useProjects().data?.find((p) => p.id === t.projectId);
  const resched = usePopover();
  const { done } = ed;

  // Esc leaves the page, unless it is closing a menu or ending an edit (those handle Esc themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
      // A pop-out window shows just this task; Esc must not turn it into a second copy of the app.
      if (isPopoutWindow()) return;
      navigate("/tasks");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // The description is shown once when it only repeats the captured text.
  const hideDescription = !!t.description && same(t.description, t.sourceSelection);

  return (
    <article className="tp-page" aria-label="Task">
      <div className="tp-bar">
        <Link className="btn btn-sm btn-ghost" to="/tasks"><ArrowLeft size={14} />Back to My Tasks</Link>
        <div className="crumbs">
          {project && (
            <>
              <span className="faint">/</span>
              <Link className="crumb" to={`/projects/${project.id}`}><i className="dot" style={{ background: toneDot(project.color) }} />{project.name}</Link>
            </>
          )}
          <span className="faint">/</span><b>{t.title}</b>
        </div>
        <div className="acts">
          {!done && (
            <button type="button" className="btn btn-sm hide-m" aria-haspopup="dialog" onClick={(e) => resched.open(e.currentTarget)}><CalendarClock size={14} />Reschedule</button>
          )}
          {resched.anchor && <ReschedulePopover anchor={resched.anchor} value={t.dueDate} onPick={ed.reschedule} onClose={resched.close} />}
          <button type="button" className={`btn btn-sm ${done ? "" : "btn-primary"}`} disabled={ed.toggle.isPending} onClick={() => ed.toggle.mutate(undefined)}>
            {done ? <><RotateCcw size={13} />Reopen</> : <><Check size={13} />Mark done</>}
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon hide-m" title="Open in new window" aria-label="Open in new window"
            onClick={() => api.openTaskWindow(t.id).catch((e) => alert(errorMessage(e)))}><AppWindow size={15} /></button>
          <MoreMenu t={t} ed={ed} onDeleted={() => navigate("/tasks", { replace: true })} />
        </div>
      </div>

      <div className="tp">
        <div className="tp-head">
          {t.parentId && <p className="td-parent">Subtask of <Link className="underline" to={`/task/${t.parentId}`}>the parent task</Link></p>}
          <TitleBlock t={t} ed={ed} as="h1" />
        </div>

        <div className="tp-main">
          {!hideDescription && <Description t={t} ed={ed} />}
          <Subtasks t={t} />
          <ClaudeContext t={t} full />
          <CapturedText t={t} />
          <Notes t={t} ed={ed} />
          <Links t={t} />
          <Activity t={t} />
          {ed.error && <p className="td-err">{errorMessage(ed.error)}</p>}
        </div>

        <aside className="tp-side" aria-label="Properties">
          <div className="sec-h">Properties</div>
          <Properties t={t} ed={ed} full />
          <ReminderCard t={t} ed={ed} />
          {!done && (
            <div className="qa2">
              <button type="button" className="btn btn-sm" onClick={ed.tomorrow}>Tomorrow</button>
              <button type="button" className="btn btn-sm" onClick={ed.nextWeek}>Next week</button>
            </div>
          )}
          <div className="stamp"><span>Created {ago(t.createdAt)}</span><span>Updated {ago(t.updatedAt)}</span></div>
        </aside>
      </div>
    </article>
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const q = useTask(id);
  if (q.isError) {
    return (
      <div className="px-6 py-8 lg:px-10">
        <h1 className="text-[22px] font-semibold">Task not found</h1>
        <p className="mt-1 text-muted">It may have been deleted. {errorMessage(q.error)}</p>
        <Link to="/tasks" className="btn mt-4">Back to My Tasks</Link>
      </div>
    );
  }
  if (!q.data) return <div className="px-6 py-8 lg:px-10" aria-busy="true"><div className="h-8 w-2/3 rounded bg-active" /></div>;
  return <Body key={q.data.id} t={q.data} />;
}
