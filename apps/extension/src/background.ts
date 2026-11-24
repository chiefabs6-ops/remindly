// MV3 service worker: right-click "Create Task", offline queue, badge, popup messages.

import { captureKey, findDate, suggestFromSelection } from "@tether/core";
import {
  TetherClient,
  chromeStorage,
  allowMessage,
  failedToEvict,
  isStaleSession,
  upsertSession,
  type MeetMsg,
  type MeetSession,
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
      const failedMeetings = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(FAILED_PREFIX)).length;
      return { online, paired: !!token, repair, queued: queue.length, recent, pending, failedMeetings };
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

const FAILED_PREFIX = "meetFailed:";
const MEET_PREFIX = "meet:";

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
    const session = upsertSession(
      existing,
      {
        meetCode: str(msg.meetCode, 50),
        title: msg.title ? str(msg.title, 200) : null,
        startedAt: str(msg.startedAt, 40),
        segments: cleanSegments(msg.segments),
      },
      new Date().toISOString(),
    );
    await chrome.storage.local.set({ [MEET_PREFIX + msg.key]: session });
    return { ok: true as const };
  });
}

/**
 * Send the meeting (or queue it) and drop the session, all under the lock so a late segment message
 * cannot be lost. With `onlyIfStale` the quiet time is re-checked inside the lock. A meeting the app
 * rejects is kept under `meetFailed:<key>` (max 5) instead of being deleted.
 */
function finaliseMeeting(key: string, onlyIfStale = false): Promise<"sent" | "queued" | { error: string } | undefined> {
  return meetExclusive(async () => {
    const s = await getSession(key);
    if (!s) return { error: "No meeting in progress." };
    if (onlyIfStale && !isStaleSession(s.updatedAt, Date.now())) return undefined;
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
      if (typeof result === "object") {
        await chrome.storage.local.set({ [FAILED_PREFIX + key]: { failedAt: new Date().toISOString(), error: result.error, session: s } });
        const all = await chrome.storage.local.get(null);
        const entries = Object.entries(all)
          .filter(([k]) => k.startsWith(FAILED_PREFIX))
          .map(([k, v]) => ({ key: k, failedAt: String((v as { failedAt?: string }).failedAt ?? "") }));
        const drop = failedToEvict(entries);
        if (drop.length) await chrome.storage.local.remove(drop);
      }
    }
    await chrome.storage.local.remove(MEET_PREFIX + key);
    return result;
  });
}

/** Calls that ended without a "leave" message (tab closed, crash): finish them once quiet for 15 minutes. */
async function finaliseStaleMeetings() {
  const all = await chrome.storage.local.get(null);
  for (const k of Object.keys(all)) {
    if (k.startsWith(MEET_PREFIX)) await finaliseMeeting(k.slice(MEET_PREFIX.length), true);
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
  const who = allowMessage((msg as { type?: unknown } | null)?.type, sender, chrome.runtime.id);
  if (!who) return false;
  // "meet": our content script on a Meet tab (meet:* only). "popup": no tab, so a content script
  // cannot pair, unpair, flush or read status.
  const run: Promise<unknown> = who === "meet" ? handleMeet(msg as MeetMsg) : handle(msg as Msg);
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
