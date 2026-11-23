# Tether — Technical Proposal

Personal, local-first productivity assistant for Windows. One app and one database, fed by the desktop UI, a Chrome extension and Claude Code.

Status: **proposal for approval**. No application code exists yet.
Date: 2026-11-23.

Legend used throughout:
- **[Confirmed]**: read in current official docs during research.
- **[Test]**: plausible or partly documented; must be proven in the Phase 0 spike or in the phase that needs it.
- **[Assumption]**: my judgement; change it if you disagree.

---

## 1. Executive summary

Tether is a Tauri 2 desktop app with a Rust core. The core owns a single SQLite database and serves a small HTTP API on `127.0.0.1`, protected by a bearer token. Three clients use that API:

1. The React UI inside the Tauri window (through Tauri commands, not HTTP).
2. A Chrome MV3 extension (right-click "Create Task", popup).
3. A Claude Code plugin that bundles an MCP server, a SessionStart hook and a `/tether:handoff` skill.

Everything captured from outside lands in the **Inbox** as a *suggestion*. Nothing becomes an active task without your approval.

The app lives in the system tray, starts with Windows, and runs the reminder scheduler. It uses about 0% CPU and a few tens of MB of RAM when the window is closed.

Local AI (Ollama, a 3–4B model on CPU) is optional and comes last. Rules plus `chrono-node` date parsing cover most "smart" capture without any model.

The first usable version is **Phases 0–2**: the desktop app with tasks, notes, projects and inbox, plus Chrome capture. Claude Code follows in Phase 3.

---

## 2. Requirements and feature breakdown

| Area | Must have (v1) | Later |
|---|---|---|
| Tasks | CRUD, subtasks, due date + optional time, priority, status, project, tags, notes, source, URL, code-project info, duplicate, reschedule, complete | Recurring tasks |
| Inbox | All external captures + quick adds; approve / edit / dismiss; pending suggestions shown apart from approved items | Bulk triage |
| Projects | Configurable list, colour, archive | Per-project dashboards |
| Notes | Markdown notes, link to project/task, full-text search, convert note into task(s) | AI split of a note into tasks |
| Dashboard | Today, overdue, due soon, upcoming, carried over, recent, from Chrome, from Claude, progress | Charts / streaks |
| Chrome | Right-click capture, popup quick task/note, recent captures, pending count, open app, offline queue | Capture from Gmail threads |
| Claude Code | Suggest task, suggest update/complete, search tasks, project context, session-start summary | Auto handoff on session end |
| Reminders | Daily briefing, due-soon / due / overdue, smart periodic nudge, end-of-day review, snooze 15m/30m/1h/tomorrow/custom | Calendar view |
| Intelligence | Rule-based title/deadline/project extraction, FTS search, duplicate detection | Ollama: summaries, splitting, prioritisation |
| Reliability | WAL, daily auto-backup, manual backup/restore, export/import, migrations | Auto-update |

Status set: `inbox`, `not_started`, `in_progress`, `waiting`, `completed`, `archived`.

**Approved vs pending — recommendation: yes, keep them separate.**
- Suggestions (from Chrome, Claude and AI) live in their own `suggestions` table until approved. Approval creates the task.
- Manual quick-adds go straight in as tasks with status `inbox`, because you wrote them yourself.
- This keeps half-baked machine output out of task lists, search and reminders.

---

## 3. Development environment findings

| Item | Found (2026-11-23) | Verdict |
|---|---|---|
| OS | Windows 11 Home 10.0.26300 | OK. Home edition has no BitLocker management UI; check whether "Device encryption" is on. |
| CPU | Intel i5-1135G7, 4C/8T | Fine for the app; CPU-only AI is slow but usable for short jobs |
| RAM | 15.8 GB | App fine. AI: 3–4B models only. |
| GPU | Intel Iris Xe (shared memory) | No dedicated VRAM. Plan for CPU inference. |
| Disk | 120 GB free on C: | Fine |
| Node / npm | v24.19.0 / 11.17.0 | Good |
| pnpm | not installed | Not needed; use npm workspaces |
| Git | 2.47.0 | Good |
| Claude Code | 2.1.330 | Good |
| WebView2 | 157.0.4341.60 | Good |
| Rust / Cargo | Installed 2026-11-23 via winget | rustc / cargo 1.100.0, toolchain `stable-x86_64-pc-windows-msvc` |
| MSVC Build Tools | Installed 2026-11-23 via winget | Visual Studio Build Tools 2022 with the C++ tools |
| Ollama | not installed | Optional, Phase 6 |

**Can this PC run it comfortably?** Yes, the app can.
- Tauri uses the system WebView2, so there is no bundled Chromium.
- Idle in the tray with the window destroyed: an estimated 20–40 MB **[Test]**.
- Local AI: expect about 8–15 tokens/s for a 3B Q4 model on this CPU **[Assumption from comparable CPUs]**. That means 2–6 s for a short JSON extraction once warm. Fine for background suggestions, not for chat.

---

## 4. Recommended technology stack

