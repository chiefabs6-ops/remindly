# Tether

Local-first productivity assistant for Windows: a Tauri 2 desktop app, a Chrome extension and a Claude Code
plugin, all sharing one local SQLite database. Nothing leaves your PC.

Status: **Phase 0 spike** (proving tray, local API, SQLite and Windows notifications). See
[docs/PROPOSAL.md](docs/PROPOSAL.md) for the full plan.

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
npm run typecheck    # TypeScript check
npm run check:rust   # clippy + cargo test
```
