// Client for the Tether desktop app's local API, used by the MCP server and the SessionStart hook.
// Reads the token from Tether's data folder on every call, so a rotated token is picked up.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const API = process.env.TETHER_API ?? "http://127.0.0.1:47821";

export function dataDir(): string {
  if (process.env.TETHER_DATA_DIR) return process.env.TETHER_DATA_DIR;
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "AppData", "Roaming");
  return join(appData, "ie.tether.app");
}

export class TetherOffline extends Error {
  constructor() {
    super("Tether isn't running on this PC.");
  }
}

export class TetherError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function token(): Promise<string> {
  try {
    return (await readFile(join(dataDir(), "token"), "utf8")).trim();
  } catch {
    throw new TetherOffline();
  }
}

export async function call<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const t = await token();
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
    });
  } catch {
    throw new TetherOffline();
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new TetherError(res.status, data?.message ?? `Tether returned ${res.status}`);
  return data as T;
}

export interface MeetingDetail {
  id: string;
  noteId: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string;
  summaryStatus: string;
  transcript: string;
}

export interface MeetingSummaryInput {
  summary: string;
  decisions: string[];
  actionItems: { title: string; dueDate: string | null; quote: string | null }[];
}

export function getMeeting(id: string): Promise<MeetingDetail> {
  // Transcripts can be large; allow more time than a normal call.
  return call<MeetingDetail>(`/v1/meetings/${encodeURIComponent(id)}`, { timeoutMs: 15000 });
}

export function saveMeetingSummary(id: string, body: MeetingSummaryInput): Promise<{ ok: boolean; suggestions: number }> {
  return call<{ ok: boolean; suggestions: number }>(`/v1/meetings/${encodeURIComponent(id)}/summary`, {
    method: "POST",
    body,
    timeoutMs: 15000,
  });
}

export interface NewSuggestion {
  kind: "task" | "task_update" | "note";
  origin: "claude";
  targetTaskId?: string | null;
  payload: Record<string, unknown>;
  context?: Record<string, unknown> | null;
  dedupeKey: string;
}

export function dedupeKey(parts: unknown[]): string {
  return "claude:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/**
 * Send a suggestion; if Tether is closed, write it to the spool folder Tether imports on start.
 * Returns "sent" with the created suggestion, or "spooled".
 */
export type SuggestResult =
  | { state: "sent"; id: string; status: string; possibleDuplicateOf: string | null }
  | { state: "spooled"; file: string; status?: undefined; possibleDuplicateOf?: undefined };

export async function suggest(s: NewSuggestion): Promise<SuggestResult> {
  try {
    const created = await call<{ id: string; status: string; possibleDuplicateOf: string | null }>("/v1/suggestions", {
      method: "POST",
      body: s,
    });
    return { state: "sent", id: created.id, status: created.status, possibleDuplicateOf: created.possibleDuplicateOf };
  } catch (e) {
    if (!(e instanceof TetherOffline)) throw e;
    const dir = join(dataDir(), "spool");
    await mkdir(dir, { recursive: true });
    // Time-ordered names keep capture order; write then rename so Tether never reads half a file.
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${s.dedupeKey.slice(-8)}.json`;
    const tmp = join(dir, `${name}.tmp`);
    await writeFile(tmp, JSON.stringify(s), "utf8");
    await rename(tmp, join(dir, name));
    return { state: "spooled", file: name };
  }
}
