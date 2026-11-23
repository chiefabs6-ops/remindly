// MV3 service worker: right-click "Create Task", offline queue, badge, popup messages.

import { captureKey, findDate, suggestFromSelection } from "@tether/core";
import {
  MAX_MEET_SEGMENTS,
  TetherClient,
  chromeStorage,
  mergeSegments,
  type MeetMsg,
  type MeetSegment,
  type MeetingBody,
  type SuggestionBody,
} from "./client";

const client = new TetherClient(chromeStorage());
const MENU_ID = "tether-create-task";

async function updateBadge() {
  const [suggestions, meetings, token] = await Promise.all([client.queue(), client.meetQueue(), client.token()]);
  const queue = { length: suggestions.length + meetings.length };
  if (!token) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#92400e" });
    await chrome.action.setTitle({ title: "Tether: not paired — click to pair" });
  } else if (queue.length) {
    await chrome.action.setBadgeText({ text: String(queue.length) });
    await chrome.action.setBadgeBackgroundColor({ color: "#4d4d4d" });
    await chrome.action.setTitle({ title: `Tether: ${queue.length} waiting to send` });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Tether" });
  }
}

async function flash(text: string, color: string) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  // An alarm survives the worker being stopped; a setTimeout would not.
  chrome.alarms.create("badge", { when: Date.now() + 3000 });
}

function setup() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: "Create Task", contexts: ["selection"] });
  });
  // Retry the queue every minute (Chrome may run it less often while idle).
  chrome.alarms.create("flush", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  setup();
  updateBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  setup();
  await client.flush();
  updateBadge();
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "badge") return updateBadge();
  if (a.name !== "flush") return;
  await client.flush();
  await finaliseStaleMeetings().catch(() => undefined);
  updateBadge();
});

/** The full selection with line breaks; `info.selectionText` is whitespace-collapsed and may be cut. */
async function fullSelection(tabId: number | undefined, fallback: string): Promise<string> {
  if (tabId === undefined) return fallback;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? "",
    });
    const text = typeof r?.result === "string" ? r.result : "";
    return text.trim() ? text : fallback;
  } catch {
    // Pages like the Chrome Web Store or chrome:// cannot be scripted.
    return fallback;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = await fullSelection(tab?.id, info.selectionText ?? "");
  if (!text.trim()) return;
  const url = tab?.url ?? info.pageUrl ?? "";
  const s = suggestFromSelection(text, { url, title: tab?.title ?? null });
  const body: SuggestionBody = {
    kind: "task",
    origin: "chrome",
    payload: { ...s.payload },
    confidence: s.confidence,
    dedupeKey: await captureKey(url, text),
    capturedAt: new Date().toISOString(),
  };
  const r = await client.capture(body);
  if (r === "sent") await flash("✓", "#2e7d32");
  else if (r === "queued") await updateBadge();
  else await flash("×", "#c4242a");
});

// ---- popup messages ----

export type Msg =
  | { type: "status" }
  | { type: "pair"; code: string }
  | { type: "unpair" }
  | { type: "quick"; kind: "task" | "note"; text: string }
  | { type: "open" }
  | { type: "flush" }
  | { type: "meetOffer:get" }
  | { type: "meetOffer:set"; on: boolean };

async function quick(kind: "task" | "note", text: string) {
  const clean = text.trim();
  if (!clean) return { error: "Type something first." };
  let payload: Record<string, unknown>;
  if (kind === "task") {
    const found = findDate(clean);
    const title = found ? (clean.slice(0, found.index) + clean.slice(found.index + found.text.length)).replace(/\s+/g, " ").trim() : clean;
    payload = { title: title || clean, dueDate: found?.date ?? null, dueTime: found?.time ?? null };
  } else {
    const [first, ...rest] = clean.split("\n");
    payload = { title: first.slice(0, 120), bodyMd: rest.join("\n").trim(), kind: "general" };
  }
  return client.capture({
    kind,
    origin: "chrome",
    payload,
    dedupeKey: await captureKey(`popup:${kind}`, `${Date.now()} ${clean}`),
    capturedAt: new Date().toISOString(),
  });
}

async function handle(msg: Msg) {
  switch (msg.type) {
    case "status": {
      const [online, token, queue, recent, repair] = await Promise.all([
        client.health(),
        client.token(),
        client.queue(),
        client.recent(),
        client.needsRepair(),
      ]);
      const pending = online && token ? await client.pendingCount() : null;
      return { online, paired: !!token, repair, queued: queue.length, recent, pending };
    }
    case "pair":
      return client.pair(msg.code);
    case "unpair":
      await client.unpair();
      return { ok: true };
    case "quick":
      return quick(msg.kind, msg.text);
    case "open":
      return { ok: await client.openApp() };
    case "flush":
      return client.flush();
    case "meetOffer:get":
      return { on: (await chrome.storage.local.get("meetOffer")).meetOffer !== false };
    case "meetOffer:set":
      await chrome.storage.local.set({ meetOffer: msg.on === true });
      return { on: msg.on === true };
  }
}