| Layer | Choice | Why / alternatives considered |
|---|---|---|
| Desktop shell | **Tauri 2** (crate v2.12.x) **[Confirmed]** | Small, native WebView2, Rust core. Electron rejected: ~150 MB+ RAM idle and Chromium bundled. |
| UI | **React 19 + TypeScript + Vite** | Your preference; huge ecosystem. |
| UI kit | **Tailwind CSS + Radix primitives (shadcn/ui pattern)** | Accessible, themeable, light/dark built in. |
| UI state | **TanStack Query** over Tauri commands | Cache + refetch on change events. |
| Core | **Rust**: `rusqlite` (bundled) + `rusqlite_migration`, `axum` on Tauri's Tokio runtime, `serde` | Rust owns the DB. See the decision below. |
| Database | **SQLite**, WAL mode, FTS5 | Single file, reliable, easy backup. |
| Local API | `axum` bound to `127.0.0.1:47821` (configurable), bearer token + Origin check | One API for both the extension and MCP. |
| Date parsing | **chrono-node** (JS), in a shared TS package | Most mature parser; Rust options are immature **[Confirmed via research]**. |
| Chrome | **Manifest V3**, TypeScript, built with Vite | Required by Chrome. |
| Claude Code | **Claude Code plugin** = MCP server (TS SDK v2 `@modelcontextprotocol/server`) + hooks + skill **[Confirmed]** | One install, works in every repo. |
| Notifications | **`tauri-winrt-notification`** (official tauri-apps crate) | Supports buttons and an activation callback. The stock Tauri notification plugin has **no action buttons on Windows** **[Confirmed]**. |
| Tray / autostart / single-instance | Tauri tray API, `tauri-plugin-autostart`, `tauri-plugin-single-instance` **[Confirmed]** | Official. |
| AI (optional) | **Ollama**, `qwen2.5:3b` or `qwen3:4b`, structured JSON output **[Confirmed feature]** | Free, local, easy to swap models. |
| Installer | **NSIS, per-user** (no admin) **[Confirmed]** | Writes HKCU autostart; registers the AUMID for toasts. |
| Repo tooling | npm workspaces + Cargo; Vitest, Playwright, `cargo test` | No extra package manager. |

### Key decision: who owns the database?

| Option | Pros | Cons |
|---|---|---|
| A. `tauri-plugin-sql` (JS talks to the DB) | Quick start | DB logic in the UI. The HTTP API would need a second pool, giving two owners. **Rejected.** |
| B. Separate Node.js service owns the DB | All TypeScript | An extra process to start, supervise and keep alive. Duplicates the tray app. |
| **C. Rust core in the Tauri app owns the DB + HTTP API** | One process, one writer, one set of migrations. Fast. | Some Rust to write. |

**Recommendation: C.** The extension and the MCP server become thin clients.

### Key decision: extension ↔ app link

You chose **localhost + token**. Notes:
- Native Messaging is safer by design, but it needs a registry host and a stdio bridge exe.
- Localhost lets one API serve both Chrome and MCP.

---

## 5. Architecture diagram

```
                     ┌──────────────────────── Windows PC ─────────────────────────┐
                     │                                                             │
  Chrome ───────────►│  Tether extension (MV3 service worker)                      │
  (right-click,      │     │  offline queue in chrome.storage.local                │
   popup)            │     │  HTTP + Bearer token                                  │
                     │     ▼                                                       │
  Claude Code ──────►│  Tether MCP server (Node, stdio) ── HTTP + token ──┐        │
  (any repo)         │  + SessionStart hook / handoff skill               │        │
                     │                                                    ▼        │
                     │  ┌──────────────── Tether.exe (Tauri 2) ───────────────────┐│
                     │  │ Rust core                                               ││
                     │  │  ├─ axum API  127.0.0.1:47821                           ││
                     │  │  ├─ Repository layer ─► SQLite (WAL, FTS5)              ││
                     │  │  ├─ Scheduler (30 s tick, catch-up after sleep)         ││
                     │  │  ├─ Notifier (WinRT toasts + buttons)                   ││
                     │  │  ├─ Backup job                                          ││
                     │  │  └─ AI client (optional) ─► Ollama 127.0.0.1:11434      ││
                     │  │ Tray icon · autostart · single instance                 ││
                     │  │ React UI (WebView2) ◄─ Tauri commands + events          ││
                     │  └─────────────────────────────────────────────────────────┘│
                     │  %APPDATA%\ie.tether.app\  tether.db · token · backups\            │
                     └─────────────────────────────────────────────────────────────┘
```

---

## 6. Component communication design

