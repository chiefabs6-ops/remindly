# Tether for Chrome

Right-click selected text on any page and choose **Create Task**. The capture goes to the Tether
desktop app on this PC (`http://127.0.0.1:47821`) and waits on Tether's Today screen until you approve it.
If Tether is closed, captures are kept in the extension and sent when it is running again.

## Install (unpacked, for this PC)

1. Build: `npm run build:extension` from the repo root (output in `apps/extension/dist`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick `apps/extension/dist`.
3. In Tether, open **Settings → Chrome** and press **Pair Chrome**.
4. Click the Tether icon in Chrome's toolbar and type the 6-digit code (valid 2 minutes).

The manifest carries a fixed public `key`, so the extension ID (`admccjkmockfdflocgggjfgdacdodkdf`, shown on
`chrome://extensions`) stays the same wherever the folder lives. Pairing adds that origin to
Tether's allow-list; **Unpair all** in Tether's settings removes it and issues a new token.

## Permissions

`contextMenus`, `activeTab` (title and full selection of the tab you right-clicked, only then),
`scripting` (read the selection), `storage` (token, offline queue, last 10 captures), `alarms`
(retry the queue every minute), and host access to `http://127.0.0.1/*` only. No access to the
pages you visit beyond the one you right-click.

Chrome applies CORS to the extension's requests, so Tether answers preflights and sends
`Access-Control-Allow-Origin` for `chrome-extension://` origins only (never for websites).
