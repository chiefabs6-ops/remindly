// MV3 service worker: right-click "Create Task", offline queue, badge, popup messages.

import { captureKey, findDate, suggestFromSelection } from "@tether/core";
import { TetherClient, chromeStorage, type SuggestionBody } from "./client";

const client = new TetherClient(chromeStorage());
const MENU_ID = "tether-create-task";

async function updateBadge() {
  const [queue, token] = await Promise.all([client.queue(), client.token()]);
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
  | { type: "flush" };

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
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  // Only our own popup may drive the worker.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg)
    .then(async (r) => {
      await updateBadge();
      reply(r);
    })
    .catch((e) => reply({ error: String(e) }));
  return true; // async reply
});

// There are no content scripts, so nothing untrusted can read chrome.storage.local today.
// Where Chrome supports it, restrict the area to trusted contexts anyway.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch(() => {});
} catch {
  /* not supported for this area */
}
updateBadge();