| From → To | Transport | Auth | If the app is closed |
|---|---|---|---|
| React UI → core | Tauri `invoke` commands; core emits `data-changed` events | In-process | n/a |
| Extension → core | `fetch` from the service worker to `http://127.0.0.1:47821` | `Authorization: Bearer <token>` + `Origin` must equal the pinned extension ID | Item kept in an offline queue; retried by `chrome.alarms` (1–5 min backoff) and on service-worker start. The popup shows "Tether not running — 3 queued". |
| MCP → core | HTTP to the same API | Token read from `%APPDATA%\ie.tether.app\token` (file readable only by your user) | **Agreed:** the MCP server writes the suggestion as a JSON file to `%APPDATA%\ie.tether.app\spool\`. Tether imports and deletes spool files on start (and every scheduler tick), validating each one first. Claude is told "Saved; Tether will import it when it starts." |
| Hook → core | `http` hook type or a small command script **[Confirmed hook types: command, http, mcp_tool, prompt, agent]** | Token | Hook fails silently; never blocks the session. |
| Core → Ollama | HTTP `127.0.0.1:11434` | None (local) | AI features show "AI off"; rules still work. |

API shape (versioned, JSON):

```
GET  /v1/health                      no auth  → { ok, version }
POST /v1/pair                        pairing code → token (extension only)
POST /v1/suggestions                 create suggestion (task | task_update | note)
GET  /v1/suggestions?status=pending
GET  /v1/tasks?query=&project=&status=&due_before=&limit=
GET  /v1/tasks/:id
GET  /v1/projects
GET  /v1/code-projects/resolve?dir=  → project + open tasks for that repo
POST /v1/notes                       quick note (goes to inbox)
POST /v1/parse                       text → suggested title/deadline/project (rules, + AI if on)
```

No endpoint deletes data. External clients can only **suggest** a change to an existing task; the change applies after approval.

**Extension pairing:**
1. Click "Pair Chrome" in Tether's settings. Tether shows a 6-digit code that is valid for 2 minutes.
2. Type the code into the extension popup.
3. The extension sends `POST /v1/pair` and receives a long random token, which it stores.

---

## 7. Database schema

SQLite and conventions:
- Each record has a `TEXT` UUID primary key (ULID, so IDs sort by time).
- Timestamps are ISO-8601 in UTC. Dates are stored as `YYYY-MM-DD`.
- `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`.
- Schema version is tracked via `user_version` / `rusqlite_migration`.

```sql
projects(
  id PK, name UNIQUE, color, icon, description,
  sort_order, archived_at, created_at, updated_at)

categories(id PK, name UNIQUE, color)            -- optional grouping of projects
-- projects.category_id FK → categories (nullable)

tags(id PK, name UNIQUE COLLATE NOCASE, color)

tasks(
  id PK, parent_id FK→tasks NULL,                 -- subtasks (1 level in UI, n in DB)
  project_id FK→projects NULL,
  title NOT NULL, description, notes,
  status CHECK(status IN ('inbox','not_started','in_progress','waiting','completed','archived')),
  priority INTEGER CHECK(priority BETWEEN 0 AND 3),   -- none/low/med/high
  due_date, due_time NULL, scheduled_date NULL,       -- scheduled = "do on" (carry-forward)
  source CHECK(source IN ('manual','chrome','claude','note','ai')),
  source_url, source_title, source_selection,
  code_project_id FK→code_projects NULL,
  sort_order, completed_at, archived_at,
  created_at, updated_at, deleted_at NULL)            -- soft delete, purged after 30 days

task_tags(task_id FK, tag_id FK, PK(task_id, tag_id))

notes(
  id PK, project_id FK NULL, task_id FK NULL,
  title, body_md, kind CHECK(kind IN ('general','meeting','idea','research','work')),
  source, source_url, created_at, updated_at, deleted_at)

note_tags(note_id FK, tag_id FK, PK)

code_projects(                                     -- Claude Code repos
  id PK, root_dir UNIQUE, name, git_remote NULL,
  project_id FK→projects NULL,                     -- your mapping, e.g. → "Kinia – Educator Platform"
  last_seen_at)

suggestions(                                       -- pending inbox from outside
  id PK,
  kind CHECK(kind IN ('task','task_update','note')),
  origin CHECK(origin IN ('chrome','claude','ai','note')),
  target_task_id FK NULL,                          -- for task_update
  payload_json NOT NULL,                           -- proposed fields (validated)
  context_json,                                    -- completed / remaining / why / where to continue
  confidence_json,                                 -- e.g. {deadline: 0.6}
  dedupe_key, possible_duplicate_of FK→tasks NULL,
  status CHECK(status IN ('pending','approved','dismissed')),
  resulting_task_id FK NULL,
  created_at, decided_at)

reminders(
  id PK, task_id FK NULL,
  kind CHECK(kind IN ('due_soon','due','overdue','custom','snooze','briefing','eod_review','nudge')),
  fire_at NOT NULL, fired_at NULL, snoozed_until NULL,
  dismissed_at NULL, created_at)
-- index on (fired_at, fire_at) for the scheduler

task_history(                                      -- audit trail
  id PK, task_id FK, at, actor CHECK(actor IN ('user','claude','chrome','system','ai')),
  action, field, old_value, new_value)

settings(key PK, value_json, updated_at)

