// Ctrl+K command palette: one box that finds tasks, notes and projects and opens them.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { CheckCircle2, Circle, FolderKanban, NotebookPen, Search } from "lucide-react";
import { ago, dueLabel } from "../lib/format";
import { toneDot } from "../lib/colors";
import { useProjects, useSearch } from "../lib/queries";

const MAX = 8;

interface Row {
  key: string;
  group: "Tasks" | "Notes" | "Projects" | null;
  to: string;
  title: string;
  hint?: string;
  kind: "task" | "done" | "note" | "project" | "all";
  color?: string | null;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const projects = useProjects();
  const search = useSearch(q);

  // Debounce typing; remember where focus was so closing can give it back.
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 150);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const data = q ? search.data : undefined;
  const rows: Row[] = [];
  for (const t of (data?.tasks ?? []).slice(0, MAX)) {
    const done = t.status === "completed";
    const secondary = [done ? "Done" : dueLabel(t), t.projectId ? projectName.get(t.projectId) : undefined].filter(Boolean).join(" · ");
    rows.push({ key: `t-${t.id}`, group: "Tasks", to: `/task/${t.id}`, title: t.title, hint: secondary, kind: done ? "done" : "task" });
  }
  for (const n of (data?.notes ?? []).slice(0, MAX)) {
    rows.push({ key: `n-${n.id}`, group: "Notes", to: `/notes?note=${n.id}`, title: n.title || "Untitled note", hint: `Updated ${ago(n.updatedAt)}`, kind: "note" });
  }
  for (const p of (data?.projects ?? []).slice(0, MAX)) {
    rows.push({ key: `p-${p.id}`, group: "Projects", to: `/projects/${p.id}`, title: p.name, hint: `${p.openTasks} open`, kind: "project", color: p.color });
  }
  if (q) rows.push({ key: "all", group: null, to: `/tasks?q=${encodeURIComponent(q)}`, title: `Search all tasks for “${q}”`, kind: "all" });

  const current = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => setActive(0), [q, data]);
  useEffect(() => {
    listRef.current?.querySelector(`[id="${uid}-${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, uid]);

  const open = (r: Row) => {
    onClose();
    navigate(r.to);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((current + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[current]) open(rows[current]);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  const sections: { name: Row["group"]; rows: { r: Row; i: number }[] }[] = [];
  rows.forEach((r, i) => {
    const last = sections[sections.length - 1];
    if (last && last.name === r.group) last.rows.push({ r, i });
    else sections.push({ name: r.group, rows: [{ r, i }] });
  });
  const icon = { size: 15, strokeWidth: 1.6 };
  const status = !q ? "" : search.isError ? "Search failed." : !data ? "Searching…" : rows.length === 1 ? "No matches." : "";

  return createPortal(
    <div className="pal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} onKeyDown={onKeyDown}>
        <h2 id={`${uid}-title`} className="sr-only">Search</h2>
        <div className="pal-in">
          <Search size={15} aria-hidden />
          <input ref={inputRef} role="combobox" aria-expanded={!!q} aria-controls={`${uid}-list`} aria-autocomplete="list"
            aria-activedescendant={q && rows.length ? `${uid}-${current}` : undefined} aria-label="Search tasks, notes and projects"
            placeholder="Search tasks, notes and projects" autoComplete="off" spellCheck={false}
            value={text} onChange={(e) => setText(e.target.value)} />
          <kbd>Esc</kbd>
        </div>
        {!q ? (
          <p className="pal-hint">Type to find a task, note or project.</p>
        ) : (
          <>
            {status && <p className="pal-hint" role="status" aria-live="polite">{status}</p>}
            <div id={`${uid}-list`} ref={listRef} role="listbox" aria-label="Results" className="pal-list">
              {sections.map((sec) => (
                <div key={sec.name ?? "all"} role="group" aria-labelledby={sec.name ? `${uid}-g-${sec.name}` : undefined} aria-label={sec.name ? undefined : "More"}>
                  {sec.name && <div id={`${uid}-g-${sec.name}`} className="pal-gh">{sec.name}</div>}
                  {sec.rows.map(({ r, i }) => (
                    <div key={r.key} id={`${uid}-${i}`} role="option" aria-selected={i === current} className={`pal-row ${i === current ? "on" : ""} ${r.kind === "done" ? "done" : ""}`}
                      onMouseMove={() => i !== current && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => open(r)}>
                      {r.kind === "task" && <Circle {...icon} aria-hidden />}
                      {r.kind === "done" && <CheckCircle2 {...icon} aria-hidden />}
                      {r.kind === "note" && <NotebookPen {...icon} aria-hidden />}
                      {r.kind === "project" && <FolderKanban {...icon} aria-hidden style={{ color: toneDot(r.color) }} />}
                      {r.kind === "all" && <Search {...icon} aria-hidden />}
                      <span className="pal-t">{r.title}</span>
                      {r.hint && <small>{r.hint}</small>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
