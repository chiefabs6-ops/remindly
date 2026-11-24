import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { parseQuickAdd, PRIORITY_LABEL, relativeDayLabel, type Priority, type Project, type TaskStatus } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { toneStyle } from "../lib/colors";
import { todayIso } from "../lib/format";
import { useAction } from "../lib/queries";

interface Props {
  projects: Project[];
  /** Default project for new tasks (e.g. on a project page). */
  projectId?: string | null;
  /** New tasks land in the inbox unless the screen says otherwise. */
  status?: TaskStatus;
  placeholder?: string;
  onCreated?: (id: string) => void;
  /** Put this text in the box and focus it (change `n` to send the same text again). */
  prefill?: { text: string; n: number } | null;
}

const CHIP: Record<string, string> = { date: "Due", project: "Project", tag: "Tag", priority: "Priority" };

/** One-line capture: "Call Niamh friday 3pm #admin !high", Enter to save. Parsed parts show as chips in the box. */
export const QuickAdd = forwardRef<HTMLInputElement, Props>(function QuickAdd(
  { projects, projectId, status = "not_started", placeholder, onCreated, prefill },
  ref,
) {
  const [text, setText] = useState("");
  const inner = useRef<HTMLInputElement | null>(null);
  const parsed = useMemo(() => parseQuickAdd(text, projects), [text, projects]);
  const create = useAction(() =>
    api.createTask({
      ...parsed.input,
      projectId: parsed.input.projectId ?? projectId ?? null,
      status,
    }),
  );

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    inner.current?.focus();
  }, [prefill]);

  const submit = () => {
    if (!parsed.input.title || create.isPending) return;
    create.mutate(undefined, {
      onSuccess: (t) => {
        setText("");
        onCreated?.(t.id);
      },
    });
  };

  const today = todayIso();
  const project = parsed.input.projectId ? projects.find((p) => p.id === parsed.input.projectId) : undefined;
  const priority = (parsed.input.priority ?? 0) as Priority;
  const dueText = parsed.input.dueDate
    ? relativeDayLabel(parsed.input.dueDate, today) + (parsed.input.dueTime ? ` ${parsed.input.dueTime}` : "")
    : null;
  const showChips = !!text.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="qa"
    >
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      <label htmlFor="quick-add" className="sr-only">
        Add a task
      </label>
      <input
        id="quick-add"
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          create.reset();
        }}
        onKeyDown={(e) => e.key === "Escape" && setText("")}
        placeholder={placeholder ?? "Add a task — try “Call Niamh fri 3pm #admin !high”"}
        autoComplete="off"
      />
      {showChips && (
        <div className="qa-parse" aria-hidden="true">
          {dueText && <span className="pill pill-today">{dueText}</span>}
          {project && <span className="chip" style={toneStyle(project.color)}>{project.name}</span>}
          {priority > 0 && <span className={priority === 3 ? "pill pill-warning" : "pill"}>{PRIORITY_LABEL[priority]}</span>}
          {parsed.unknownProjects.map((w) => <span key={w} className="pill pill-warning">#{w}?</span>)}
        </div>
      )}
      {/* Same facts for screen readers (the chips above are decoration). */}
      <div className="sr-only" role="status">
        {parsed.parts.map((p) => (
          <span key={p.kind + p.text}>{CHIP[p.kind]}: {p.kind === "priority" ? PRIORITY_LABEL[Number(p.value) as Priority] : p.value}</span>
        ))}
        {parsed.unknownProjects.map((w) => <span key={w}>No single project matches #{w}</span>)}
      </div>
      {create.isError && <p className="qa-err">{errorMessage(create.error)}</p>}
    </form>
  );
});
