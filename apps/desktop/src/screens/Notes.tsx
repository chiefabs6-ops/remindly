import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import type { Note, NoteKind, Project } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { ago } from "../lib/format";
import { useAction, useNotes, useProjects } from "../lib/queries";

const KINDS: Record<NoteKind, string> = { general: "General", meeting: "Meeting", idea: "Idea", research: "Research", work: "Work" };

function Editor({ note, projects, onDeleted }: { note: Note; projects: Project[]; onDeleted: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ title: note.title, bodyMd: note.bodyMd, kind: note.kind, projectId: note.projectId ?? "" });
  useEffect(() => setF({ title: note.title, bodyMd: note.bodyMd, kind: note.kind, projectId: note.projectId ?? "" }), [note]);
  const save = useAction(() => api.updateNote(note.id, { ...f, projectId: f.projectId || null, tags: note.tags, taskId: note.taskId }));
  const convert = useAction(() => api.convertNote(note.id));
  const remove = useAction(() => api.deleteNote(note.id));
  const dirty = f.title !== note.title || f.bodyMd !== note.bodyMd || f.kind !== note.kind || (f.projectId || null) !== note.projectId;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <form className="mx-auto flex h-full max-w-[760px] flex-col gap-3 px-6 py-6"
      onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
      <label htmlFor="n-title" className="sr-only">Note title</label>
      <input id="n-title" className="bg-transparent text-xl font-semibold outline-none" placeholder="Untitled note" value={f.title} onChange={set("title")} />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="n-kind" className="sr-only">Kind</label>
        <select id="n-kind" className="field h-8 w-auto text-[13px]" value={f.kind} onChange={set("kind")}>
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label htmlFor="n-project" className="sr-only">Project</label>
        <select id="n-project" className="field h-8 w-auto text-[13px]" value={f.projectId} onChange={set("projectId")}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted">Edited {ago(note.updatedAt)}</span>
      </div>
      <label htmlFor="n-body" className="sr-only">Note</label>
      <textarea id="n-body" className="field min-h-[320px] flex-1 font-normal" value={f.bodyMd} onChange={set("bodyMd")}
        placeholder={"Write freely. Lines starting with “- ” become tasks when you convert the note."} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>Save note</button>
        <button type="button" className="btn" disabled={dirty || convert.isPending}
          title={dirty ? "Save first" : "One task per “- ” line, or one task from the title"}
          onClick={() => convert.mutate(undefined, { onSuccess: (ts) => navigate(`/tasks?task=${ts[0]?.id ?? ""}`) })}>
          Turn into tasks
        </button>
        <button type="button" className="btn btn-ghost btn-danger ml-auto"
          onClick={() => confirm(`Delete the note “${note.title || "Untitled"}”?`) && remove.mutate(undefined, { onSuccess: onDeleted })}>
          Delete
        </button>
      </div>
      {(save.isError || convert.isError) && <p className="text-negative">{errorMessage(save.error ?? convert.error)}</p>}
    </form>
  );
}

export function NotesScreen() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const projectFilter = params.get("project");
  const notes = useNotes({ query: q || null, projectId: projectFilter });
  const projects = useProjects();
  const list = notes.data ?? [];
  const selected = list.find((n) => n.id === params.get("note")) ?? list[0];
  const create = useAction(() => api.createNote({ title: "New note", bodyMd: "", projectId: projectFilter }));

  return (
    <div className="flex h-full">
      <div className="flex w-[320px] flex-none flex-col border-r border-line max-md:w-full">
        <header className="px-5 pt-6 pb-3">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-[-0.01em]">Notes</h1>
            <button className="btn px-2.5" aria-label="New note"
              onClick={() => create.mutate(undefined, { onSuccess: (n) => setParams({ note: n.id }) })}>
              <Plus size={15} /> New
            </button>
          </div>
          <label htmlFor="n-search" className="sr-only">Search notes</label>
          <input id="n-search" className="field mt-3 h-8" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </header>
        <ul className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Notes">
          {list.length === 0 && !notes.isLoading && (
            <li className="m-2 rounded-[8px] border border-dashed border-line p-3 text-muted">{q ? `No notes match “${q}”.` : "No notes yet. Start one with New."}</li>
          )}
          {list.map((n) => (
            <li key={n.id}>
              <button onClick={() => setParams({ note: n.id })}
                className={`block w-full rounded-[6px] px-3 py-2.5 text-left ${selected?.id === n.id ? "bg-active" : "hover:bg-raised"}`}>
                <span className="flex items-baseline gap-2">
                  <span className="flex-1 truncate font-medium">{n.title || "Untitled note"}</span>
                  <span className="flex-none text-xs text-muted">{ago(n.updatedAt)}</span>
                </span>
                <span className="block truncate text-[13px] text-muted">{KINDS[n.kind]} · {n.bodyMd.replace(/\s+/g, " ") || "Empty"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto max-md:hidden">
        {selected ? (
          <Editor key={selected.id} note={selected} projects={projects.data ?? []} onDeleted={() => setParams({})} />
        ) : (
          <p className="p-8 text-muted">Meeting notes, ideas and research live here. Pick one on the left or start a new one.</p>
        )}
      </div>
    </div>
  );
}