-- Full-text search (external content + triggers)
tasks_fts USING fts5(title, description, notes, content='tasks', content_rowid='rowid', tokenize='trigram')
notes_fts USING fts5(title, body_md, content='notes', content_rowid='rowid', tokenize='trigram')
```

Maintenance rules:
- Every task mutation writes `task_history` in the same transaction.
- Deleting a project sets `project_id` to NULL on its tasks; it never deletes them.
- The suggestion payload is validated against the same rules as a task before approval.
- A daily job purges soft-deleted rows after 30 days.

"Task sources" is covered by `tasks.source` plus the `source_*` columns, and by `suggestions.origin`. No separate table is needed.

---

## 8. Chrome extension architecture

Permissions:

```json
"permissions": ["contextMenus", "activeTab", "scripting", "storage", "alarms"],
"host_permissions": ["http://127.0.0.1/*"]
```

No `<all_urls>` and no `tabs` permission. The context-menu click grants `activeTab`, which gives `tab.title` and lets the extension read the full selection with `scripting.executeScript(() => getSelection().toString())` **[Test: title via activeTab]**.

Flow:
1. The service worker registers `contextMenus.create({id:'create-task', title:'Create Task', contexts:['selection']})` on install.
2. On click it collects the selection, `pageUrl`, `tab.title` and the capture time.
3. It runs the shared parser (`chrono-node` with `forwardDate:true`). "Before Friday" or "by Friday" become a deadline suggestion with a confidence value and the matched phrase.
4. It POSTs to `/v1/suggestions` and shows a small confirmation (a badge or a brief notification).
5. On failure it pushes the item to `storage.local.queue` and sets the badge to the queue count.

Popup (React, small):
- Quick task and quick note.
- Recent captures.
- Pending-suggestion count.
- "Open Tether": the API asks the app to show its window.

Hardening:
- `storage.local.setAccessLevel('TRUSTED_CONTEXTS')`.
- Pin the extension ID with a `key` in the manifest, so the Origin check is stable.
- Load it unpacked from `apps/extension/dist`. Self-hosted `.crx` installs are blocked on Windows **[Confirmed]**.

**[Test]** Chrome's Local Network Access prompt (Chrome 142+) appears not to apply to extension service workers. Verify on your Chrome in Phase 3.

---

## 9. Claude Code MCP architecture

Ship as a **Claude Code plugin** `tether`:

```
plugins/claude-tether/
  .claude-plugin/plugin.json
  .mcp.json            → node ${CLAUDE_PLUGIN_ROOT}/dist/server.js
  hooks/hooks.json     → SessionStart: print open Tether tasks for this repo
  skills/handoff/SKILL.md   → /tether:handoff  "write a proper end-of-session task"
