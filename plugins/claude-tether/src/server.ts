// Tether MCP server for Claude Code (stdio). Read tools plus suggest-only write tools:
// nothing Claude sends becomes an active task, or changes one, until the user approves it in Tether.

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { chooseDir, describeRepo, rootFromUri, type RepoInfo } from "./project.js";
import { isGenericTitle } from "./generic.js";
import { TetherError, TetherOffline, call, dedupeKey, getMeeting, saveMeetingSummary, suggest, type SuggestResult } from "./tether.js";

const INSTRUCTIONS = `Tether is the user's personal task manager on this PC. Use it to hand off unfinished work.
- When the user stops for now ("that's enough for today", "we'll finish this tomorrow", "park this"), or work is left unfinished at the end of a task, call get_project_context first, then suggest_task (or suggest_task_update if a matching open task exists).
- Write tasks so the user can resume cold: what was done, what remains (concrete steps), why it matters, and where to continue (files, branch, commands). Never a generic reminder.
- Suggestions wait for approval on Tether's Today screen. Tell the user it was sent for approval, not that a task was created.
- Do not suggest tasks for work you just finished, or for trivial follow-ups.`;

const STATUS = z.enum(["inbox", "not_started", "in_progress", "waiting", "completed", "archived"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const TIME = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueDate: string | null;
  dueTime: string | null;
  projectId: string | null;
  subtaskCount: number;
  subtaskDone: number;
};

/** Short, token-cheap line per task. */
function line(t: TaskRow): string {
  const due = t.dueDate ? ` · due ${t.dueDate}${t.dueTime ? " " + t.dueTime : ""}` : "";
  const pri = t.priority ? ` · ${["", "low", "medium", "high"][t.priority]} priority` : "";
  const subs = t.subtaskCount ? ` · ${t.subtaskDone}/${t.subtaskCount} subtasks` : "";
  return `- [${t.id}] ${t.title} (${t.status.replace("_", " ")}${due}${pri}${subs})`;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

function failure(e: unknown) {
  if (e instanceof TetherOffline)
    return { ...text("Tether is not running on this PC. Ask the user to start Tether (Start menu) and try again."), isError: true };
  if (e instanceof TetherError) return { ...text(`Tether refused the request: ${e.message}`), isError: true };
  return { ...text(`Unexpected error: ${String(e)}`), isError: true };
}

export function createServer() {
  const server = new McpServer({ name: "tether", version: "0.1.0" }, { instructions: INSTRUCTIONS });


  async function repo(explicitDir?: string | null): Promise<RepoInfo> {
    let roots: string[] = [];
    // Ask for roots only if the client supports them, and never wait long: a client that
    // ignores the request must not hang the tool call.
    if (!explicitDir && server.server.getClientCapabilities()?.roots) {
      try {
        const r = await Promise.race([
          server.server.listRoots(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("roots timeout")), 1500)),
        ]);
        roots = r.roots.map((x) => rootFromUri(x.uri)).filter((x): x is string => !!x);
      } catch {
        /* fall back to CLAUDE_PROJECT_DIR / cwd */
      }
    }
    // Not cached: the branch is part of the resume hint and can change mid-session.
    return describeRepo(chooseDir({ explicit: explicitDir, roots }));
  }

  type Context = {
    codeProject: { id: string; name: string; rootDir: string; projectId: string | null };
    project: { id: string; name: string } | null;
    openTasks: TaskRow[];
    pendingSuggestions: { id: string; kind: string; payload: { title?: string }; targetTaskId: string | null }[];
  };

  async function context(dir?: string | null): Promise<{ info: RepoInfo; ctx: Context }> {
    const info = await repo(dir);
    const ctx = await call<Context>("/v1/code-projects/resolve", {
      method: "POST",
      body: { rootDir: info.rootDir, name: info.name, gitRemote: info.gitRemote },
    });
    return { info, ctx };
  }

  server.registerTool(
    "get_project_context",
    {
      title: "Tether: this repo's tasks",
      description:
        "Call before suggesting a task. Returns the Tether project this repository maps to, its open tasks (with ids) and Claude suggestions still awaiting approval, so you can avoid duplicates and update an existing task instead.",
      inputSchema: z.object({
        projectDir: z.string().optional().describe("Absolute repo folder; defaults to the current Claude Code project"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectDir }) => {
      try {
        const { info, ctx } = await context(projectDir);
        const out = [
          `Repository: ${info.name} (${info.rootDir})${info.branch ? `, branch ${info.branch}` : ""}`,
          `Tether project: ${ctx.project ? `${ctx.project.name} [${ctx.project.id}]` : "not linked yet (the user picks one when approving)"}`,
          "",
          `Open tasks (${ctx.openTasks.length}):`,
          ...(ctx.openTasks.length ? ctx.openTasks.map(line) : ["- none"]),
          "",
          `Awaiting approval (${ctx.pendingSuggestions.length}):`,
          ...(ctx.pendingSuggestions.length
            ? ctx.pendingSuggestions.map((s) => `- ${s.kind === "task_update" ? `update to ${s.targetTaskId}` : s.payload.title ?? s.kind}`)
            : ["- none"]),
        ];
        return text(out.join("\n"));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "search_tasks",
    {
      title: "Tether: search tasks",
      description: "Search the user's Tether tasks by words in the title, description or notes. Returns ids for get_task.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        status: z.array(STATUS).optional().describe("Defaults to open statuses"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, status, limit }) => {
      try {
        const st = (status?.length ? status : ["inbox", "not_started", "in_progress", "waiting"]).join(",");
        const rows = await call<TaskRow[]>(`/v1/tasks?q=${encodeURIComponent(query)}&status=${st}&limit=${limit ?? 20}`);
        return text(rows.length ? rows.map(line).join("\n") : `No tasks match "${query}".`);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Tether: one task",
      description: "Full details of one task: description, notes and context, subtasks, recent history.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const t = await call<TaskRow & { description: string | null; notes: string | null; subtasks: TaskRow[]; history: { at: string; action: string; field: string | null }[] }>(
          `/v1/tasks/${encodeURIComponent(id)}`,
        );
        return text(
          [
            line(t),
            t.description ? `\nDescription:\n${t.description}` : "",
            t.notes ? `\nNotes:\n${t.notes}` : "",
            t.subtasks.length ? `\nSubtasks:\n${t.subtasks.map(line).join("\n")}` : "",
            t.history.length ? `\nRecent history:\n${t.history.slice(0, 8).map((h) => `- ${h.at.slice(0, 16)} ${h.action}${h.field ? ` ${h.field}` : ""}`).join("\n")}` : "",
          ].join(""),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "Tether: projects",
      description: "The user's Tether projects with ids and open task counts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const ps = await call<{ id: string; name: string; openTasks: number }[]>("/v1/projects");
        return text(ps.length ? ps.map((p) => `- [${p.id}] ${p.name} (${p.openTasks} open)`).join("\n") : "No projects yet.");
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Tether: search notes",
      description: "Search the user's Tether notes (meeting notes, research, ideas).",
      inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const ns = await call<{ id: string; title: string; bodyMd: string; updatedAt: string }[]>(
          `/v1/notes?q=${encodeURIComponent(query)}&limit=${limit ?? 5}`,
        );
        if (!ns.length) return text(`No notes match "${query}".`);
        return text(ns.map((n) => `## ${n.title || "Untitled"} [${n.id}] (${n.updatedAt.slice(0, 10)})\n${n.bodyMd.slice(0, 1200)}`).join("\n\n"));
      } catch (e) {
        return failure(e);
      }
    },
  );

  /** Words the reply from what Tether actually did with the suggestion. */
  function outcome(r: SuggestResult, what: string): string {
    if (r.state === "spooled") return `Tether is closed, so ${what} was saved and will appear in Tether the next time Tether runs.`;
    if (r.status && r.status !== "pending")
      return `Tether already had this exact suggestion (it was ${r.status} earlier), so nothing new was sent.`;
    const dup = r.possibleDuplicateOf
      ? ` Tether flagged it as similar to existing task [${r.possibleDuplicateOf}]; if that is the same work, use suggest_task_update on it instead.`
      : "";
    return `Sent ${what} to Tether for approval. It takes effect only when the user approves it.${dup}`;
  }

  server.registerTool(
    "suggest_task",
    {
      title: "Tether: suggest a task",
      description:
        "Send a task to Tether for the user's approval (it does not become active until approved). Use for unfinished work. Must say what remains and where to resume.",
      inputSchema: z.object({
        title: z.string().min(3).max(200).describe("Specific action, e.g. 'Finish educator profile: validation + Irish translations'"),
        description: z.string().max(4000).optional().describe("What the work is and why it matters"),
        completed: z.array(z.string().max(500)).max(30).optional().describe("What is already done"),
        remaining: z.array(z.string().max(500)).min(1).max(30).describe("Concrete steps left"),
        why: z.string().max(1000).optional(),
        said: z
          .string()
          .max(500)
          .optional()
          .describe("The user's own words that showed the work is unfinished, quoted exactly (e.g. \"I'll finish this tomorrow\"). Omit if they said nothing like that."),
        resumeHint: z.string().min(3).max(2000).describe("Where to continue: files, branch, commands, failing test"),
        dueDate: DATE.optional().describe("Only if the user named a time ('tomorrow' → that date)"),
        dueTime: TIME.optional(),
        priority: z.number().int().min(0).max(3).optional().describe("0 none, 1 low, 2 medium, 3 high"),
        projectId: z.string().optional().describe("Tether project id, if known from get_project_context"),
        projectDir: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      if (isGenericTitle(a.title))
        return { ...text("Title is too generic. Name the actual work (e.g. 'Finish educator profile validation')."), isError: true };
      try {
        const info = await repo(a.projectDir);
        let codeProjectId: string | null = null;
        let mapped: string | null = null;
        try {
          const ctx = await context(a.projectDir);
          codeProjectId = ctx.ctx.codeProject.id;
          mapped = ctx.ctx.project?.id ?? null;
        } catch (e) {
          if (!(e instanceof TetherOffline)) throw e;
        }
        const title = a.title.trim();
        const payload: Record<string, unknown> = {
          title,
          description: a.description ?? null,
          dueDate: a.dueDate ?? null,
          dueTime: a.dueDate ? (a.dueTime ?? null) : null,
          priority: a.priority ?? null,
          projectId: a.projectId ?? mapped,
          // Offline: Tether resolves the repo when it imports the spooled file.
          ...(codeProjectId ? { codeProjectId } : { repo: { rootDir: info.rootDir, name: info.name, gitRemote: info.gitRemote } }),
        };
        const r = await suggest({
          kind: "task",
          origin: "claude",
          payload,
          context: {
            ...(a.said?.trim() ? { said: a.said.trim() } : {}),
            completed: a.completed ?? [],
            remaining: a.remaining,
            why: a.why ?? "",
            resumeHint: a.resumeHint,
            repository: `${info.name} (${info.rootDir})`,
            branch: info.branch ?? "",
          },
          dedupeKey: dedupeKey([info.rootDir, title, a.remaining]),
        });
        return text(outcome(r, `the task "${title}"`));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "suggest_task_update",
    {
      title: "Tether: suggest a change to a task",
      description:
        "Propose a change to an existing task (progress note, new due date, status, priority, or subtasks to add as a breakdown). Applied only after the user approves it in Tether. Use instead of creating a near-duplicate task.",
      inputSchema: z.object({
        taskId: z.string().min(1).max(64),
        appendNote: z.string().max(4000).optional().describe("Progress made / what remains, appended to the task notes"),
        status: STATUS.optional(),
        dueDate: DATE.nullable().optional().describe("New due date, or null to clear"),
        dueTime: TIME.nullable().optional(),
        priority: z.number().int().min(0).max(3).optional(),
        title: z.string().min(3).max(200).optional(),
        addSubtasks: z.array(z.string().min(3).max(200)).max(15).optional().describe("Concrete steps to add as subtasks (a breakdown)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId, ...changes }) => {
      const payload = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (!Object.keys(payload).length) return { ...text("Nothing to change."), isError: true };
      try {
        const r = await suggest({ kind: "task_update", origin: "claude", targetTaskId: taskId, payload, dedupeKey: dedupeKey([taskId, payload, new Date().toISOString().slice(0, 10)]) });
        return text(outcome(r, `the change to task ${taskId}`));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "suggest_note",
    {
      title: "Tether: suggest a note",
      description: "Save research, a decision or meeting notes to Tether (waits for the user's approval).",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(20000).describe("Markdown"),
        kind: z.enum(["general", "meeting", "idea", "research", "work"]).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title, body, kind }) => {
      try {
        const r = await suggest({
          kind: "note",
          origin: "claude",
          payload: { title, bodyMd: body, kind: kind ?? "general" },
          dedupeKey: dedupeKey(["note", title, body]),
        });
        return text(outcome(r, `the note "${title}"`));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "tether_get_meeting",
    {
      title: "Tether: get a meeting transcript",
      description:
        "Read one Google Meet meeting captured by Tether: title, times, summary status and the full transcript text (lines like \"[10:02] You: ...\"). \"You\" in the transcript is the user. Use it to write a summary, then call tether_save_meeting_summary.",
      inputSchema: z.object({ meetingId: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ meetingId }) => {
      try {
        const m = await getMeeting(meetingId);
        return text(
          [
            `Meeting: ${m.title || "Untitled"} [${m.id}]`,
            `Started: ${m.startedAt}`,
            `Ended: ${m.endedAt}`,
            `Summary status: ${m.summaryStatus}`,
            "",
            "Transcript:",
            m.transcript,
          ].join("\n"),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "tether_save_meeting_summary",
    {
      title: "Tether: save a meeting summary",
      description:
        "Save a summary and decisions into the meeting's note in Tether. actionItems must be ONLY the user's own: things said by \"You\" in the transcript, or asked of the user by someone else. Never list other people's tasks. Each action item arrives in Tether as a suggestion that waits for the user's approval; it does not become a task until approved.",
      inputSchema: z.object({
        meetingId: z.string().min(1).max(64),
        summary: z.string().min(1).max(4000).describe("3-6 sentences"),
        decisions: z.array(z.string().min(1).max(500)).max(20),
        actionItems: z
          .array(
            z.object({
              title: z.string().min(1).max(200).describe("Short imperative action for the user"),
              dueDate: DATE.optional().describe("Only if a date was said; resolve relative dates against the meeting date"),
              quote: z.string().max(500).optional().describe("The transcript line this came from"),
            }),
          )
          .max(30),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ meetingId, summary, decisions, actionItems }) => {
      try {
        const r = await saveMeetingSummary(meetingId, {
          summary,
          decisions,
          actionItems: actionItems.map((a) => ({ title: a.title.trim(), dueDate: a.dueDate ?? null, quote: a.quote ?? null })),
        });
        return text(
          `Saved the summary to the meeting note. ${r.suggestions} action item suggestion${r.suggestions === 1 ? " is" : "s are"} waiting for the user's approval in Tether.`,
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}

export async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && /server\.(m?js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
