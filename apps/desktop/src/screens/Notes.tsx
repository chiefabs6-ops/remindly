import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, Check, Ellipsis, Link2, ListChecks, Plus, Trash2, Video } from "lucide-react";
import type { Meeting, Note, NoteKind, Project, SuggestedTask, Suggestion } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { toneDot } from "../lib/colors";
import { dueLabel } from "../lib/format";
import { keys, queryClient, useAction, useMeetingForNote, useNotes, useProjects, useSuggestions, useTask, useTasks } from "../lib/queries";
import { Popover, usePopover } from "../components/ui/Popover";

const KINDS: Record<NoteKind, string> = { general: "General", meeting: "Meeting", idea: "Idea", research: "Research", work: "Work" };
const KIND_CHIPS: (NoteKind | null)[] = [null, "meeting", "work", "research", "idea", "general"];

const shortDate = (ts: string) => new Date(ts).toLocaleDateString("en-IE", { day: "numeric", month: "short" });
const fullDate = (ts: string) => new Date(ts).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });

function meetingMinutes(m: Meeting): number {
  return Math.max(1, Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 60_000));
}

function meetingFacts(m: Meeting): string {
  const mins = meetingMinutes(m);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `${fullDate(m.startedAt)} · ${dur} · ${m.segmentCount} lines`;
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
    <div className="nt-meeting rounded-[8px] border border-line bg-raised px-3 py-2 text-[13px]" aria-label="Meeting summary">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(st === "pending" || st === "running") && <span>Summary on the way — the local AI is working on it</span>}
        {st === "failed" && (
          <>
            <span>Summary failed: {meeting.summaryError ?? "unknown error"}</span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>
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
        <button type="button" className="btn btn-sm" onClick={copy}>Summarise with Claude Code</button>
      </p>
      {copied && <p className="mt-1 text-muted">Copied — paste it in Claude Code. This sends the transcript to Claude.</p>}
      <p className="mt-1 text-xs text-muted">{meetingFacts(meeting)}</p>
    </div>
  );
}

interface ActionItem { text: string; who: string | null; done: boolean; dueDate: string | null }

/** Lines under an "Action items" heading in the note body. "(Name) text" marks someone else's item;
 *  a trailing "(due YYYY-MM-DD)" (as meeting summaries write it) becomes the due date. */
export function actionItems(body: string): ActionItem[] {
  const out: ActionItem[] = [];
  let inSection = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s*action items\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (!m || !m[2].trim()) continue;
    const who = /^\(([^)]+)\)\s*(.*)$/.exec(m[2]);
    let text = (who ? who[2] : m[2]).trim();
    const due = /\s*\(due (\d{4}-\d{2}-\d{2})\)\s*$/i.exec(text);
    if (due) text = text.slice(0, due.index).trim();
    out.push({ done: m[1] === "x" || m[1] === "X", who: who ? who[1] : null, text, dueDate: due ? due[1] : null });
  }
  return out;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One of your action items. Meeting summaries already send your items to the Inbox as suggestions,
 * so the row points there instead of making a second task; an item that already has a task links to it.
 * Both are looked up from the data, so the state survives leaving the note.
 */
function ActionItemRow({ a, note, pending }: { a: ActionItem; note: Note; pending: Suggestion[] }) {
  const existing = useTasks({ query: a.text, topLevelOnly: true, limit: 20 });
  const task = existing.data?.find((t) => same(t.title, a.text));
  const suggestion = pending.find((s) => s.kind === "task" && same(String((s.payload as SuggestedTask).title ?? ""), a.text));
  const make = useAction(() => api.createTask({ title: a.text, dueDate: a.dueDate, projectId: note.projectId }));
  return (
    <div className="nt-ai">
      <span>{a.text}</span>
      <small>{a.who ?? "You"}{a.dueDate ? ` · due ${a.dueDate}` : ""}</small>
      {task ? (
        <Link className="pill pill-positive" to={`/task/${task.id}`} style={{ textDecoration: "none" }}><Check size={12} />Task</Link>
      ) : a.done ? (
        <span className="text-xs text-muted">Done</span>
      ) : a.who ? (
        <span className="text-xs text-muted">Not yours</span>
      ) : suggestion ? (
        <Link className="pill" to={`/inbox?s=${suggestion.id}`} style={{ textDecoration: "none" }}>In Inbox</Link>
      ) : (
        <button type="button" className="btn btn-sm" disabled={make.isPending || existing.isLoading} aria-label={`Make task: ${a.text}`}
          onClick={() => make.mutate(undefined)}>Make task</button>
      )}
    </div>
  );
}

