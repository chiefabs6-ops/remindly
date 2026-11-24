import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Code2 } from "lucide-react";
import type { Project } from "@tether/core";
import { SkeletonRows } from "../components/Skeleton";
import { api, errorMessage } from "../lib/api";
import { useAction, useProjects, useTasks } from "../lib/queries";
import { TONES, toneDot, toneOf, toneStyle } from "../lib/colors";
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

function ProjectLink({ id, archived, children }: { id: string; archived: boolean; children: React.ReactNode }) {
  return archived ? <div className="pj-li">{children}</div> : <Link to={`/projects/${id}`} className="pj-li">{children}</Link>;
}

function Row({ p, overdue, linked }: { p: Project; overdue: number; linked: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  // Keep "no colour" unless the user picks one; a rename must not save a colour they never chose.
  const [color, setColor] = useState<string | null>(p.color);
  const [description, setDescription] = useState(p.description ?? "");
  const save = useAction(() => api.updateProject(p.id, { name, color, description: description.trim() || null }));
  const archive = useAction(() => api.archiveProject(p.id, !p.archivedAt));
  const remove = useAction(() => api.deleteProject(p.id));
  const cancel = () => { setEditing(false); setName(p.name); setColor(p.color); setDescription(p.description ?? ""); };
  return (
    <li className={`pj-item ${p.archivedAt ? "archived" : ""}`}>
      {editing ? (
        <form className="pj-edit" aria-label={`Edit ${p.name}`} onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
          <div>
            <label htmlFor={`r-${p.id}`} className="label">Project name</label>
            <input id={`r-${p.id}`} className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label htmlFor={`d-${p.id}`} className="label">Description</label>
            <input id={`d-${p.id}`} className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this project is for" />
          </div>
          <fieldset>
            <legend className="label">Colour</legend>
            <div className="flex items-center gap-1.5">
              {PROJECT_COLORS.map((c) => {
                const on = toneOf(color) === toneOf(c);
                return (
                  <button key={c} type="button" aria-label={TONES.find((t) => t.ink === c)?.label} aria-pressed={on} onClick={() => setColor(c)}
                    className={`flex size-7 items-center justify-center rounded-[6px] text-[12px] font-semibold ${on ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`} style={toneStyle(c)}>
                    Aa
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={!name.trim() || save.isPending}>Save</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          {/* Archived projects have no page; their row is not a link. */}
          <ProjectLink id={p.id} archived={!!p.archivedAt}>
            <span className="t">
              <i className="dot" style={{ background: toneDot(p.color) }} aria-hidden="true" />
              <span className="name">{p.name}</span>
              {p.archivedAt && <span className="pill">Archived</span>}
            </span>
            <span className="m">
              <span className="num">{p.openTasks} open</span>
              <span className={`num ${overdue > 0 ? "od" : ""}`}>{overdue} overdue</span>
              {linked && <span className="r"><Code2 size={13} strokeWidth={1.6} aria-label="Claude Code repo linked" /></span>}
            </span>
          </ProjectLink>
          <div className="pj-acts">
            <button className="btn btn-ghost btn-sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-ghost btn-sm" aria-label={`${p.archivedAt ? "Restore" : "Archive"} ${p.name}`} onClick={() => archive.mutate(undefined)}>{p.archivedAt ? "Restore" : "Archive"}</button>
            <button className="btn btn-ghost btn-danger btn-sm" aria-label={`Delete ${p.name}`}
              onClick={() => confirm(`Delete “${p.name}”? Its ${p.openTasks} open tasks are kept and become unassigned.`) && remove.mutate(undefined)}>
              Delete
            </button>
          </div>
        </>
      )}
      {(save.isError || remove.isError || archive.isError) && <span className="pj-err">{errorMessage(save.error ?? remove.error ?? archive.error)}</span>}
    </li>
  );
}

function CodeFolders({ projects }: { projects: Project[] }) {
  const folders = useQuery({ queryKey: ["tether", "code-projects"], queryFn: api.codeProjects });
  const link = useAction(({ id, projectId }: { id: string; projectId: string | null }) => api.linkCodeProject(id, projectId));
  const list = folders.data ?? [];
  return (
    <section className="pj-sec" aria-labelledby="cf-h">
      <h2 id="cf-h">Claude Code folders</h2>
      <p className="lead">Folders you have opened in Claude Code. Link each to a project so its suggestions land there.</p>
      <ul className="pj-folders" aria-label="Claude Code folders">
        {list.length === 0 && <li className="pj-none">None yet. They appear after Claude Code first talks to Tether from a repo.</li>}
        {list.map((f) => (
          <li key={f.id} className="pj-folder">
            <div className="min-w-0 flex-1">
              <p className="name">{f.name}</p>
              <p className="dir">{f.rootDir}</p>
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
      {link.isError && <p className="pj-err">{errorMessage(link.error)}</p>}
    </section>
  );
}

/** Open tasks that are overdue, per project id. */
export function useOverdueByProject() {
  const openTasks = useTasks({ statuses: ["inbox", "not_started", "in_progress", "waiting"], topLevelOnly: true });
  const overdue = new Map<string, number>();
  for (const t of openTasks.data ?? []) {
    if (t.projectId && dueTone(t) === "overdue") overdue.set(t.projectId, (overdue.get(t.projectId) ?? 0) + 1);
  }
  return overdue;
}

/** Ids of projects that have a Claude Code repo linked. */
export function useLinkedProjectIds() {
  const folders = useQuery({ queryKey: ["tether", "code-projects"], queryFn: api.codeProjects });
  return new Set((folders.data ?? []).map((f) => f.projectId).filter((x): x is string => !!x));
}

export function ProjectsScreen() {
  const projects = useProjects(true);
  const overdue = useOverdueByProject();
  const linked = useLinkedProjectIds();
  const list = projects.data ?? [];
  const active = list.filter((p) => !p.archivedAt);
  return (
    <div className="pj-manage">
      <h1>Projects</h1>
      <p className="sum"><span className="num">{active.length}</span> active · <span className="num">{list.length - active.length}</span> archived</p>
      <div className="pj-new"><ProjectForm /></div>
      {projects.isPending && <SkeletonRows n={4} label="Loading projects" />}
      {projects.isSuccess && list.length === 0 && <p className="pj-none">No projects yet. Add your first one above.</p>}
      {projects.isError && <p className="pj-err">Couldn’t load projects: {errorMessage(projects.error)}</p>}
      <ul className="pj-list" aria-label="Projects">
        {list.map((p) => <Row key={p.id} p={p} overdue={overdue.get(p.id) ?? 0} linked={linked.has(p.id)} />)}
      </ul>
      <CodeFolders projects={list} />
    </div>
  );
}
