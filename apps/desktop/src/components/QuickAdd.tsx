import { forwardRef, useMemo, useState } from "react";
import { parseQuickAdd, type Project, type TaskStatus } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { useAction } from "../lib/queries";

interface Props {
  projects: Project[];
  /** Default project for new tasks (e.g. on a project page). */
  projectId?: string | null;
  /** New tasks land in the inbox unless the screen says otherwise. */
  status?: TaskStatus;
  placeholder?: string;
  onCreated?: (id: string) => void;
}

const CHIP: Record<string, string> = { date: "Due", project: "Project", tag: "Tag", priority: "Priority" };
const PRI: Record<string, string> = { "3": "High", "2": "Medium", "1": "Low" };

/** One-line capture: "Call Niamh friday 3pm #admin @phone !high", Enter to save. */
export const QuickAdd = forwardRef<HTMLInputElement, Props>(function QuickAdd(
  { projects, projectId, status = "not_started", placeholder, onCreated },
  ref,
) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseQuickAdd(text, projects), [text, projects]);
  const create = useAction(() =>
    api.createTask({
      ...parsed.input,
      projectId: parsed.input.projectId ?? projectId ?? null,
      status,
    }),
  );

  const submit = () => {
    if (!parsed.input.title || create.isPending) return;
    create.mutate(undefined, {
      onSuccess: (t) => {
        setText("");
        onCreated?.(t.id);
      },
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="rounded-[8px] border border-line bg-surface"
    >
      <label htmlFor="quick-add" className="sr-only">
        Add a task
      </label>
      <input
        id="quick-add"
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          create.reset();
        }}
        onKeyDown={(e) => e.key === "Escape" && setText("")}
        placeholder={placeholder ?? "Add a task — try “Call Niamh friday 3pm #admin !high”"}
        className="h-11 w-full bg-transparent px-3 outline-none placeholder:text-faint"
        autoComplete="off"
      />
      {(text.trim() || create.isError) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2 text-xs">
          {parsed.parts.map((p) => (
            <span key={p.kind + p.text} className={p.kind === "date" ? "pill pill-today" : "pill"}>
              {CHIP[p.kind]}: {p.kind === "priority" ? PRI[p.value] : p.value}
            </span>
          ))}
          {parsed.unknownProjects.map((w) => (
            <span key={w} className="pill pill-warning">
              No single project matches #{w}
            </span>
          ))}
          {create.isError && <span className="text-negative">{errorMessage(create.error)}</span>}
          <span className="ml-auto text-muted">Enter to add · Esc to clear</span>
        </div>
      )}
    </form>
  );
});
