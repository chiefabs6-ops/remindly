// Quick view of one task beside the My Tasks list (mockup E): the essentials, then a way into the full page.
import { Link, useNavigate } from "react-router";
import { ChevronRight, Maximize2, X } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { useProjects, useTask } from "../lib/queries";
import { ClaudeContext } from "./task/ClaudeContext";
import { Description } from "./task/Description";
import { MoreMenu } from "./task/MoreMenu";
import { Properties } from "./task/Properties";
import { ReminderCard } from "./task/ReminderCard";
import { Subtasks } from "./task/Subtasks";
import { TitleBlock } from "./task/TitleBlock";
import { useTaskEdit } from "./task/useTaskEdit";

export interface QuickPanelProps {
  /** Task to show. */
  id: string;
  /** Close the panel (Esc, close button, scrim click). */
  onClose: () => void;
}

function Panel({ t, onClose }: { t: TaskDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const ed = useTaskEdit(t);
  const project = useProjects().data?.find((p) => p.id === t.projectId);
  const linkCount = t.links.length + (t.sourceUrl ? 1 : 0);
  const extra = [linkCount > 0 && `${linkCount} ${linkCount === 1 ? "link" : "links"}`, t.notes && "notes", `${t.history.length} ${t.history.length === 1 ? "update" : "updates"}`].filter(Boolean).join(" · ");
  return (
    <aside className="detail" aria-label="Task details" data-task={t.id}>
      <div className="dbar">
        {project
          ? <Link className="crumb" to={`/projects/${project.id}`}><i className="dot" style={{ background: toneDot(project.color) }} />{project.name}</Link>
          : <span className="crumb">No project</span>}
        <span className="sp" />
        <Link className="btn btn-sm btn-ghost" to={`/task/${t.id}`} title="Open full page (O)"><Maximize2 size={13} />Open</Link>
        <MoreMenu t={t} ed={ed} onDeleted={onClose} showOpen />
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Close details" title="Close (Esc)" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="dbody">
        <TitleBlock t={t} ed={ed} />
        <Description t={t} ed={ed} />
        <Properties t={t} ed={ed} />
        <ReminderCard t={t} ed={ed} />
        <Subtasks t={t} />
        <ClaudeContext t={t} />
        {ed.error && <p className="td-err">{errorMessage(ed.error)}</p>}
      </div>
      <div className="dfoot">
        <span>{extra}</span>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/task/${t.id}`)}>Full details <ChevronRight size={13} /></button>
      </div>
    </aside>
  );
}

export function QuickPanel({ id, onClose }: QuickPanelProps) {
  const q = useTask(id);
  if (q.isError) {
    return (
      <aside className="detail" aria-label="Task details" data-task={id}>
        <div className="dempty">
          <div>
            <p>This task no longer exists. {errorMessage(q.error)}</p>
            <button type="button" className="btn btn-sm mt-3" onClick={onClose}>Close</button>
          </div>
        </div>
      </aside>
    );
  }
  if (!q.data) {
    return <aside className="detail" aria-label="Task details" aria-busy="true" data-task={id}><div className="dbody"><div className="h-6 w-2/3 rounded bg-active" /></div></aside>;
  }
  return <Panel key={q.data.id} t={q.data} onClose={onClose} />;
}
