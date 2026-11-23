# Phase 0 spike — findings

Date: 2026-11-23. Machine: i5-1135G7, 15.8 GB RAM, Iris Xe, Windows 11 Home 10.0.26300.
Build: Tauri 2 (React-TS template), Rust 1.100.0 MSVC, release NSIS installer.

## Results

| Check | Result | Evidence |
|---|---|---|
| Toolchain | ✅ rustc/cargo 1.100.0, VS Build Tools 2022 | `cargo build`, `tauri build` succeed |
| Release build time (first, LTO, 4 cores) | ~8–10 min cold; incremental dev builds are seconds | build log |
| Installer | ✅ `Tether_0.1.0_x64-setup.exe`, 2.29 MiB, per-user to `%LOCALAPPDATA%\Tether`, no admin, silent `/S` works | installed |
| Toast AUMID | ✅ NSIS Start Menu shortcut registers AUMID `ie.tether.app` (= Tauri `identifier`) | `shell:AppsFolder` lists `Tether => ie.tether.app` |
| Toast with buttons | ✅ "Snooze 15m" button click delivered `action=snooze_15m` to the running app via `tauri-winrt-notification` 0.8.1 | `spike.log`: `toast: activated action=snooze_15m` |
| Toast timeout | Unclicked toasts report `ToastDismissalReason(2)` (TimedOut) | `spike.log` |
| Local API | ✅ axum on `127.0.0.1:47821` inside Tauri's Tokio runtime; `/v1/health` 200; `/v1/status` without token 401 | `Invoke-RestMethod` |
| SQLite | ✅ rusqlite 0.43 (bundled), `journal_mode=wal`, `-wal`/`-shm` files present | `%APPDATA%\ie.tether.app\spike.db*`, unit test |
| Close to tray | ✅ closing the window destroys the webview; `RunEvent::ExitRequested{code: None}` + `prevent_exit()` keeps the app running | process still alive |
| Single instance | ✅ second launch → still 1 `tether.exe`, window re-created | process count |
| RAM, window open | `tether.exe` 38 MB + 6 WebView2 processes ≈ 320–340 MB summed working set (overcounts shared pages) | `Get-Process` |
| RAM, window closed (tray only) | ✅ **38 MB total**, 0 WebView2 processes | `Get-Process` |

## Decisions confirmed by the spike

- Keep `tauri-winrt-notification` for reminders (stock plugin has no Windows actions).
- Destroy the window on close; re-create from tray / second launch. Re-open cost is acceptable.
- Data folder is `%APPDATA%\ie.tether.app` (Tauri `app_data_dir`); the proposal now uses this path.
- The main window is configured `visible: false` and shown in `setup` unless started with `--autostart`, so nothing flashes at login.

## Not yet tested (moved to the phase that needs it)

- RAM with the window *hidden* (not destroyed) — skipped; destroy-on-close is the chosen design and measured at 38 MB.
- Phase 1 hardening from review: constant-time token compare, `Host` header allow-list (DNS rebinding), no token in the webview, lock errors mapped instead of `unwrap()`.

- Autostart registry entry (plugin registered but not enabled) — Phase 4.
- Toast clicks after the app has quit (needs COM activator; not needed while tray app runs) — Phase 4.
- Focus Assist behaviour — Phase 4.
- Authorised `/v1/status` call with the token (token is per-run in the spike, shown only in the UI) — covered properly in Phase 1 API tests.

## Spike code

`apps/desktop/src-tauri/src/lib.rs` is spike-quality. Phase 1 replaces it with the structured core (`db/`, `api/`,
`scheduler/`, `notify/`) described in the proposal §14; the patterns above are reused.
