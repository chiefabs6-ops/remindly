import { useEffect, useRef, useState } from "react";
import type { TaskDetail } from "@tether/core";
import type { TaskEdit } from "./useTaskEdit";

/** Description box: looks like text, saves once on blur. */
export function Description({ t, ed }: { t: TaskDetail; ed: TaskEdit }) {
  const value = t.description ?? "";
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <textarea className="desc" aria-label="Description" placeholder="Add a description" rows={1} value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        editing.current = false;
        if (draft.trim() !== value.trim()) ed.patch.mutate({ description: draft.trim() || null });
      }} />
  );
}