function ActionItems({ note }: { note: Note }) {
  const items = actionItems(note.bodyMd);
  const pending = useSuggestions("pending");
  if (items.length === 0) return null;
  return (
    <div className="sec" aria-label="Action items">
      <div className="sec-h">Action items<span className="c num">{items.length}</span></div>
      {items.map((a) => <ActionItemRow key={`${a.who ?? ""}|${a.text}`} a={a} note={note} pending={pending.data ?? []} />)}
    </div>
  );
}

/** Pick a task to link the note to. */
function TaskPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const tasks = useTasks({ query: q || null, statuses: ["not_started", "in_progress", "waiting"], topLevelOnly: true, limit: 8 });
  return (
    <div style={{ width: 280 }}>
      <input className="field h-8" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-1.5">
        {(tasks.data ?? []).slice(0, 8).map((t) => (
          <button key={t.id} type="button" className="pop-item nt-pick" onClick={() => onPick(t.id)}>
            <span className="truncate">{t.title}</span>
          </button>
        ))}
        {tasks.data?.length === 0 && <p className="px-2 py-1.5 text-[13px] text-muted">No tasks match.</p>}
      </div>
    </div>
  );
}

function LinkedTask({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  if (!task.data) return null;
  const due = dueLabel(task.data);
  return (
    <Link className="nt-linked" to={`/task/${taskId}`} aria-label={`Linked task: ${task.data.title}`}>
      <ListChecks size={15} strokeWidth={1.6} />
      <span>{task.data.title}</span>
      {due && <small>{due}</small>}
    </Link>
  );
}

type Patch = Partial<{ title: string; bodyMd: string; kind: NoteKind; projectId: string | null; taskId: string | null }>;

function Editor({ note, projects, onBack, onDeleted }: { note: Note; projects: Project[]; onBack: () => void; onDeleted: () => void }) {
  const navigate = useNavigate();
  const meeting = useMeetingForNote(note.kind === "meeting" ? note.id : null);
  const [f, setF] = useState({ title: note.title, bodyMd: note.bodyMd });
  // Follow outside changes (e.g. a meeting summary arriving) only while there are no unsaved edits.
  const synced = useRef(note);
  useEffect(() => {
    const old = synced.current;
    synced.current = note;
    setF((cur) => (cur.title === old.title && cur.bodyMd === old.bodyMd ? { title: note.title, bodyMd: note.bodyMd } : cur));
  }, [note]);

  // Latest text and note in refs, so a save on leave or after a running save uses what is on screen.
  const latest = useRef({ f, note });
  latest.current = { f, note };
  const inputOf = (patch: Patch) => {
    const { f: cur, note: n } = latest.current;
    return { title: cur.title, bodyMd: cur.bodyMd, kind: n.kind, projectId: n.projectId, taskId: n.taskId, tags: n.tags, ...patch };
  };
  const again = useRef(false);
  const save = useAction((patch: Patch) => api.updateNote(note.id, inputOf(patch)));
  const convert = useAction(async () => {
    if (isDirty()) await api.updateNote(note.id, inputOf({}));
    return api.convertNote(note.id);
  });
  const remove = useAction(() => api.deleteNote(note.id));
  const isDirty = () => latest.current.f.title !== latest.current.note.title || latest.current.f.bodyMd !== latest.current.note.bodyMd;
  const dirty = f.title !== note.title || f.bodyMd !== note.bodyMd;
  // Never drop a save: if one is running, run another when it finishes.
  const saveText = () => {
    if (!isDirty()) return;
    if (save.isPending) { again.current = true; return; }
    save.mutate({}, { onSettled: () => { if (again.current) { again.current = false; if (isDirty()) save.mutate({}); } } });
  };
  // Autosave shortly after typing stops, and save whatever is left when the note is closed.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(saveText, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.title, f.bodyMd]);
  useEffect(() => () => {
    // Refresh the cache afterwards, so a stale copy of this note can never be saved over it.
    if (isDirty()) void api.updateNote(latest.current.note.id, inputOf({})).then(() => queryClient.invalidateQueries({ queryKey: keys.all })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kindPop = usePopover();
  const projPop = usePopover();
  const morePop = usePopover();
  const linkPop = usePopover();
  const project = projects.find((p) => p.id === note.projectId);

  return (
    <>
      <div className="tp-bar nt-bar">
        <button type="button" className="btn btn-sm btn-ghost back-m" onClick={onBack}><ArrowLeft size={15} />Notes</button>
        <button type="button" className="pill" aria-label="Kind" aria-haspopup="menu" onClick={(e) => kindPop.open(e.currentTarget)}>{KINDS[note.kind]}</button>
        <Popover anchor={kindPop.anchor} onClose={kindPop.close} label="Kind" role="menu">
          {(Object.keys(KINDS) as NoteKind[]).map((k) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={k === note.kind} className="pop-item"
              onClick={() => { kindPop.close(); if (k !== note.kind) save.mutate({ kind: k }); }}>{KINDS[k]}</button>
          ))}
        </Popover>
        <button type="button" className="btn btn-sm btn-ghost" aria-label="Project" aria-haspopup="menu" onClick={(e) => projPop.open(e.currentTarget)}>
          {project ? <><i className="dot" style={{ background: toneDot(project.color) }} />{project.name}</> : <span className="text-muted">No project</span>}
        </button>
        <Popover anchor={projPop.anchor} onClose={projPop.close} label="Project" role="menu">
          <button type="button" role="menuitemradio" aria-checked={!note.projectId} className="pop-item"
            onClick={() => { projPop.close(); save.mutate({ projectId: null }); }}>No project</button>
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === note.projectId} className="pop-item"
              onClick={() => { projPop.close(); save.mutate({ projectId: p.id }); }}>
              <i className="dot" style={{ background: toneDot(p.color) }} />{p.name}
            </button>
          ))}
        </Popover>
        <div className="acts">
          <button type="button" className="btn btn-sm hide-m" disabled={convert.isPending}
            title="One task per “- ” line, or one task from the title"
            onClick={() => convert.mutate(undefined, { onSuccess: (ts) => navigate(ts[0] ? `/task/${ts[0].id}` : "/tasks") })}>
            <ListChecks size={14} />Turn lines into tasks
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="More actions" aria-haspopup="menu" onClick={(e) => morePop.open(e.currentTarget)}>
            <Ellipsis size={16} />
          </button>
          <Popover anchor={morePop.anchor} onClose={morePop.close} label="More actions" role="menu">
            <button type="button" role="menuitem" className="pop-item"
              onClick={() => {
                const el = morePop.anchor;
                morePop.close();
                if (note.taskId) save.mutate({ taskId: null });
                else if (el) linkPop.open(el);
              }}>
              <Link2 size={15} strokeWidth={1.6} />{note.taskId ? "Unlink task" : "Link to task"}
            </button>
            <hr className="pop-sep" />
            <button type="button" role="menuitem" className="pop-item danger"
              onClick={() => {
                morePop.close();
                if (confirm(`Delete the note “${note.title || "Untitled"}”?`)) remove.mutate(undefined, { onSuccess: onDeleted });
              }}>
              <Trash2 size={15} strokeWidth={1.6} />Delete
            </button>
          </Popover>
          <Popover anchor={linkPop.anchor} onClose={linkPop.close} label="Link to task">
            <TaskPicker onPick={(id) => { linkPop.close(); save.mutate({ taskId: id }); }} />
          </Popover>
        </div>
      </div>
      <div className="nt-ne">
        <label htmlFor="n-title" className="sr-only">Note title</label>
        <input id="n-title" className="nt-title" placeholder="Untitled note" spellCheck={false} value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })} onBlur={saveText}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <div className="nt-meta">
          <span>{fullDate(note.createdAt)}</span>
          {meeting.data && <span className="inline-flex items-center gap-1">· <Video size={12} /> Google Meet captions · {meetingMinutes(meeting.data)} min</span>}
          <span>· Edited {shortDate(note.updatedAt)}</span>
          {dirty && <span>· Unsaved</span>}
        </div>
        {meeting.data && <MeetingBar meeting={meeting.data} />}
        <label htmlFor="n-body" className="sr-only">Note</label>
        <textarea id="n-body" className="nt-body" value={f.bodyMd} onChange={(e) => setF({ ...f, bodyMd: e.target.value })} onBlur={saveText}
          placeholder={"Write freely. Lines starting with “- ” become tasks when you convert the note."} />
        <ActionItems note={note} />
        {note.taskId && <LinkedTask taskId={note.taskId} />}
        {(save.isError || convert.isError) && <p className="mt-3 text-negative">{errorMessage(save.error ?? convert.error)}</p>}
      </div>
    </>
  );
}

