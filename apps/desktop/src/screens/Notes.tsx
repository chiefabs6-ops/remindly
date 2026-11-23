import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import type { Meeting, Note, NoteKind, Project } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { ago } from "../lib/format";
import { useAction, useMeetingForNote, useNotes, useProjects } from "../lib/queries";

const KINDS: Record<NoteKind, string> = { general: "General", meeting: "Meeting", idea: "Idea", research: "Research", work: "Work" };

function meetingFacts(m: Meeting): string {
  const mins = Math.max(1, Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 60_000));
  const date = new Date(m.startedAt).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `${date} · ${dur} · ${m.segmentCount} lines`;
}

/** Slim row above a meeting note: summary status, facts, and the optional Claude Code route. */
function MeetingBar({ meeting }: { meeting: Meeting }) {
  const [copied, setCopied] = useState(false);
  const retry = useAction(() => api.meetingResummarise(meeting.id));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`/tether:meeting ${meeting.id}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const st = meeting.summaryStatus;
  return (
    <div className="rounded-[8px] border border-line bg-raised px-3 py-2 text-[13px]" aria-label="Meeting summary">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(st === "pending" || st === "running") && <span>Summary on the way — the local AI is working on it</span>}
        {st === "failed" && (
          <>
            <span>Summary failed: {meeting.summaryError ?? "unknown error"}</span>
            <button type="button" className="btn btn-ghost h-7 px-2" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>
              Try again
            </button>
          </>
        )}
        {st === "off" && <span>Local AI is off — no summary yet</span>}
        {st === "done" && (
          <span>
            Summarised · <Link className="underline" to="/?approvals=1">{meeting.suggestionCount} action items in approvals</Link>
          </span>
        )}
        <button type="button" className="btn h-7 px-2" onClick={copy}>Summarise with Claude Code</button>
      </p>
      {copied && <p className="mt-1 text-muted">Copied — paste it in Claude Code. This sends the transcript to Claude.</p>}
      <p className="mt-1 text-xs text-muted">{meetingFacts(meeting)}</p>
    </div>
  );
}

function Editor({ note, projects, onDeleted }: { note: Note; projects: Project[]; onDeleted: () => void }) {
  const navigate = useNavigate();
  const meeting = useMeetingForNote(note.kind === "meeting" ? note.id : null);
  const [f, setF] = useState({ title: note.title, bodyMd: note.bodyMd, kind: note.kind, projectId: note.projectId ?? "" });
  // Follow outside changes (e.g. a meeting summary arriving) only while there are no unsaved edits.
  const synced = useRef(note);
  useEffect(() => {
    const old = synced.current;
    synced.current = note;
    setF((cur) =>
      cur.title === old.title && cur.bodyMd === old.bodyMd && cur.kind === old.kind && (cur.projectId || null) === old.projectId
        ? { title: note.title, bodyMd: note.bodyMd, kind: note.kind, projectId: note.projectId ?? "" }
        : cur,
    );
  }, [note]);
  const save = useAction(() => api.updateNote(note.id, { ...f, projectId: f.projectId || null, tags: note.tags, taskId: note.taskId }));
  const convert = useAction(() => api.convertNote(note.id));
  const remove = useAction(() => api.deleteNote(note.id));
  const dirty = f.title !== note.title || f.bodyMd !== note.bodyMd || f.kind !== note.kind || (f.projectId || null) !== note.projectId;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const lbl = "sr-only text-xs font-medium text-muted xl:not-sr-only xl:mb-1.5 xl:block";
  return (
    <form className="flex h-full flex-col xl:flex-row"
      onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-8 py-6">
        {meeting.data && <MeetingBar meeting={meeting.data} />}
        <label htmlFor="n-title" className="sr-only">Note title</label>
        <input id="n-title" className="bg-transparent text-xl font-semibold outline-none" placeholder="Untitled note" value={f.title} onChange={set("title")} />
        <label htmlFor="n-body" className="sr-only">Note</label>
        <textarea id="n-body" className="field min-h-[320px] flex-1 font-normal" value={f.bodyMd} onChange={set("bodyMd")}
          placeholder={"Write freely. Lines starting with “- ” become tasks when you convert the note."} />
      </div>
      <aside className="flex flex-wrap items-center gap-2 px-8 pb-6 xl:w-[280px] xl:flex-none xl:flex-col xl:items-stretch xl:gap-4 xl:overflow-y-auto xl:border-l xl:border-line xl:p-5">
        <div>
          <label htmlFor="n-kind" className={lbl}>Kind</label>
          <select id="n-kind" className="field h-8 w-auto text-[13px] xl:w-full" value={f.kind} onChange={set("kind")}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="n-project" className={lbl}>Project</label>
          <select id="n-project" className="field h-8 w-auto text-[13px] xl:w-full" value={f.projectId} onChange={set("projectId")}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <span className="text-xs text-muted max-xl:ml-auto">Edited {ago(note.updatedAt)}</span>
        <div className="flex w-full flex-wrap items-center gap-2 xl:flex-col xl:items-stretch xl:border-t xl:border-line xl:pt-4">
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>Save note</button>
          <button type="button" className="btn" disabled={dirty || convert.isPending}
            title={dirty ? "Save first" : "One task per “- ” line, or one task from the title"}
            onClick={() => convert.mutate(undefined, { onSuccess: (ts) => navigate(ts[0] ? `/task/${ts[0].id}` : "/tasks") })}>
            Turn into tasks
          </button>
          <button type="button" className="btn btn-ghost btn-danger max-xl:ml-auto"
            onClick={() => confirm(`Delete the note “${note.title || "Untitled"}”?`) && remove.mutate(undefined, { onSuccess: onDeleted })}>
            Delete
          </button>
        </div>
        {(save.isError || convert.isError) && <p className="w-full text-negative">{errorMessage(save.error ?? convert.error)}</p>}
      </aside>
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
