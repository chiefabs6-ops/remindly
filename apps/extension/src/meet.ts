// Content script for https://meet.google.com/*. Reads live captions (when the user opts in) and sends them to the
// background. It cannot read chrome.storage; all state lives in the background. Never log caption text.
// Content scripts cannot be ES modules: keep imports to ./meet-parse only (single-entry code is inlined by the bundler).
import {
  CaptionTracker,
  SELECTORS,
  findCaptionsOnButton,
  findCaptionsRegion,
  findLeaveButton,
  meetCodeFromUrl,
  readBlocksFromRegion,
  titleFromDocument,
} from "./meet-parse";

const SESSION_KEY = "tether:meet:session";
const SEND_EVERY_MS = 5000;
const NO_CAPTIONS_MS = 2 * 60 * 1000;
const POLL_MS = 2000;
const LEFT_POLLS = 3;

interface Session {
  meetCode: string;
  startedAt: string;
}

let session: (Session & { key: string }) | null = null;
let tracker: CaptionTracker | null = null;
const lastSent = new Map<string, string>();
let observer: MutationObserver | null = null;
let observedRegion: Element | null = null;
let sendTimer: number | undefined;
let lastCaptionAt = 0;
let startedRunAt = 0;
let offered = false;
let missingLeavePolls = 0;
let wasJoined = false;

// ---- messaging ----

async function send<T>(msg: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return null; // extension reloaded or background asleep; try again later
  }
}

// ---- session ----

function loadSession(meetCode: string): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s && s.meetCode === meetCode && typeof s.startedAt === "string" ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ---- capture ----

function scan() {
  if (!tracker) return;
  const region = findCaptionsRegion(document);
  if (!region) return;
  let changed = false;
  const now = new Date();
  for (const b of readBlocksFromRegion(region)) {
    if (tracker.observe({ ...b, now })) changed = true;
  }
  if (changed) lastCaptionAt = Date.now();
}

function attachObserver() {
  const region = findCaptionsRegion(document);
  if (region === observedRegion) return;
  observer?.disconnect();
  observedRegion = region;
  if (!region) return;
  observer = new MutationObserver(scan);
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  scan();
}

async function flush() {
  if (!session || !tracker) return;
  // Empty segments still go out as a heartbeat so the background does not finalise a quiet call.
  const changed = tracker.changedSince(lastSent);
  const res = await send<{ ok?: boolean }>({
    type: "meet:segments",
    key: session.key,
    meetCode: session.meetCode,
    title: titleFromDocument(document.title, session.meetCode),
    startedAt: session.startedAt,
    segments: changed,
  });
  if (res?.ok) for (const s of changed) lastSent.set(s.id, s.text);
}

function tick() {
  if (!session) return;
  scan();
  attachObserver(); // Meet may re-render and replace the region
  void flush();
  renderBar();
}

function ensureCaptionsOn() {
  if (findCaptionsRegion(document)) return;
  findCaptionsOnButton(document)?.click();
}

function startNotes(meetCode: string) {
  if (session) return;
  const prior = loadSession(meetCode);
  const s = prior ?? { meetCode, startedAt: new Date().toISOString() };
  saveSession(s);
  session = { ...s, key: `${s.meetCode}:${s.startedAt}` };
  tracker = new CaptionTracker();
  lastSent.clear();
  startedRunAt = Date.now();
  lastCaptionAt = 0;
  ensureCaptionsOn();
  attachObserver();
  sendTimer = window.setInterval(tick, SEND_EVERY_MS);
  renderBar();
  // Captions button may take a moment to react; try once more.
  window.setTimeout(() => {
    ensureCaptionsOn();
    attachObserver();
  }, 1500);
}

async function endNotes() {
  if (!session) return;
  const key = session.key;
  scan();
  await flush();
  window.clearInterval(sendTimer);
  observer?.disconnect();
  observer = null;
  observedRegion = null;
  session = null;
  tracker = null;
  lastSent.clear();
  clearSession();
  await send({ type: "meet:end", key });
  removeBar();
}

