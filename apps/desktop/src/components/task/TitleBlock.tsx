import { useEffect, useRef } from "react";
import { Globe, StickyNote } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { Check, ClaudeMark } from "../ui/Bits";
import type { TaskEdit } from "./useTaskEdit";

/** Text that edits in place and saves once, on blur or Enter. Escape puts the saved text back. */
function EditableTitle({ value, onCommit, as: Tag, done }: { value: string; onCommit: (v: string) => void; as: "h1" | "h2"; done: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Not controlled by React: the browser owns the text while it is being typed.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) el.textContent = value;
    else if (text !== value) onCommit(text);
  };
  return (
    <Tag ref={ref} className={`td-title ${done ? "is-done" : ""}`} contentEditable suppressContentEditableWarning spellCheck={false}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") { e.stopPropagation(); if (ref.current) ref.current.textContent = value; e.currentTarget.blur(); }
      }} />
  );
}

export function SourceLine({ t }: { t: TaskDetail }) {
  switch (t.source) {
    case "chrome": return <div className="src"><Globe size={12} />Captured in Chrome</div>;
    case "claude": return <div className="src"><ClaudeMark />Suggested by Claude · approved by you</div>;
    case "note": return <div className="src"><StickyNote size={12} />Made from a note</div>;
    case "ai": return <div className="src"><ClaudeMark />Suggested by local AI</div>;
    default: return <div className="src">Added by you</div>;
  }
}

/** Check + editable title + where the task came from. */
export function TitleBlock({ t, ed, as = "h2" }: { t: TaskDetail; ed: TaskEdit; as?: "h1" | "h2" }) {
  return (
    <>
      <div className="dtitle">
        <Check done={ed.done} high={t.priority === 3} label={ed.done ? "Reopen task" : "Complete task"} onToggle={() => ed.toggle.mutate(undefined)} disabled={ed.toggle.isPending} />
        <EditableTitle as={as} value={t.title} done={ed.done} onCommit={(title) => ed.patch.mutate({ title })} />
      </div>
      <SourceLine t={t} />
    </>
  );
}
