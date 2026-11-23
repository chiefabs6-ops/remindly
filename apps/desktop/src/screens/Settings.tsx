import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useAction, useSettings } from "../lib/queries";
import { useQuery } from "@tanstack/react-query";

function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-line py-8 first:pt-2 last:border-0 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-muted">{help}</p>
      </div>
      <div className="rounded-[8px] bg-surface p-4">{children}</div>
    </section>
  );
}

export function SettingsScreen() {
  const settings = useSettings();
  const info = useQuery({ queryKey: ["tether", "api-info"], queryFn: api.apiInfo });
  const setTheme = useAction((t: string) => api.setSetting("theme", t));
  const theme = (settings.data?.theme as string | undefined) ?? "system";

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">Settings</h1>
      <p className="mt-1 mb-4 text-muted">Everything is stored on this PC. Reminders and backups arrive in later phases.</p>

      <Row title="Appearance" help="Follow Windows, or pick light or dark.">
        <fieldset>
          <legend className="label">Theme</legend>
          <div className="flex gap-1 rounded-[6px] bg-active p-0.5 sm:w-fit">
            {(["system", "light", "dark"] as const).map((t) => (
              <label key={t} className={`flex h-8 flex-1 cursor-pointer items-center justify-center rounded-[5px] px-4 text-[13px] ${theme === t ? "bg-surface font-medium" : "text-muted"}`}>
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme.mutate(t)} className="sr-only" />
                {t === "system" ? "Match Windows" : t[0].toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
      </Row>

      <Row title="Local connection" help="The Chrome extension and Claude Code reach Tether here. It only accepts requests from this PC that carry the secret token.">
        <dl className="grid grid-cols-[140px_1fr] gap-y-2">
          <dt className="text-muted">Address</dt><dd className="num">{info.data?.url ?? "—"}</dd>
          <dt className="text-muted">Token</dt><dd className="num">•••• {info.data?.tokenHint ?? ""}</dd>
          <dt className="text-muted">Data folder</dt><dd className="break-all">{info.data?.dataDir ?? "—"}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted">Pairing the Chrome extension arrives in the next phase.</p>
      </Row>

      <Row title="Keyboard" help="Capture and find things without the mouse.">
        <dl className="grid grid-cols-[140px_1fr] gap-y-2">
          <dt><kbd className="pill">Ctrl N</kbd></dt><dd>Add a task</dd>
          <dt><kbd className="pill">Ctrl K</kbd></dt><dd>Search tasks</dd>
          <dt><kbd className="pill">Esc</kbd></dt><dd>Clear the add box</dd>
        </dl>
      </Row>
    </div>
  );
}
