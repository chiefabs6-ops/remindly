import { useEffect, useRef, useState } from "react";
import type { TaskDetail } from "@tether/core";
import { LinkedText } from "./LinkedText";
import type { TaskEdit } from "./useTaskEdit";

/**
 * Description: reads as text with clickable web links; click the text (or Tab to it and press Enter)
 * to edit it. Saves once, when you leave the box.
 */
export function Description({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const value = t.description ?? "";
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <div className="desc desc-view" role="button" tabIndex={0} aria-label={value ? "Description. Click to edit" : "Add a description"}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); setEditing(true); } }}>
        {value ? <LinkedText text={value} /> : <span className="faint">Add a description</span>}
      </div>
    );
  }
  return (
    <textarea ref={box} className="desc" aria-label="Description" placeholder="Add a description" rows={1} value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setDraft(value); setEditing(false); } }}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() !== value.trim()) ed.patch.mutate({ description: draft.trim() || null });
      }} />
  );
}
