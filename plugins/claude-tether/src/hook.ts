// SessionStart hook: tell Claude which Tether tasks are open for this repo.
// Must be fast and silent: any failure prints nothing and exits 0, so a session never breaks.

import { describeRepo } from "./project.js";
import { call } from "./tether.js";

type Ctx = {
  project: { name: string } | null;
  openTasks: { id: string; title: string; dueDate: string | null; status: string }[];
  pendingSuggestions: unknown[];
};

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function contextLine(cwd: string): Promise<string | null> {
  const info = await describeRepo(cwd);
  const ctx = await call<Ctx>("/v1/code-projects/resolve", {
    method: "POST",
    body: { rootDir: info.rootDir, name: info.name, gitRemote: info.gitRemote },
    timeoutMs: 1500,
  });
  if (!ctx.openTasks.length && !ctx.pendingSuggestions.length) return null;
  const tasks = ctx.openTasks
    .slice(0, 5)
    .map((t) => `${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""} [${t.id}]`)
    .join("; ");
  // Factual statements only, no instructions (hook output is treated as context).
  return [
    `Tether has ${ctx.openTasks.length} open task(s) for this repository${ctx.project ? ` (project ${ctx.project.name})` : ""}${tasks ? `: ${tasks}` : ""}.`,
    ctx.pendingSuggestions.length ? `${ctx.pendingSuggestions.length} Claude suggestion(s) for it await the user's approval.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function run() {
  try {
    const input = JSON.parse((await readStdin()) || "{}") as { cwd?: string };
    const line = await contextLine(input.cwd || process.cwd());
    if (line) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } }),
      );
    }
  } catch {
    /* Tether closed or not a repo: say nothing */
  }
  process.exit(0);
}

if (process.argv[1] && /hook\.(m?js|ts)$/.test(process.argv[1])) run();