export function NotesScreen() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<NoteKind | null>(null);
  const projectFilter = params.get("project");
  const notes = useNotes({ query: q || null, projectId: projectFilter });
  const projects = useProjects();
  const all = notes.data ?? [];
  const list = kind ? all.filter((n) => n.kind === kind) : all;
  const selected = all.find((n) => n.id === params.get("note"));
  const create = useAction(() => api.createNote({ title: "New note", bodyMd: "", projectId: projectFilter }));
  const keep = (extra: Record<string, string>) => {
    const next: Record<string, string> = { ...extra };
    if (projectFilter) next.project = projectFilter;
    setParams(next);
  };

  return (
    <div className={`nt-split ${selected ? "has-item" : ""}`}>
      <div className="nt-lp">
        <div className="nt-lp-h">
          <div className="flex items-center gap-2">
            <h1>Notes</h1>
            <button type="button" className="btn btn-sm" onClick={() => create.mutate(undefined, { onSuccess: (n) => keep({ note: n.id }) })}>
              <Plus size={14} />New note
            </button>
          </div>
          <label htmlFor="n-search" className="sr-only">Search notes</label>
          <input id="n-search" className="field mt-3 h-8" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="nt-kinds" role="group" aria-label="Kind">
            {KIND_CHIPS.map((k) => (
              <button key={k ?? "all"} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{k ? KINDS[k] : "All"}</button>
            ))}
          </div>
        </div>
        <ul aria-label="Notes">
          {list.length === 0 && !notes.isLoading && (
            <li className="nt-empty">{q || kind ? "No notes match." : "No notes yet. Start one with New note."}</li>
          )}
          {list.map((n) => {
            const p = projects.data?.find((x) => x.id === n.projectId);
            return (
              <li key={n.id}>
                <button type="button" className={`nt-li ${selected?.id === n.id ? "on" : ""}`} onClick={() => keep({ note: n.id })}>
                  <span className="t">
                    {n.kind === "meeting" && <span className="muted flex" aria-label="Meeting"><Video size={13} /></span>}
                    <span>{n.title || "Untitled note"}</span>
                  </span>
                  <span className="m">
                    {p && <><i className="dot" style={{ background: toneDot(p.color) }} />{p.name}</>}
                    <span className="r">{shortDate(n.updatedAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="nt-rp">
        {selected ? (
          <Editor key={selected.id} note={selected} projects={projects.data ?? []} onBack={() => keep({})} onDeleted={() => keep({})} />
        ) : (
          <div className="dempty">Pick a note, or start a new one.</div>
        )}
      </div>
    </div>
  );
}