// A reload or tab close only flushes: the call may still be going (reload). The background finalises idle sessions.
function onPageHide() {
  if (!session) return;
  scan();
  void flush();
}

// ---- bar (shadow DOM) ----

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let dismissed = false;

const CSS = `
:host { all: initial; }
.bar { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 2147483647;
  display: flex; align-items: center; gap: 12px; padding: 10px 14px; max-width: 92vw;
  background: #1f2328; color: #f3f4f6; border: 1px solid #3d444d; border-radius: 10px;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.msg { display: flex; flex-direction: column; }
.hint { font-size: 12px; color: #b6bcc6; }
button { font: inherit; cursor: pointer; padding: 6px 12px; border-radius: 6px; border: 1px solid #5b636e;
  background: #2d333b; color: #f3f4f6; }
button.primary { background: #e5e7eb; color: #111418; border-color: #e5e7eb; }
button:hover { filter: brightness(1.1); }
button:focus-visible { outline: 2px solid #9ca3af; outline-offset: 2px; }
`;

function ensureHost(): ShadowRoot {
  if (host && root && host.isConnected) return root;
  host = document.createElement("div");
  host.id = "tether-meet-bar";
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);
  document.documentElement.appendChild(host);
  return root;
}

function removeBar() {
  host?.remove();
  host = null;
  root = null;
}

function mkButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", onClick);
  return b;
}

function setBar(message: string, hint: string | null, buttons: HTMLButtonElement[]) {
  const r = ensureHost();
  r.querySelector(".bar")?.remove();
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Tether notes");
  const msg = document.createElement("div");
  msg.className = "msg";
  const main = document.createElement("span");
  main.textContent = message;
  main.setAttribute("role", "status");
  msg.appendChild(main);
  if (hint) {
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = hint;
    msg.appendChild(h);
  }
  bar.appendChild(msg);
  for (const b of buttons) bar.appendChild(b);
  r.appendChild(bar);
}

function renderBar() {
  if (session) {
    const quiet = Date.now() - Math.max(lastCaptionAt, startedRunAt) > NO_CAPTIONS_MS;
    setBar(
      "Tether is taking notes",
      quiet ? "No captions seen — is CC on?" : "Let people know you're taking notes.",
      [mkButton("Stop", () => void endNotes(), true)],
    );
  }
}

function showOffer(meetCode: string) {
  setBar("Take notes with Tether?", "Let people know you're taking notes.", [
    mkButton("Take notes", () => startNotes(meetCode), true),
    mkButton("Not now", () => {
      dismissed = true;
      removeBar();
    }),
  ]);
}

// ---- call detection ----

async function pollCall() {
  const meetCode = meetCodeFromUrl(location.href);
  if (!meetCode) return;
  const inCall = findLeaveButton(document) !== null;

  if (inCall) {
    missingLeavePolls = 0;
    wasJoined = true;
    if (!offered) {
      offered = true;
      const cfg = await send<{ offer?: boolean; paired?: boolean }>({ type: "meet:config" });
      const resumable = loadSession(meetCode) !== null;
      if (!cfg) {
        // Background unreachable: a reload-resumable session still resumes; otherwise retry next poll.
        if (resumable) startNotes(meetCode);
        else offered = false;
        return;
      }
      if (!cfg.paired) return; // not paired: show nothing
      if (resumable) startNotes(meetCode);
      else if (cfg.offer && !dismissed) showOffer(meetCode);
    }
    return;
  }

  if (wasJoined && ++missingLeavePolls >= LEFT_POLLS) {
    wasJoined = false;
    offered = false;
    missingLeavePolls = 0;
    dismissed = false;
    if (session) await endNotes();
    else removeBar();
  }
}

function init() {
  // Leave click: end right away, before the page navigates.
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (session && t instanceof Element && t.closest(SELECTORS.leaveButton.join(", "))) {
        wasJoined = false;
        offered = false;
        void endNotes();
      }
    },
    true,
  );
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);
  window.setInterval(() => void pollCall(), POLL_MS);
  void pollCall();
}

init();
