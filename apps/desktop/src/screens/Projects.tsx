import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { useAction, useProjects } from "../lib/queries";
import { TONES, toneDot, toneStyle } from "../lib/colors";

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
              className={`size-6 rounded-[6px] ${color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`} style={toneStyle(c)}>
              <span className="block size-full rounded-[6px]" style={{ boxShadow: `inset 0 0 0 6px ${"var(--surface)"}`, background: toneDot(c), opacity: 0 }} />
            </button>
          ))}
        </div>
      </fieldset>
      <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>{submitLabel}</button>
      {create.isError && <p className="w-full text-negative">{errorMessage(create.error)}</p>}
    </form>
  );
}

function Row({ p }: { p: Project }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const rename = useAction(() => api.updateProject(p.id, { name, color: p.color, description: p.description }));
  const archive = useAction(() => api.archiveProject(p.id, !p.archivedAt));
  const remove = useAction(() => api.deleteProject(p.id));
  return (
    <li className="flex min-h-12 items-center gap-3 border-b border-rule px-2 last:border-0">
      <span className="size-2.5 flex-none rounded-[3px]" style={{ background: toneDot(p.color) }} />
      {editing ? (
        <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
          <label htmlFor={`r-${p.id}`} className="sr-only">Project name</label>
          <input id={`r-${p.id}`} className="field h-8" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className="btn h-8">Save</button>
          <button type="button" className="btn btn-ghost h-8" onClick={() => { setEditing(false); setName(p.name); }}>Cancel</button>
        </form>
      ) : (
        <Link to={`/projects/${p.id}`} className={`flex-1 truncate ${p.archivedAt ? "text-muted" : "font-medium"}`}>{p.name}</Link>
      )}
      {p.archivedAt && <span className="pill">Archived</span>}
      <span className="num w-24 text-right text-muted">{p.openTasks} open</span>
      {!editing && (
        <div className="flex gap-1">
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
  const list = projects.data ?? [];
  const active = list.filter((p) => !p.archivedAt);
  return (
    <div className="mx-auto max-w-[960px] px-6 py-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">Projects</h1>
      <p className="mt-1 text-muted"><span className="num">{active.length}</span> active · <span className="num">{list.length - active.length}</span> archived</p>
      <div className="mt-5 rounded-[8px] border border-line bg-surface p-4"><ProjectForm /></div>
      <ul className="mt-4 rounded-[8px] border border-line bg-surface px-2" aria-label="Projects">
        {list.length === 0 && <li className="p-3 text-muted">No projects yet. Add your first one above.</li>}
        {list.map((p) => <Row key={p.id} p={p} />)}
      </ul>
      <CodeFolders projects={list} />
    </div>
  );
}
