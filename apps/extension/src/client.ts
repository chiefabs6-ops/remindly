// Talks to the Tether desktop app's local API and keeps an offline queue.
// Pure logic with injected storage/fetch so it can be unit-tested outside Chrome.

export const API = "http://127.0.0.1:47821";
const MAX_QUEUE = 200;
const MAX_MEET_QUEUE = 20;
const MAX_RECENT = 10;
export const MAX_MEET_SEGMENTS = 5000;

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface SuggestionBody {
  kind: "task" | "note";
  origin: "chrome";
  payload: Record<string, unknown>;
  confidence?: Record<string, number> | null;
  dedupeKey: string;
  /** When the user captured it; kept while queued so Tether shows the real time. */
  capturedAt: string;
}

export interface Queued {
  body: SuggestionBody;
  addedAt: string;
  attempts: number;
  lastError?: string;
}

/** One caption line from Google Meet. `at` = RFC3339 time it was first seen. */
export interface MeetSegment {
  id: string;
  speaker: string;
  text: string;
  at: string;
}

/** Content script -> background messages (content script runs only on meet.google.com). */
export type MeetMsg =
  | { type: "meet:config" }
  | { type: "meet:segments"; key: string; meetCode: string; title: string | null; startedAt: string; segments: MeetSegment[] }
  | { type: "meet:end"; key: string };

/** Body of POST /v1/meetings. */
export interface MeetingBody {
  dedupeKey: string;
  meetCode: string;
  title: string | null;
  startedAt: string;
  endedAt: string;
  segments: { speaker: string; text: string; at: string }[];
}

export interface MeetQueued {
  body: MeetingBody;
  addedAt: string;
  attempts: number;
  lastError?: string;
}

