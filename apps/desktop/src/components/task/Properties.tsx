import { useState } from "react";
import { Calendar, CalendarCheck, CircleDot, Clock, Flag, Folder, Tag } from "lucide-react";
import { PRIORITY_LABEL, STATUS_LABEL, TASK_STATUSES, dayDiff, type Priority, type TaskDetail } from "@tether/core";
import { toneStyle } from "../../lib/colors";
import { dueTone, longDate, todayIso } from "../../lib/format";
import { useProjects } from "../../lib/queries";
import { Segmented } from "../ui/Controls";
import { Popover, usePopover } from "../ui/Popover";
import { ReschedulePopover } from "../ui/Reschedule";
import { CommitInput } from "./CommitInput";
import type { TaskEdit } from "./useTaskEdit";

const icon = { size: 14, strokeWidth: 1.6 };

function Bars({ p }: { p: Priority }) {
  return <span className={`pri pri-${p}`} style={{ height: 10 }} aria-hidden><i /><i /><i /></span>;
}

/** Due, Priority, Project, Status, Tags (and Do on, on the full page). */
export function Properties({ t, ed, full }: { t: TaskDetail; ed: TaskEdit; full?: boolean }) {
  const projects = useProjects();
  const due = usePopover();
  const proj = usePopover();
  const stat = usePopover();
  const doOn = usePopover();
  const pri = usePopover();
  // Empty time and "do on" fields show as plain buttons, not as empty browser date/time boxes.
  const [addingTime, setAddingTime] = useState(false);
  const today = todayIso();
  const tone = dueTone(t);
  const late = t.dueDate && t.status !== "completed" ? -dayDiff(today, t.dueDate) : 0;
  const project = projects.data?.find((p) => p.id === t.projectId);
  const choices = (projects.data ?? []).filter((p) => !p.archivedAt || p.id === t.projectId);

  return (
    <dl className="props">
      <dt><Calendar {...icon} />Due</dt>
      <dd>
        <button type="button" className="val" aria-label={`Due: ${t.dueDate ? longDate(t.dueDate) : "no date"}. Change`} aria-haspopup="dialog" onClick={(e) => due.open(e.currentTarget)}
          style={tone === "overdue" ? { color: "var(--negative)" } : tone === "today" ? { color: "var(--today)" } : undefined}>
          {t.dueDate ? longDate(t.dueDate) : <span className="muted">Add a date</span>}
        </button>
        {late > 0 && <span className="pill pill-negative">{late} {late === 1 ? "day" : "days"} late</span>}
        {t.dueDate && (t.dueTime || addingTime ? (
          <CommitInput type="time" className="tinput" aria-label="Due time" value={t.dueTime ?? ""} autoFocus={addingTime && !t.dueTime}
            onCommit={(v) => ed.patch.mutate({ dueTime: v || null })} onSettle={(v) => { if (!v) setAddingTime(false); }} />
        ) : (
          <button type="button" className="val muted" aria-label="Add due time" onClick={() => setAddingTime(true)}><Clock size={13} strokeWidth={1.6} />Add time</button>
        ))}
        {due.anchor && <ReschedulePopover anchor={due.anchor} value={t.dueDate} onPick={ed.reschedule} onClose={due.close} />}
      </dd>

      <dt><Flag {...icon} />Priority</dt>
      <dd>
        {full ? (
          // The full page's side card is narrow: a menu, like Project and Status.
          <>
            <button type="button" className="val" aria-label={`Priority: ${PRIORITY_LABEL[t.priority]}. Change`} aria-haspopup="menu" onClick={(e) => pri.open(e.currentTarget)}>
              {t.priority > 0 && <Bars p={t.priority} />}{PRIORITY_LABEL[t.priority]}
            </button>
            <Popover anchor={pri.anchor} onClose={pri.close} label="Priority" role="menu">
              {([3, 2, 1, 0] as Priority[]).map((p) => (
                <button key={p} type="button" role="menuitemradio" aria-checked={p === t.priority} className="pop-item"
                  onClick={() => { pri.close(); if (p !== t.priority) ed.setPriority(p); }}>
                  <Bars p={p} />{PRIORITY_LABEL[p]}
                </button>
              ))}
            </Popover>
          </>
        ) : (
          <Segmented<Priority> label="Priority" value={t.priority} onChange={ed.setPriority}
            options={([0, 1, 2, 3] as Priority[]).map((p) => ({ value: p, label: <>{p > 0 && <Bars p={p} />}{PRIORITY_LABEL[p]}</> }))} />
        )}
      </dd>

      <dt><Folder {...icon} />Project</dt>
      <dd>
        <button type="button" className="val" aria-label={`Project: ${project?.name ?? "none"}. Change`} aria-haspopup="menu" onClick={(e) => proj.open(e.currentTarget)}>
          {project ? <span className="chip" style={toneStyle(project.color)}>{project.name}</span> : <span className="muted">No project</span>}
        </button>
        <Popover anchor={proj.anchor} onClose={proj.close} label="Project" role="menu">
          <button type="button" role="menuitemradio" aria-checked={!t.projectId} className="pop-item" onClick={() => { proj.close(); ed.patch.mutate({ projectId: null }); }}>No project</button>
          {choices.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === t.projectId} className="pop-item"
              onClick={() => { proj.close(); ed.patch.mutate({ projectId: p.id }); }}>
              <span className="chip" style={toneStyle(p.color)}>{p.name}</span>
            </button>
          ))}
        </Popover>
      </dd>

      <dt><CircleDot {...icon} />Status</dt>
      <dd>
        <button type="button" className="val" aria-label={`Status: ${STATUS_LABEL[t.status]}. Change`} aria-haspopup="menu" onClick={(e) => stat.open(e.currentTarget)}>{STATUS_LABEL[t.status]}</button>
        <Popover anchor={stat.anchor} onClose={stat.close} label="Status" role="menu">
          {TASK_STATUSES.map((s) => (
            <button key={s} type="button" role="menuitemradio" aria-checked={s === t.status} className="pop-item"
              onClick={() => { stat.close(); if (s !== t.status) ed.setStatus.mutate(s); }}>{STATUS_LABEL[s]}</button>
          ))}
        </Popover>
      </dd>

      {full && (
        <>
          <dt><CalendarCheck {...icon} />Do on</dt>
          <dd>
            <button type="button" className="val" aria-label={`Do on: ${t.scheduledDate ? longDate(t.scheduledDate) : "not set"}. Change`} aria-haspopup="dialog"
              onClick={(e) => doOn.open(e.currentTarget)}>
              {t.scheduledDate ? longDate(t.scheduledDate) : <span className="muted">Not set</span>}
            </button>
            {doOn.anchor && (
              <ReschedulePopover anchor={doOn.anchor} value={t.scheduledDate} onClose={doOn.close}
                onPick={(d) => ed.patch.mutate({ scheduledDate: d })} />
            )}
          </dd>
        </>
      )}

      <dt><Tag {...icon} />Tags</dt>
      <dd><CommitInput className="tinput wide" aria-label="Tags" placeholder="Add tags" value={t.tags.join(", ")} onCommit={ed.saveTags} /></dd>
    </dl>
  );
}