```

Install once at user level, so it works in every repo. The MCP server can also be registered alone with `claude mcp add --scope user tether -- node <abs path>` **[Confirmed]**.

**Project identity [Confirmed]:**
- Claude Code answers MCP `roots/list` with the session launch directory, and sets `CLAUDE_PROJECT_DIR` in the server's environment.
- The server uses those, then derives the name from `git remote get-url origin` or the folder name.
- `code_projects` maps a directory to one of your projects. The first time a repo appears, its suggestion asks you to pick a project; after that the mapping is remembered.

**Tools.** Reads are `readOnlyHint`. Writes only create suggestions.

| Tool | Kind | Purpose |
|---|---|---|
| `get_project_context` | read | Current repo → mapped project + open tasks + pending suggestions. Claude calls it first, to avoid duplicates. |
| `search_tasks` | read | Query by text / project / status / due window. Returns short rows. |
| `get_task` | read | Full task with subtasks, history summary and context. |
| `list_projects` | read | Names + IDs. |
| `search_notes` | read | FTS over notes. |
| `suggest_task` | write → suggestion | title, description, `completed[]`, `remaining[]`, `why`, `resume_hint` (files, branch, command), suggested_due, priority, project. Server adds dir, repo, branch, time. |
| `suggest_task_update` | write → suggestion | Propose complete / reschedule / add progress note to an existing task ID. |
| `suggest_note` | write → suggestion | Save research or a decision as a note. |

Not offered: delete, and any direct update or completion. This follows your "approve before it becomes active" rule, extended to edits.

**Accuracy:**
- `suggest_task` *requires* `remaining[]` and `resume_hint`, and rejects titles under 3 words or generic titles ("Continue work").
- The server-side dedupe check returns any close matches.
- Claude then either suggests an update to the existing task or explains why the new one is different.

**Hooks (complement, not the main path):**
- **SessionStart**: injects "Tether: 2 open tasks for this repo: …" as context. This is factual text, not an instruction **[Confirmed mechanism]**.
- **Stop / SessionEnd**: optional, off by default. It could nudge "unfinished work? run /tether:handoff". Hooks are deterministic but have no judgement, so suggestions stay an explicit MCP call.

Results are kept small (well under the 25k-token MCP output limit) **[Confirmed limit]**.

---

## 10. Local AI strategy

| Feature | No AI (rules) | Needs AI |
|---|---|---|
| Deadline from text ("before Friday", "tomorrow 3pm") | ✅ chrono-node | |
| Title from short selection | ✅ heuristics (first clause, strip "please", "can you") | Better wording on long text |
| Project guess | ✅ keyword rules per project + URL domain rules + learned from your past choices | Fuzzy cases |
| Duplicate detection | ✅ FTS5 trigram candidates + Dice/Jaro-Winkler score ≥ 0.65 + URL hash | Semantic duplicates |
| Priority suggestion | ✅ due proximity + words like "urgent" | Nuanced |
| Daily briefing | ✅ template from queries | Natural-language summary |
| Note → tasks | ✅ checkbox / bullet lines become tasks | Free prose |
| Break task into steps | | ✅ |
| Summarise outstanding work | | ✅ |
| "What should I do first?" | ✅ score (overdue, due, priority, age) | Reasoned explanation |

Ollama plan (Phase 6, optional):
- Default model `qwen2.5:3b` (~2 GB); alternative `qwen3:4b` (~2.5 GB, `think:false`).
- `format` = JSON schema, `temperature 0`, `keep_alive: "2m"` so RAM is freed soon after use **[Confirmed options]**.
- Run on CPU. Iris Xe via Vulkan is flaky and not faster for small models **[research]**.
- AI output always lands as a suggestion with its fields marked "AI".
- Settings: AI off / on, model picker, "test model" button showing tokens/s.

---

## 11. Reminder and background architecture

- **Process:** `Tether.exe` starts at login (HKCU `Run` key, `--autostart` → hidden). `tauri-plugin-single-instance` ensures that a second launch focuses the existing window.
- **Window:** Close destroys the WebView window to free RAM. Clicking the tray icon re-creates it. Quit is only available from the tray menu.
- **Scheduler:**
  - A Rust task ticks every 30 s and fires due `reminders`.
  - If the wall clock jumped more than 90 s, it treats that as sleep/resume and runs catch-up, collapsing missed reminders into one summary toast.
  - At startup it also runs catch-up. All due times live in the DB, so nothing depends on in-memory timers.
  - Optional later: `WM_POWERBROADCAST` resume hook **[Confirmed API]**.
- **Smart nudges:**
  - At most one nudge per configured interval, only during working hours (default 09:00–18:00, Mon–Fri).
  - Skipped if you used Tether in the last 15 min.
  - Never repeats the same task within 3 h.
  - Picks the top 1–3 tasks by the score in §10.
- **Toasts** via `tauri-winrt-notification`:
  - Buttons: Snooze ▾ (15m / 30m / 1h / Tomorrow), Done, Open.
  - "Custom" snooze opens the app.
  - **[Test early]** Buttons and callbacks need the installed AUMID and only work while Tether is running, which is always, since it lives in the tray.
  - Focus Assist may suppress toasts. The dashboard shows missed ones.
- **Daily briefing:** a toast at 09:00 that opens the Briefing view.
- **End-of-day review:** a toast opens the Review view. Each open task offers Tomorrow / Pick date / Backlog / Done / Leave.

---

## 12. Security and privacy

| Threat | Mitigation |
|---|---|
| Other machines reach the API | Bind `127.0.0.1` only, never `0.0.0.0`. |
| Websites in your browser call the API | Bearer token required, `Origin` must be the pinned extension ID or absent (MCP), no permissive CORS, JSON-only `Content-Type`. |
| Other local programs | Token file ACL'd to your user. A fully compromised user account can read anything anyway (accepted limit for a personal app). |
| MCP misuse / prompt injection via web pages Claude reads | MCP can only *suggest*; you approve every change; no delete tools. |
| Extension over-reach | Minimal permissions (§8), no host access to websites. |
| Data leaving PC | No telemetry, no cloud calls. Ollama is local. The updater (if added) only downloads. |
| Data at rest | DB in `%APPDATA%\ie.tether.app`. **Agreed:** no DB encryption for now (single PC, non-confidential data). |
| Token rotation | "Re-pair" button rotates the token; the old token stops working at once. |

---

## 13. Proposed UI and navigation

Left sidebar (collapsible), top command bar, main pane, optional right detail panel. Inspiration: Things 3 (calm), Linear (keyboard speed), Todoist (quick add).

```
┌──────────┬───────────────────────────────────────────────┬─────────────┐
│ ⌂ Today  │  ⌘K  Search or add…  ("call Niamh fri #kinia")  │             │
│ ⇣ Inbox 4│───────────────────────────────────────────────│ Task detail │
│ ☐ Tasks  │  Good morning · 5 today · 2 overdue · 3 new ⚑  │ title       │
│ ✎ Notes  │  ┌ Overdue ───────┐ ┌ Today ─────────────────┐ │ due  prio   │
│ ◫ Projects│ │ ...            │ │ ...                    │ │ project tags│
│ ⟳ Review │  └────────────────┘ └────────────────────────┘ │ context     │
│──────────│  ┌ Suggestions (Claude 2 · Chrome 1) ────────┐  │ subtasks    │
│ Projects │  │ Finish educator profile  [Approve][Edit][✕]│  │ history     │
│  • Kinia…│  └───────────────────────────────────────────┘  │             │
│ ⚙ Settings│  Upcoming · Recent · Progress bar              │             │
└──────────┴───────────────────────────────────────────────┴─────────────┘
```

Screens:
1. **Today (dashboard):** overdue, today, carried over, due soon, suggestions strip, progress.
2. **Inbox:** two tabs, *Suggestions* (Chrome / Claude / AI) and *Unsorted* (manual inbox tasks). Approving a Claude suggestion shows completed / remaining / resume hint.
3. **Tasks:** list with filters (project, tag, status, due), group by, sort; board view later.
4. **Notes:** list + markdown editor; "Convert to task(s)".
5. **Projects:** list → project page (tasks, notes, linked repos).
6. **Review:** end-of-day triage.
7. **Settings:** reminders, working hours, Chrome pairing, Claude plugin status, AI, backups, theme.

Global:
- `Ctrl+K` command palette and quick add with inline parsing (`tomorrow`, `!high`, `#project`).
- Global hotkey `Ctrl+Alt+Space` opens a quick-capture mini window anywhere **[Test: global-shortcut plugin]**.
- Light, dark and system themes.