/** Add new segments to a session by id (later copy wins), keep order by `at`, cap the size (newest kept). */
export function mergeSegments(existing: MeetSegment[], incoming: MeetSegment[], cap = MAX_MEET_SEGMENTS): MeetSegment[] {
  const byId = new Map<string, MeetSegment>();
  for (const s of existing) byId.set(s.id, s);
  for (const s of incoming) byId.set(s.id, s);
  // Array.sort is stable, so equal times keep their first-seen order.
  const all = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export interface Recent {
  title: string;
  at: string;
  state: "sent" | "queued" | "rejected";
  key: string;
}

export type SendResult =
  | { ok: true }
  | { ok: false; retry: true; reason: "offline" | "server" }
  | { ok: false; retry: false; reason: "unpaired" | "rejected"; message: string };

function meetTitle(b: MeetingBody): string {
  return `Meeting: ${b.title?.trim() || b.meetCode}`;
}

export class TetherClient {
  /** Serialises queue/recent read-modify-write cycles (capture vs flush vs alarm). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private storage: Storage,
    // Wrapped: calling the native fetch as a method of this object throws "Illegal invocation" in Chrome.
    private fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** True after Tether refused our token (unpaired from the app): the popup asks to pair again. */
  async needsRepair(): Promise<boolean> {
    return (await this.storage.get<boolean>("needsRepair")) === true;
  }

  private async lostPairing() {
    await this.storage.set("token", undefined);
    await this.storage.set("needsRepair", true);
  }

  async token(): Promise<string | undefined> {
    return this.storage.get<string>("token");
  }

  /** Exchange the 6-digit code shown in Tether's settings for the API token. */
  async pair(code: string, opts: { flush?: boolean } = {}): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const res = await this.fetchFn(`${API}/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.token !== "string") {
        return { ok: false, message: data.message ?? `Pairing failed (${res.status})` };
      }
      await this.storage.set("token", data.token);
      await this.storage.set("needsRepair", undefined);
      // The popup leaves flushing to the worker (one queue owner, one lock).
      if (opts.flush !== false) await this.flush();
      return { ok: true };
    } catch {
      return { ok: false, message: "Tether isn't running. Open it on this PC and try again." };
    }
  }

  async unpair(): Promise<void> {
    await this.storage.set("token", undefined);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    return this.fetchFn(`${API}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}`, ...(init.headers ?? {}) },
    });
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${API}/v1/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  send(body: SuggestionBody): Promise<SendResult> {
    return this.post("/v1/suggestions", body);
  }

  sendMeeting(body: MeetingBody): Promise<SendResult> {
    return this.post("/v1/meetings", body);
  }

  private async post(path: string, body: unknown): Promise<SendResult> {
    if (!(await this.token())) return { ok: false, retry: false, reason: "unpaired", message: "Not paired with Tether" };
    let res: Response;
    try {
      res = await this.request(path, { method: "POST", body: JSON.stringify(body) });
    } catch {
      return { ok: false, retry: true, reason: "offline" };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      await this.lostPairing();
      return { ok: false, retry: false, reason: "unpaired", message: "Tether no longer accepts this browser. Pair again." };
    }
    if (res.status >= 500) return { ok: false, retry: true, reason: "server" };
    const data = await res.json().catch(() => ({}));
    return { ok: false, retry: false, reason: "rejected", message: data.message ?? `Rejected (${res.status})` };
  }

  async queue(): Promise<Queued[]> {
    return (await this.storage.get<Queued[]>("queue")) ?? [];
  }

  async meetQueue(): Promise<MeetQueued[]> {
    return (await this.storage.get<MeetQueued[]>("meetQueue")) ?? [];
  }

  async recent(): Promise<Recent[]> {
    return (await this.storage.get<Recent[]>("recent")) ?? [];
  }

  private async remember(title: string, key: string, state: Recent["state"]) {
    const list = (await this.recent()).filter((r) => r.key !== key);
    list.unshift({ title, key, state, at: new Date().toISOString() });
    await this.storage.set("recent", list.slice(0, MAX_RECENT));
  }

  /**
   * Send now, or queue for later if Tether is closed / not paired yet.
   * Returns what happened so the UI can say "Sent" or "Saved — will send when Tether is open".
   */
  capture(body: SuggestionBody): Promise<"sent" | "queued" | { error: string }> {
    return this.exclusive(() => this.captureNow(body));
  }

  private async captureNow(body: SuggestionBody): Promise<"sent" | "queued" | { error: string }> {
    const title = String(body.payload.title ?? "Note");
    const r = await this.send(body);
    if (r.ok) {
      await this.remember(title, body.dedupeKey, "sent");
      return "sent";
    }
    if (r.retry || r.reason === "unpaired") {
      const q = (await this.queue()).filter((x) => x.body.dedupeKey !== body.dedupeKey);
      q.push({ body, addedAt: new Date().toISOString(), attempts: 1, lastError: r.reason });
      await this.storage.set("queue", q.slice(-MAX_QUEUE));
      await this.remember(title, body.dedupeKey, "queued");
      return "queued";
    }
    return { error: r.message };
  }

  /** Retry everything queued. Items the server rejects as invalid are dropped (they would never succeed). */
  flush(): Promise<{ sent: number; left: number; dropped: number }> {
    return this.exclusive(async () => {
      const a = await this.flushNow();
      const b = await this.flushMeetNow();
      return { sent: a.sent + b.sent, left: a.left + b.left, dropped: a.dropped + b.dropped };
    });
  }

  private async flushNow(): Promise<{ sent: number; left: number; dropped: number }> {
    const q = await this.queue();
    if (!q.length || !(await this.token())) return { sent: 0, left: q.length, dropped: 0 };
    const left: Queued[] = [];
    let sent = 0;
    let dropped = 0;
    for (const item of q) {
      const r = await this.send(item.body);
      if (r.ok) {
        sent++;
        await this.remember(String(item.body.payload.title ?? "Note"), item.body.dedupeKey, "sent");
      } else if (r.retry || r.reason === "unpaired") {
        left.push({ ...item, attempts: item.attempts + 1, lastError: r.reason });
        if (r.reason === "offline") {
          // Tether is down: keep the rest in order without hammering it.
          left.push(...q.slice(q.indexOf(item) + 1));
          break;
        }
      } else {
        dropped++;
        await this.remember(String(item.body.payload.title ?? "Note"), item.body.dedupeKey, "rejected");
      }
    }
    await this.storage.set("queue", left);
    return { sent, left: left.length, dropped };
  }

  private async flushMeetNow(): Promise<{ sent: number; left: number; dropped: number }> {
    const q = await this.meetQueue();
    if (!q.length || !(await this.token())) return { sent: 0, left: q.length, dropped: 0 };
    const left: MeetQueued[] = [];
    let sent = 0;
    let dropped = 0;
    for (const item of q) {
      const r = await this.sendMeeting(item.body);
      const title = meetTitle(item.body);
      if (r.ok) {
        sent++;
        await this.remember(title, item.body.dedupeKey, "sent");
      } else if (r.retry || r.reason === "unpaired") {
        left.push({ ...item, attempts: item.attempts + 1, lastError: r.reason });
        if (r.reason === "offline") {
          left.push(...q.slice(q.indexOf(item) + 1));
          break;
        }
      } else {
        dropped++;
        await this.remember(title, item.body.dedupeKey, "rejected");
      }
    }
    await this.storage.set("meetQueue", left);
    return { sent, left: left.length, dropped };
  }

  /** Send a finished meeting now, or queue it (separate queue, max 20) if Tether is closed / not paired. */
  captureMeeting(body: MeetingBody): Promise<"sent" | "queued" | { error: string }> {
    return this.exclusive(() => this.captureMeetingNow(body));
  }

  private async captureMeetingNow(body: MeetingBody): Promise<"sent" | "queued" | { error: string }> {
    const title = meetTitle(body);
    const r = await this.sendMeeting(body);
    if (r.ok) {
      await this.remember(title, body.dedupeKey, "sent");
      return "sent";
    }
    if (r.retry || r.reason === "unpaired") {
      const q = (await this.meetQueue()).filter((x) => x.body.dedupeKey !== body.dedupeKey);
      q.push({ body, addedAt: new Date().toISOString(), attempts: 1, lastError: r.reason });
      await this.storage.set("meetQueue", q.slice(-MAX_MEET_QUEUE));
      await this.remember(title, body.dedupeKey, "queued");
      return "queued";
    }
    return { error: r.message };
  }

  async pendingCount(): Promise<number | null> {
    try {
      const res = await this.request("/v1/suggestions?status=pending&limit=200");
      if (!res.ok) return null;
      return ((await res.json()) as unknown[]).length;
    } catch {
      return null;
    }
  }

  async openApp(): Promise<boolean> {
    try {
      return (await this.request("/v1/open", { method: "POST", body: "{}" })).ok;
    } catch {
      return false;
    }
  }
}

/** chrome.storage.local wrapped to the Storage interface. */
export function chromeStorage(): Storage {
  return {
    async get<T>(key: string) {
      const r = await chrome.storage.local.get(key);
      return r[key] as T | undefined;
    },
    async set(key, value) {
      if (value === undefined) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: value });
    },
  };
}