// ---- Google Meet sessions ----
// The content script on meet.google.com cannot read chrome.storage.local, so every session lives here.

const STALE_MS = 15 * 60 * 1000;
const MEET_PREFIX = "meet:";

interface MeetSession {
  meetCode: string;
  title: string | null;
  startedAt: string;
  updatedAt: string;
  segments: MeetSegment[];
}

/** Serialises session read-modify-write (segment messages can arrive at the same time). */
let meetLock: Promise<unknown> = Promise.resolve();
function meetExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = meetLock.then(fn, fn);
  meetLock = run.catch(() => undefined);
  return run;
}

async function getSession(key: string): Promise<MeetSession | undefined> {
  const r = await chrome.storage.local.get(MEET_PREFIX + key);
  return r[MEET_PREFIX + key] as MeetSession | undefined;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function cleanSegments(raw: unknown): MeetSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: MeetSegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const text = str(o.text, 4000).trim();
    const id = str(o.id, 200);
    const at = str(o.at, 40);
    if (!text || !id || !at) continue;
    out.push({ id, speaker: str(o.speaker, 100).trim() || "Unknown", text, at });
  }
  return out;
}

function addSegments(msg: Extract<MeetMsg, { type: "meet:segments" }>): Promise<{ ok: true }> {
  return meetExclusive(async () => {
    const existing = await getSession(msg.key);
    const session: MeetSession = {
      meetCode: existing?.meetCode ?? str(msg.meetCode, 50),
      title: msg.title ? str(msg.title, 200) : (existing?.title ?? null),
      startedAt: existing?.startedAt ?? str(msg.startedAt, 40),
      updatedAt: new Date().toISOString(),
      segments: mergeSegments(existing?.segments ?? [], cleanSegments(msg.segments), MAX_MEET_SEGMENTS),
    };
    await chrome.storage.local.set({ [MEET_PREFIX + msg.key]: session });
    return { ok: true as const };
  });
}

/** Send the meeting (or queue it) and drop the session. Skips empty sessions. */
function finaliseMeeting(key: string): Promise<"sent" | "queued" | { error: string }> {
  return meetExclusive(async () => {
    const s = await getSession(key);
    if (!s) return { error: "No meeting in progress." };
    let result: "sent" | "queued" | { error: string } = { error: "No captions were captured." };
    if (s.segments.length) {
      const body: MeetingBody = {
        dedupeKey: `${MEET_PREFIX}${key}`,
        meetCode: s.meetCode,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: new Date().toISOString(),
        segments: s.segments.map(({ speaker, text, at }) => ({ speaker, text, at })),
      };
      result = await client.captureMeeting(body);
    }
    await chrome.storage.local.remove(MEET_PREFIX + key);
    return result;
  });
}

/** Calls that ended without a "leave" message (tab closed, crash): finish them once quiet for 15 minutes. */
async function finaliseStaleMeetings() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(MEET_PREFIX)) continue;
    const updated = Date.parse((v as MeetSession | undefined)?.updatedAt ?? "");
    if (Number.isNaN(updated) || now - updated > STALE_MS) await finaliseMeeting(k.slice(MEET_PREFIX.length));
  }
}

async function handleMeet(msg: MeetMsg) {
  switch (msg.type) {
    case "meet:config": {
      const [offer, token] = await Promise.all([chrome.storage.local.get("meetOffer"), client.token()]);
      return { offer: offer.meetOffer !== false, paired: !!token };
    }
    case "meet:segments":
      if (typeof msg.key !== "string" || !msg.key) return { error: "bad key" };
      return addSegments(msg);
    case "meet:end":
      if (typeof msg.key !== "string" || !msg.key) return { error: "bad key" };
      return { result: await finaliseMeeting(msg.key) };
  }
}

chrome.runtime.onMessage.addListener((msg: Msg | MeetMsg, sender, reply) => {
  // Only our own extension pages and our Meet content script may drive the worker.
  if (sender.id !== chrome.runtime.id) return false;
  const type = (msg as { type?: unknown } | null)?.type;
  let run: Promise<unknown>;
  if (typeof type === "string" && type.startsWith(MEET_PREFIX)) {
    // Content script: only from a Meet tab, and only the meet:* messages.
    if (!sender.tab?.url?.startsWith("https://meet.google.com/")) return false;
    run = handleMeet(msg as MeetMsg);
  } else {
    // Popup: no tab. A content script must not be able to pair, unpair, flush or read status.
    if (sender.tab !== undefined) return false;
    run = handle(msg as Msg);
  }
  run
    .then(async (r) => {
      await updateBadge();
      reply(r);
    })
    .catch((e) => reply({ error: String(e) }));
  return true; // async reply
});

// The Meet content script runs in an isolated world and cannot read chrome.storage.local: keep the
// area restricted to trusted contexts so it can never read the token or other sessions.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch(() => {});
} catch {
  /* not supported for this area */
}
updateBadge();
