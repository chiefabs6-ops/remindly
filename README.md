# Tether

Local-first productivity assistant for Windows: a Tauri 2 desktop app, a Chrome extension and a Claude Code
plugin, all sharing one local SQLite database. Nothing leaves your PC.

Status: Phases 1–3 built (desktop app, Chrome extension, Claude Code plugin). See
[docs/PROPOSAL.md](docs/PROPOSAL.md) for the plan and the phase PRs for details.

## Requirements (Windows)

- Node.js 24+ and npm
- Rust (stable, `x86_64-pc-windows-msvc`) via rustup
- Visual Studio Build Tools 2022 with "Desktop development with C++"
- WebView2 (ships with Windows 11)

## Commands

```
npm install          # once, from the repo root
npm run dev          # run the desktop app in dev mode
npm run build        # build the NSIS installer (apps/desktop/src-tauri/target/release/bundle/nsis)
npm run update-app   # after the first install: rebuild tether.exe only, swap it in, restart Tether
npm run typecheck    # TypeScript check
npm run check:rust   # clippy + cargo test
```

## Chrome extension

See [apps/extension/README.md](apps/extension/README.md): build with `npm run build:extension`, load
`apps/extension/dist` unpacked, then pair from Tether's Settings → Chrome.

## Claude Code plugin

The plugin (`plugins/claude-tether`) adds Tether's MCP tools, a SessionStart hook and the
`/tether:handoff` skill to every project. Install it once from this repo's local marketplace:

```
claude plugin marketplace add C:\Users\danze\Desktop\Apps\tether
claude plugin install tether@tether-local
```

`plugins/claude-tether/dist` is committed (Claude Code runs it directly). After changing
`plugins/claude-tether/src`, run `npm run build:plugin` and commit the new `dist`.
