import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { useAction, useProjects, useTasks } from "../lib/queries";
import { TONES, toneStyle } from "../lib/colors";
import { dueTone } from "../lib/format";

/** Project tones (pale tile + dark ink); identity only, never data. */
export const PROJECT_COLORS = TONES.map((t) => t.ink);

export function ProjectForm({ onDone, submitLabel = "Add project" }: { onDone?: (p: Project) => void; submitLabel?: string }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const create = useAction(() => api.createProject({ name, color }));
  return (
    <form className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(undefined, { onSuccess: (p) => { setName(""); onDone?.(p); } }); }}>
      <div className="min-w-[220px] flex-1">
        <label className="label" htmlFor="p-name">Project name</label>
        <input id="p-name" className="field" value={name} onChange={(e) => { setName(e.target.value); create.reset(); }} placeholder="e.g. Website relaunch" />
      </div>
      <fieldset>
        <legend className="label">Colour</legend>
        <div className="flex h-9 items-center gap-1.5">
          {PROJECT_COLORS.map((c) => (
            <button key={c} type="button" aria-label={TONES.find((t) => t.ink === c)?.label} aria-pressed={color === c} onClick={() => setColor(c)}
              className={`flex size-7 items-center justify-center rounded-[6px] text-[12px] font-semibold ${color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`} style={toneStyle(c)}>
              Aa
            </button>
          ))}
        </div>
      </fieldset>
      <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>{submitLabel}</button>
      {create.isError && <p className="w-full text-negative">{errorMessage(create.error)}</p>}
    </form>
  );
}

function Card({ p, overdue }: { p: Project; overdue: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const rename = useAction(() => api.updateProject(p.id, { name, color: p.color, description: p.description }));
  const archive = useAction(() => api.archiveProject(p.id, !p.archivedAt));
  const remove = useAction(() => api.deleteProject(p.id));
  return (
    <li className={`relative flex min-h-36 flex-col gap-3 rounded-[12px] p-4 ${p.archivedAt ? "opacity-70" : ""}`} style={toneStyle(p.color)}>
      {editing ? (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
          <label htmlFor={`r-${p.id}`} className="sr-only">Project name</label>
          <input id={`r-${p.id}`} className="field h-8 min-w-0 flex-1 text-ink" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className="btn h-8">Save</button>
          <button type="button" className="btn btn-ghost h-8" onClick={() => { setEditing(false); setName(p.name); }}>Cancel</button>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <Link to={`/projects/${p.id}`} className="min-w-0 flex-1 truncate text-[16px] font-semibold after:absolute after:inset-0 after:rounded-[12px] after:content-['']">{p.name}</Link>
          {p.archivedAt && <span className="pill">Archived</span>}
        </div>
      )}
      <p className="num flex gap-3 text-[13px]">
        <span>{p.openTasks} open</span>
        <span className={overdue > 0 ? "font-medium text-negative" : "opacity-70"}>{overdue} overdue</span>
      </p>
      {!editing && (
        <div className="relative z-10 mt-auto flex flex-wrap gap-1 -ml-2">
          <button className="btn btn-ghost h-8" onClick={() => setEditing(true)}>Rename</button>
          <button className="btn btn-ghost h-8" onClick={() => archive.mutate(undefined)}>{p.archivedAt ? "Restore" : "Archive"}</button>
          <button className="btn btn-ghost btn-danger h-8"
            onClick={() => confirm(`Delete “${p.name}”? Its ${p.openTasks} open tasks are kept and become unassigned.`) && remove.mutate(undefined)}>
            Delete
          </button>
        </div>
      )}
      {(rename.isError || remove.isError) && <span className="text-negative">{errorMessage(rename.error ?? remove.error)}</span>}
    </li>
  );
}

function CodeFolders({ projects }: { projects: Project[] }) {
  const folders = useQuery({ queryKey: ["tether", "code-projects"], queryFn: api.codeProjects });
  const link = useAction(({ id, projectId }: { id: string; projectId: string | null }) => api.linkCodeProject(id, projectId));
  const list = folders.data ?? [];
  return (
    <section className="mt-8" aria-labelledby="cf-h">
      <h2 id="cf-h" className="font-medium">Claude Code folders</h2>
      <p className="mt-1 text-muted">Folders you have opened in Claude Code. Link each to a project so its suggestions land there.</p>
      <ul className="mt-3 rounded-[8px] border border-line bg-surface px-2" aria-label="Claude Code folders">
        {list.length === 0 && <li className="p-3 text-muted">None yet. They appear after Claude Code first talks to Tether from a repo.</li>}
        {list.map((f) => (
          <li key={f.id} className="flex min-h-12 items-center gap-3 border-b border-rule px-2 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{f.name}</p>
              <p className="truncate text-xs text-muted">{f.rootDir}</p>
            </div>
            <label htmlFor={`cf-${f.id}`} className="sr-only">Project for {f.name}</label>
            <select id={`cf-${f.id}`} className="field h-8 w-56 text-[13px]" value={f.projectId ?? ""}
              onChange={(e) => link.mutate({ id: f.id, projectId: e.target.value || null })}>
              <option value="">Not linked</option>
              {projects.filter((p) => !p.archivedAt).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {link.isError && <p className="mt-2 text-negative">{errorMessage(link.error)}</p>}
    </section>
  );
}

export function ProjectsScreen() {
  const projects = useProjects(true);
  const openTasks = useTasks({ statuses: ["inbox", "not_started", "in_progress", "waiting"], topLevelOnly: true });
  const list = projects.data ?? [];
  const active = list.filter((p) => !p.archivedAt);
  const overdue = new Map<string, number>();
  for (const t of openTasks.data ?? []) {
    if (t.projectId && dueTone(t) === "overdue") overdue.set(t.projectId, (overdue.get(t.projectId) ?? 0) + 1);
  }
  return (
    <div className="px-6 py-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">Projects</h1>
      <p className="mt-1 text-muted"><span className="num">{active.length}</span> active · <span className="num">{list.length - active.length}</span> archived</p>
      <div className="mt-5 rounded-[8px] border border-line bg-surface p-4"><ProjectForm /></div>
      {list.length === 0 && <p className="mt-4 rounded-[8px] border border-line bg-surface p-3 text-muted">No projects yet. Add your first one above.</p>}
      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="Projects">
        {list.map((p) => <Card key={p.id} p={p} overdue={overdue.get(p.id) ?? 0} />)}
      </ul>
      <CodeFolders projects={list} />
    </div>
  );
}
