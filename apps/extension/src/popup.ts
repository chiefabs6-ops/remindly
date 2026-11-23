import type { Recent } from "./client";

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

async function render() {
  const s = await send<Status>({ type: "status" });
  const state = $("state");
  state.textContent = s.online ? "Tether is running" : "Tether is closed";
  state.className = `state ${s.online ? "" : "off"}`;
  $("pair").hidden = s.paired;
  $("main").hidden = !s.paired;
  $("retry").hidden = !(s.queued && s.online);
  $("pending").textContent = s.pending === null ? "" : `${s.pending} waiting for approval`;
  if (s.repair && !s.paired) say("Tether stopped accepting this browser (it was unpaired). Pair again to send waiting captures.", "err");
  else if (!s.online && s.queued) say(`${s.queued} saved here — they send when Tether is open.`);

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
  const r = await send<{ ok: boolean; message?: string }>({ type: "pair", code });
  if (r.ok) say("Paired. Right-click any selected text to create a task.", "ok");
  else say(r.message ?? "Pairing failed.", "err");
  render();
});

async function quick(kind: "task" | "note") {
  const box = $<HTMLTextAreaElement>("quick");
  const r = await send<"sent" | "queued" | { error: string }>({ type: "quick", kind, text: box.value });
  if (r === "sent") {
    say(kind === "task" ? "Task sent to your Tether inbox." : "Note sent to your Tether inbox.", "ok");
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

render();
$("quick")?.focus();