---

## 14. Project folder structure

New standalone repo at `C:\Users\danze\Desktop\Apps\tether`, with no link to Kinia repos:

```
tether/
  apps/
    desktop/            Tauri 2 app
      src/              React UI (routes, components, hooks)
      src-tauri/        Rust core
        src/
          db/           connection, migrations/, repositories
          api/          axum routes, auth, pairing
          scheduler/    reminders, briefing, catch-up
          notify/       winrt toasts
          backup/
          ai/           ollama client (feature-flagged)
          commands.rs   Tauri commands for the UI
    extension/          Chrome MV3 (Vite + TS)
  packages/
    core/               shared TS: types, zod schemas, chrono-node parser, API client
  plugins/
    claude-tether/      Claude Code plugin (MCP server + hooks + skill)
  docs/                 PROPOSAL.md, ADRs, API.md
  .github/workflows/    CI (typecheck, lint, test, cargo test, build)
  package.json          npm workspaces
```

API contracts live once in `packages/core` as zod schemas. The Rust side mirrors them with serde, and a contract test checks that the two agree.

---

## 15. Development roadmap

Agreed order (2026-11-23): Chrome first (needed most), then Claude Code, then reminders; AI last. Phase 0 de-risks the unknowns first.

| Phase | Goal | Complexity | Est. effort* |
|---|---|---|---|
| **0. Spike** | Toolchain works; Tauri hello world with tray, single-instance, destroy/recreate window, axum + rusqlite, **toast with buttons from an installed NSIS build**, RAM measured | Low–Med | 1–2 days |
| **1. Core app + API** | Tasks, subtasks, projects, tags, notes, inbox, dashboard, search, local API + token | High | 2–3 weeks |
| **2. Chrome extension** | Context menu capture, parser, popup, pairing, offline queue, suggestion approval UI | Medium | 4–6 days |
| **3. Claude Code** | Plugin: MCP tools, suggestions, spool fallback, SessionStart hook, handoff skill | Medium | 4–6 days |
| **4. Background + reminders** | Autostart, scheduler, toasts with snooze, briefing, EOD review, nudges | Med–High | 1–1.5 weeks |
| **5. Reliability + polish** | Backups, restore, export/import, settings, installer, docs | Medium | 1 week |
| **6. Local AI** | Ollama client, extraction, summaries, splitting, prioritisation | Medium | 1 week |

\*Working days of focused build time with Claude Code doing most of the typing. These are rough estimates, not commitments.

**First working version = Phases 0–2.** You can capture and manage tasks in the app and from Chrome.

### Per-phase detail

**Phase 0 — Spike**
- Objectives: prove the risky bits before committing.
- Tasks:
  - Verify `rustc`/`cargo` and MSVC.
  - `npm create tauri-app` (React-TS).
  - Tray + close-to-tray + single-instance.
  - axum on `127.0.0.1` with a `/health` endpoint.
  - rusqlite WAL write/read.
  - Build an NSIS installer, install it, and fire a toast with a Snooze button whose callback logs.
  - Measure RAM hidden vs destroyed.
- Acceptance:
  - All of the above work on your PC.
  - Findings are written to `docs/spike.md`.
  - The spike code is thrown away or kept as the base.
- Risks: toast AUMID; build tools path.

**Phase 1 — Core app + API** (see §16).

**Phase 3 — Claude Code**
- Dependencies: Phase 1 API; suggestion approval UI from Phase 2.
- Tasks:
  - Plugin scaffold.
  - Token-file reader.
  - Project resolver (roots → `CLAUDE_PROJECT_DIR` → git).
  - The 8 tools.
  - Dedupe endpoint.
  - Suggestion approval UI with a context view.
  - SessionStart hook.
  - Handoff skill.
