import { api } from "../lib/api";
import { useAction, useProjects } from "../lib/queries";
import { ProjectForm } from "./Projects";

/** First run: add real projects, then start. Shown until `onboarded` is set. */
export function WelcomeScreen() {
  const projects = useProjects();
  const finish = useAction(() => api.setSetting("onboarded", true));
  const list = projects.data ?? [];
  return (
    <div className="flex min-h-full items-start justify-center bg-ground px-6 py-16">
      <div className="w-full max-w-[640px]">
        <h1 className="text-2xl font-semibold tracking-[-0.01em]">Set up Tether</h1>
        <p className="mt-1 text-muted">Add the projects you work on. You can rename, add or archive them any time.</p>
        <div className="mt-6 rounded-[8px] border border-line bg-surface p-5">
          <ProjectForm />
          <ul className="mt-4" aria-label="Your projects">
            {list.map((p) => (
              <li key={p.id} className="flex h-9 items-center gap-2.5">
                <span className="size-2.5 rounded-full" style={{ background: p.color ?? "var(--faint)" }} />
                {p.name}
              </li>
            ))}
            {list.length === 0 && <li className="text-muted">No projects yet.</li>}
          </ul>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <button className="btn btn-primary" onClick={() => finish.mutate(undefined)} disabled={finish.isPending}>
            {list.length ? `Start with ${list.length} ${list.length === 1 ? "project" : "projects"}` : "Skip for now"}
          </button>
          <span className="text-xs text-muted">Ctrl N adds a task from anywhere in the app.</span>
        </div>
      </div>
    </div>
  );
}
