import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { NotebookPen } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { ago } from "../../lib/format";
import { useNotes } from "../../lib/queries";
import type { TaskEdit } from "./useTaskEdit";

/** The task's own notes (saved on blur) and the notes linked to it. */
export function Notes({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const value = t.notes ?? "";
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const notes = useNotes({ taskId: t.id });
  const linked = (notes.data ?? []).filter((n) => n.taskId === t.id);
  return (
    <section className="sec" aria-labelledby="notes-h">
      <div className="sec-h">
        <span id="notes-h">Notes</span>{linked.length > 0 && <span className="c">· {linked.length} linked</span>}
      </div>
      <textarea className="notes" style={{ minHeight: 110 }} aria-labelledby="notes-h" placeholder="Add notes, decisions, anything you’ll need later" value={draft}
        onFocus={() => { editing.current = true; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          editing.current = false;
          if (draft.trim() !== value.trim()) ed.patch.mutate({ notes: draft.trim() || null });
        }} />
      {linked.length > 0 && (
        <ul className="links">
          {linked.map((n) => (
            <li key={n.id} className="lk">
              <Link to={`/notes?note=${n.id}`}><NotebookPen size={14} strokeWidth={1.6} /><span>{n.title || "Untitled note"}</span><small>{n.kind} · {ago(n.updatedAt)}</small></Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