- Acceptance:
  - From two different repos, saying "that's enough for today…" yields a suggestion with remaining work, resume hint and the correct repo. It appears in the Inbox.
  - Approve creates the task; dismiss leaves no task.
  - Claude finds an existing similar task instead of duplicating it.
  - With Tether closed, the suggestion is spooled to disk and appears in the Inbox after Tether starts.
- Tests: MCP tool unit tests with a mocked API; API contract tests; one manual end-to-end script.
- Risks: Claude not calling tools proactively (mitigated by the skill and server instructions).

**Phase 2 — Chrome extension**
- Dependencies: Phase 1 API.
- Tasks: manifest, context menu, selection via `scripting`, parser, pairing UI, queue + alarms, popup, badge, suggestion approval UI in the Inbox.
- Acceptance:
  - The Niamh example produces the title "Follow up with Niamh", a description mentioning the SEPI teacher list, a deadline suggestion of next Friday with confidence shown, plus URL, page title and time.
  - Captures made while the app is closed arrive after it starts.
- Tests: parser unit tests (≥30 phrases); service-worker logic with mocked `chrome.*`; manual run on 5 real sites.
- Risks: LNA prompt behaviour; `activeTab` title.

**Phase 4 — Background + reminders**
- Tasks:
  - Autostart toggle.
  - Scheduler + catch-up.
  - Reminder generation on due-date change.
  - Toasts with buttons.
  - Snooze.
  - Briefing view, review view.
  - Nudge rules.
  - Settings UI.
- Acceptance:
  - Reboot → Tether is in the tray within 30 s of login.
  - A task due at 14:00 notifies at 13:45, at 14:00 and when overdue.
  - Snoozing works from the toast.
  - Sleeping over a due time gives one catch-up toast on wake.
- Tests: scheduler unit tests with a fake clock; manual sleep/reboot checklist.
- Risks: Focus Assist; toast callbacks.

**Phase 5 — Reliability + polish**
- Tasks:
  - Daily auto-backup with `VACUUM INTO`, keeping 7 daily + 4 weekly copies in `Documents\Tether\Backups`.
  - Manual backup/restore with an integrity check.
  - JSON export/import (for moving PCs).
  - Startup `PRAGMA integrity_check`, quick variant.
  - NSIS installer, README, extension pack instructions.
- Acceptance:
  - Restore on a fresh Windows user profile reproduces all data.
  - Killing the process mid-write loses at most the in-flight edit.

**Phase 6 — Local AI**: see §10. Acceptance: with AI off, all features still work. With AI on, a capture shows an improved title or extra suggestions within about 10 s and never blocks the UI.

---

## 16. Detailed Phase 1 task breakdown

1. **Repo + tooling:** npm workspaces, TS strict, ESLint, Prettier, Vitest, `cargo fmt`/`clippy`, CI workflow, `.gitignore`, MIT/private licence choice.
2. **Rust core skeleton:** app state, error type, logging (`tracing` to a rolling file in `%APPDATA%\ie.tether.app\logs`).
3. **DB layer:**
   - Connection with pragmas.
   - Migration 001 (the full schema in §7).
   - Repositories for projects, tasks, tags, notes and suggestions.
   - History writer.
   - FTS triggers.
4. **Tauri commands:** CRUD for each entity; dashboard query; search; duplicate task; reschedule; complete (also completes subtasks, with a prompt).
5. **Local API:** axum server, token creation on first run (32 random bytes, base64url), auth + Origin middleware, endpoints from §6 (suggestion create/list, tasks read, projects, health). Pairing can wait for Phase 3.
6. **Shared package:** zod schemas, types, chrono-node parser + quick-add syntax (`#project`, `!priority`, dates).
7. **UI shell:** layout, sidebar, routing, theme (light/dark/system), command palette, toasts, keyboard shortcuts.
8. **Screens:** Today, Inbox (Suggestions + Unsorted), Tasks list with filters, Task detail panel with subtasks, Notes list + editor, Projects, Settings (projects, theme, API port/token view).
9. **First run:** no seeded projects. A first-run screen asks you to add your real projects (name + colour).
10. **Tests + checks:** see §17. Ultron review before any push.

**Phase 1 acceptance criteria:**
- Create, edit, duplicate, reschedule, complete, archive and delete (soft) a task, with subtasks, tags and a project, in under 10 s via quick add.
- Today view correctly shows overdue, today, carried over, due within 3 days and upcoming.
- Search finds tasks and notes by any word or part of a word in under 100 ms with 5,000 items.
- Converting a note with 3 bullet lines into tasks creates 3 tasks linked to the note.
- `curl` with the token to `/v1/suggestions` creates a pending suggestion that appears in the Inbox live. Without the token it gets 401; with a foreign `Origin` it gets 403.
- Killing the app during edits never corrupts the DB (`integrity_check` = ok).
- Light and dark themes both pass a basic contrast check.

---

