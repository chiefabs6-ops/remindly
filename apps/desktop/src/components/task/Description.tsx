import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { LinkedText } from "./LinkedText";
import type { TaskEdit } from "./useTaskEdit";

/**
 * Description: reads as normal text with clickable web links. Click the text (without selecting
 * any) or use the Edit button to change it. Saves once, when you leave the box; Escape cancels.
 */
export function Description({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const value = t.description ?? "";
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);

  const edit = () => { cancelled.current = false; setEditing(true); };

  if (!editing) {
    if (!value) {
      return <button type="button" className="desc desc-empty" onClick={edit}>Add a description</button>;
    }
    return (
      <div className="desc desc-view"
        // A plain click on the text edits it; selecting text to copy does not.
        onClick={() => { if (!window.getSelection()?.toString()) edit(); }}>
        <LinkedText text={value} />
        <button type="button" className="desc-edit" aria-label="Edit description" title="Edit description"
          onClick={(e) => { e.stopPropagation(); edit(); }}><Pencil size={13} strokeWidth={1.6} /></button>
      </div>
    );
  }
  return (
    <textarea ref={box} className="desc" aria-label="Description" placeholder="Add a description" rows={1} value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; setDraft(value); setEditing(false); }
      }}
      onBlur={() => {
        setEditing(false);
        if (cancelled.current) return;
        if (draft.trim() !== value.trim()) ed.patch.mutate({ description: draft.trim() || null });
      }} />
  );
}
