import { API, TetherClient, chromeStorage, type Recent } from "./client";

// Chrome's Local Network Access rules: a background service worker cannot show the "allow local
// network access" prompt, so its first calls to 127.0.0.1 can fail. The popup is a page, so it
// makes the first contact (and pairing) itself; once allowed, the worker can connect too.
const popupClient = new TetherClient(chromeStorage());

async function reachFromPage(): Promise<"ok" | "blocked"> {
  try {
    const r = await fetch(`${API}/v1/health`, { cache: "no-store" });
    return r.ok ? "ok" : "blocked";
  } catch {
    return "blocked";
  }
}

type Status = { online: boolean; paired: boolean; repair: boolean; queued: number; recent: Recent[]; pending: number | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<T>;

function say(text: string, kind: "ok" | "err" | "" = "") {
  const m = $("msg");
  m.textContent = text;
  m.className = `msg ${kind}`;
}

function ago(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h` : new Date(iso).toLocaleDateString("en-IE", { day: "numeric", month: "short" });
}

async function render(keepMessage = false) {
  const page = await reachFromPage();
  const s = await send<Status>({ type: "status" });
  const online = s.online || page === "ok";
  const state = $("state");
  state.textContent = online ? "Tether is running" : "Can't reach Tether";
  state.className = `state ${online ? "" : "off"}`;
  if (keepMessage) {
    // Leave the result of the action the user just took on screen.
  } else if (!online) {
    say("Start Tether on this PC. If Chrome asks to allow access to devices on your local network, choose Allow, then reopen this popup.", "err");
  } else if (page === "ok" && !s.online) {
    say(`Chrome is blocking the Tether extension's background connection. Open chrome://settings/content/siteDetails?site=chrome-extension://${chrome.runtime.id} , set "Local network access" to Allow, then reload the extension.`, "err");
  }
  $("pair").hidden = s.paired;
  $("main").hidden = !s.paired;
  $("retry").hidden = !(s.queued && online);
  $("pending").textContent = s.pending === null ? "" : `${s.pending} waiting for approval`;
  if (s.repair && !s.paired) say("Tether stopped accepting this browser (it was unpaired). Pair again to send waiting captures.", "err");
  else if (!online && s.queued) say(`${s.queued} saved here — they send when Tether is open.`);

  const ul = $("recent");
  ul.replaceChildren();
  if (!s.recent.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Select text on a page, right-click, Create Task.";
    ul.append(li);
  }
  for (const r of s.recent) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = r.title; // textContent: page text is never parsed as HTML
    const st = document.createElement("span");
    st.className = `s ${r.state}`;
    st.textContent = r.state === "queued" ? "waiting" : r.state === "rejected" ? "not accepted" : ago(r.at);
    li.append(t, st);
    ul.append(li);
  }
}

$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>("code").value.trim();
  if (!/^\d{6}$/.test(code)) return say("Enter the 6 digits shown in Tether.", "err");
  // Pair from the page (see reachFromPage), then let the worker send anything waiting.
  const r = await popupClient.pair(code, { flush: false });
  if (r.ok) await send({ type: "flush" }).catch(() => undefined);
  if (r.ok) say("Paired. Right-click any selected text to create a task.", "ok");
  else say(("message" in r && r.message) || "Pairing failed.", "err");
  render(true);
});

async function quick(kind: "task" | "note") {
  const box = $<HTMLTextAreaElement>("quick");
  const r = await send<"sent" | "queued" | { error: string }>({ type: "quick", kind, text: box.value });
  if (r === "sent") {
    say(kind === "task" ? "Task sent to Tether for your approval." : "Note sent to Tether for your approval.", "ok");
    box.value = "";
  } else if (r === "queued") {
    say("Saved. It will send when Tether is open.", "ok");
    box.value = "";
  } else say(r.error, "err");
  render();
}

$("quick-form").addEventListener("submit", (e) => {
  e.preventDefault();
  quick("task");
});
$("quick").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) quick("task");
});
$("as-note").addEventListener("click", () => quick("note"));
$("open").addEventListener("click", async () => {
  const r = await send<{ ok: boolean }>({ type: "open" });
  if (!r.ok) say("Tether isn't running. Start it from the Start menu.", "err");
});
$("retry").addEventListener("click", async () => {
  const r = await send<{ sent: number; left: number }>({ type: "flush" });
  say(`Sent ${r.sent}. ${r.left ? `${r.left} still waiting.` : ""}`, r.left ? "" : "ok");
  render();
});
$("unpair").addEventListener("click", async () => {
  await send({ type: "unpair" });
  say("Unpaired.");
  render();
});

$<HTMLInputElement>("meet-offer").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const r = await send<{ on: boolean }>({ type: "meetOffer:set", on: input.checked });
  input.checked = r.on;
});
send<{ on: boolean }>({ type: "meetOffer:get" }).then((r) => ($<HTMLInputElement>("meet-offer").checked = r.on));

render();
$("quick")?.focus();