## 17. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Rust core | `cargo test` | Repositories on in-memory SQLite, migrations up from empty and from each prior version, API auth middleware, scheduler with fake clock |
| Shared TS | Vitest | Parser phrase table, quick-add syntax, zod schemas |
| UI | Vitest + Testing Library | Components and hooks |
| E2E desktop | WebdriverIO + `tauri-driver` (official on Windows) **[Test]** or Playwright against the Vite dev server with mocked commands | Core flows |
| Extension | Vitest with mocked `chrome.*`; manual checklist | Capture, queue |
| MCP | Vitest with a mock HTTP server; MCP Inspector for manual runs | Tools, validation, errors |
| Contract | Test that zod and serde accept and reject the same fixtures | API drift |
| Manual | Reboot, sleep, kill-process, offline-extension checklists per phase | Reliability |

CI on GitHub Actions (`windows-latest`): typecheck, lint, unit tests, `cargo test`, `cargo clippy -D warnings`, build.

---

## 18. Technical risks and limitations

| Risk | Impact | Mitigation |
|---|---|---|
| Toast buttons / callbacks need installed AUMID **[Test]** | No snooze from the toast | Phase 0 spike; fallback: toast click opens a snooze picker in the app |
| Toast clicked after app quit does nothing (no COM activator) | Minor | App always in tray; dashboard lists missed reminders |
| Chrome Local Network Access changes | Extension blocked or prompting | Test in Phase 3; fallback is Native Messaging (design keeps the API layer reusable) |
| Claude doesn't call tools unprompted | Fewer suggestions | Server instructions + handoff skill + optional Stop-hook nudge |
| Date parsing errors ("Friday" when it's Friday) | Wrong deadline | Always a suggestion with the matched phrase shown; `forwardDate` + tests |
| Slow CPU AI | Laggy AI features | Async, background, never blocking; AI optional |
| Unpacked extension ID changes | Pairing breaks | Pinned `key` in manifest |
| Single-user, no sync | Data only on this PC | Backups + export; maybe OneDrive backup folder **[decide]** |
| Updater requires signing key and hosting | — | Skip auto-update in v1; manual installer updates |

---

## 19. Complexity and estimated effort

Total to a polished v1 (Phases 0–6): roughly **7–9 weeks of focused build time**. First useful version (0–2): roughly **3–4 weeks**. Biggest chunks: the Phase 1 UI and the reminder engine. Estimates assume one phase at a time with review and your approval between phases.

---

## 20. Final recommendations

1. Keep your stack, with these changes:
   - **Rust core owns SQLite + API.** No Node service and no `tauri-plugin-sql`.
   - **`tauri-winrt-notification`** for actionable toasts.
   - **chrono-node** in a shared TS package.
   - **Claude Code plugin** rather than a bare MCP server.
2. Start with the **Phase 0 spike**, because the toast buttons and RAM numbers decide details.
3. Claude Code integration goes in Phase 2, before Chrome.
4. External clients can only **suggest**. You approve every change, edits included.
5. Ship AI last and keep it optional.

### Decisions (agreed 2026-11-23)

1. Phase order: 0 spike → 1 core → **2 Chrome → 3 Claude Code** → 4 reminders → 5 polish → 6 AI.
2. Claude suggestions while Tether is closed: **spooled to disk, imported on start**.
3. Claude's changes to existing tasks: **allowed as suggestions, applied only after approval**.
4. Backups: **local only**, `Documents\Tether\Backups`.
5. Database encryption: **none for now**.
6. Projects: **no seed data**; start with real projects entered on first run.

---

## Sources

- Tauri prerequisites: https://v2.tauri.app/start/prerequisites/
- Tauri releases: https://github.com/tauri-apps/tauri/releases
- Tauri SQL plugin: https://v2.tauri.app/plugin/sql/
- Tauri async runtime: https://docs.rs/tauri/latest/tauri/async_runtime/index.html
- System tray: https://v2.tauri.app/learn/system-tray/
- Single instance: https://v2.tauri.app/plugin/single-instance/
- Autostart: https://v2.tauri.app/plugin/autostart/
- Notification plugin (actions mobile-only): https://v2.tauri.app/plugin/notification/
- tauri-winrt-notification: https://github.com/tauri-apps/winrt-notification
- Windows installer: https://v2.tauri.app/distribute/windows-installer/
- Updater: https://v2.tauri.app/plugin/updater/
- Power events: https://learn.microsoft.com/en-us/windows/win32/power/pbt-apmresumeautomatic
- Chrome contextMenus: https://developer.chrome.com/docs/extensions/reference/api/contextMenus
- Chrome network requests: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Local Network Access: https://developer.chrome.com/blog/local-network-access
- chrome.storage: https://developer.chrome.com/docs/extensions/reference/api/storage
- chrome.alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Native Messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Claude Code MCP: https://code.claude.com/docs/en/mcp.md
- Claude Code hooks: https://code.claude.com/docs/en/hooks.md
- Claude Code plugins: https://code.claude.com/docs/en/plugins/overview.md
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Ollama GPU: https://docs.ollama.com/gpu
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Ollama FAQ (keep_alive): https://docs.ollama.com/faq
- chrono-node: https://github.com/wanasit/chrono
- SQLite FTS5: https://www.sqlite.org/fts5.html
