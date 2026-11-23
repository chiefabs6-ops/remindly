import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/generic.ts
function inertTitle(title, max = 80) {
  const t = title.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim();
  return `"${t.length > max ? t.slice(0, max - 1) + "\u2026" : t}"`;
}

// src/project.ts
import { execFile } from "node:child_process";
import { basename } from "node:path";
function git(dir, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    );
  });
}
function repoNameFromRemote(remote) {
  if (!remote) return null;
  const m = remote.replace(/\.git$/, "").match(/([^/:\\]+)$/);
  return m ? m[1] : null;
}
function safeRemote(remote) {
  if (!remote) return null;
  return remote.replace(/\/\/[^/@]+@/, "//");
}
async function describeRepo(dir, opts = {}) {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]) ?? dir;
  const rootDir = top.replace(/\//g, "\\");
  const remote = safeRemote(await git(rootDir, ["remote", "get-url", "origin"]));
  const branch = opts.branch === false ? null : await git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    rootDir,
    name: repoNameFromRemote(remote) ?? basename(rootDir),
    gitRemote: remote,
    branch: branch && branch !== "HEAD" ? branch : null
  };
}

// src/tether.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
var API = process.env.TETHER_API ?? "http://127.0.0.1:47821";
function dataDir() {
  if (process.env.TETHER_DATA_DIR) return process.env.TETHER_DATA_DIR;
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "AppData", "Roaming");
  return join(appData, "ie.tether.app");
}
var TetherOffline = class extends Error {
  constructor() {
    super("Tether isn't running on this PC.");
  }
};
var TetherError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function token() {
  try {
    return (await readFile(join(dataDir(), "token"), "utf8")).trim();
  } catch {
    throw new TetherOffline();
  }
}
async function call(path, init = {}) {
  const t = await token();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 5e3)
    });
  } catch {
    throw new TetherOffline();
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new TetherError(res.status, data?.message ?? `Tether returned ${res.status}`);
  return data;
}

// src/hook.ts
async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
async function contextLine(cwd) {
  const info = await describeRepo(cwd, { branch: false });
  const ctx = await call("/v1/code-projects/resolve", {
    method: "POST",
    body: { rootDir: info.rootDir, name: info.name, gitRemote: info.gitRemote },
    timeoutMs: 1500
  });
  if (!ctx.openTasks.length && !ctx.pendingSuggestions.length) return null;
  const tasks = ctx.openTasks.slice(0, 5).map((t) => `${inertTitle(t.title)}${t.dueDate ? ` (due ${t.dueDate})` : ""} [${t.id}]`).join("; ");
  return [
    `Tether has ${ctx.openTasks.length} open task(s) for this repository${ctx.project ? ` (project ${ctx.project.name})` : ""}${tasks ? `: ${tasks}` : ""}.`,
    ctx.pendingSuggestions.length ? `${ctx.pendingSuggestions.length} Claude suggestion(s) for it await the user's approval.` : ""
  ].filter(Boolean).join(" ");
}
async function run() {
  try {
    const input = JSON.parse(await readStdin() || "{}");
    const line = await contextLine(input.cwd || process.cwd());
    if (line) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } })
      );
    }
  } catch {
  }
  process.exit(0);
}
if (process.argv[1] && /hook\.(m?js|ts)$/.test(process.argv[1])) run();
export {
  contextLine
};
