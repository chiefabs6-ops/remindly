import { useEffect, useState, type ReactNode } from "react";
import { api, errorMessage, type ReminderSettings } from "../lib/api";
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

function ChromePairing() {
  const browsers = useQuery({ queryKey: ["tether", "paired"], queryFn: api.pairedBrowsers, refetchInterval: 3000 });
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const start = useAction(() => api.startPairing());
  const unpair = useAction(() => api.unpairAll());
  const count = browsers.data?.length ?? 0;
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  // Paired while a code is showing: the code was used (re-pairing keeps the count at 1, so
  // compare against the moment the code was issued).
  const [pairedAtStart, setPairedAtStart] = useState(false);
  useEffect(() => {
    if (code && count > 0 && !pairedAtStart) setCode(null);
  }, [count, code, pairedAtStart]);

  return (
    <div className="space-y-3">
      <p>
        {count === 0 ? "Chrome is not paired yet." : "Chrome is paired."}
      </p>
      {code && left > 0 ? (
        <div className="rounded-[8px] bg-raised p-3">
          <p className="label">Type this code in the Tether extension</p>
          <p className="num text-2xl font-semibold tracking-[0.2em]" aria-live="polite">{code.code}</p>
          <p className="num text-xs text-muted">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={start.isPending}
          onClick={() => start.mutate(undefined, { onSuccess: (r) => { setPairedAtStart(count > 0); setNow(Date.now()); setCode({ code: r.code, until: Date.now() + r.expiresInSecs * 1000 }); } })}>
          {code && left > 0 ? "New code" : "Pair Chrome"}
        </button>
        {count > 0 && (
          <button className="btn btn-ghost btn-danger"
            onClick={() => confirm("Unpair Chrome? Tether issues a new token, so the extension must be paired again. Claude Code reads the new token by itself.") && unpair.mutate(undefined)}>
            Unpair all
          </button>
        )}
      </div>
      <p className="text-xs text-muted">
        Install: open chrome://extensions, turn on Developer mode, choose Load unpacked and pick the
        apps\extension\dist folder. Then click the Tether icon and enter the code.
      </p>
    </div>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Toggle({ id, label, checked, onChange, hint }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <label htmlFor={id} className="font-medium">{label}</label>
        {hint && <p className="text-[13px] text-muted">{hint}</p>}
      </div>
      <input id={id} type="checkbox" role="switch" className="mt-1 size-4 accent-[var(--primary)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

function Reminders() {
  const q = useQuery({ queryKey: ["tether", "reminders"], queryFn: api.reminders });
  const [r, setR] = useState<ReminderSettings | null>(null);
  useEffect(() => {
    if (q.data) setR(q.data);
  }, [q.data]);
  const save = useAction((v: ReminderSettings) => api.setReminders(v));
  const test = useAction(() => api.testReminder());
  if (!r) return <div className="h-40 rounded-[8px] bg-active" aria-busy="true" />;
  const dirty = JSON.stringify(r) !== JSON.stringify(q.data);
  const set = <K extends keyof ReminderSettings>(k: K, v: ReminderSettings[K]) => setR({ ...r, [k]: v });
  const num = (k: "dueSoonMinutes" | "overdueAfterMinutes" | "nudgeMinutes") => (e: { target: { value: string } }) => set(k, Math.max(0, Number(e.target.value) || 0));

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(r); }} className="space-y-1">
      <Toggle id="r-on" label="Reminders on" checked={r.enabled} onChange={(v) => set("enabled", v)} hint="Windows notifications with Snooze, Tomorrow and Done buttons." />
      <fieldset disabled={!r.enabled} className="space-y-1 disabled:opacity-60">
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <label className="label" htmlFor="r-soon">Warn before a timed task (minutes)</label>
            <input id="r-soon" type="number" min={0} className="field" value={r.dueSoonMinutes} onChange={num("dueSoonMinutes")} />
          </div>
          <div>
            <label className="label" htmlFor="r-over">Remind again when overdue after (minutes)</label>
            <input id="r-over" type="number" min={0} className="field" value={r.overdueAfterMinutes} onChange={num("overdueAfterMinutes")} />
          </div>
        </div>
        <Toggle id="r-brief" label="Morning briefing" checked={r.briefingEnabled} onChange={(v) => set("briefingEnabled", v)} hint="Today's tasks, overdue work and suggestions waiting." />
        <div className="w-40 pb-2">
          <label className="label" htmlFor="r-brief-t">Briefing time</label>
          <input id="r-brief-t" type="time" className="field" value={r.briefingTime} onChange={(e) => set("briefingTime", e.target.value)} disabled={!r.briefingEnabled} />
        </div>
        <Toggle id="r-rev" label="End-of-day review" checked={r.reviewEnabled} onChange={(v) => set("reviewEnabled", v)} hint="Only when something is still open for today." />
        <div className="w-40 pb-2">
          <label className="label" htmlFor="r-rev-t">Review time</label>
          <input id="r-rev-t" type="time" className="field" value={r.reviewTime} onChange={(e) => set("reviewTime", e.target.value)} disabled={!r.reviewEnabled} />
        </div>
        <div className="grid grid-cols-3 gap-3 py-2">
          <div>
            <label className="label" htmlFor="r-nudge">Nudge every (minutes, 0 = off)</label>
            <input id="r-nudge" type="number" min={0} className="field" value={r.nudgeMinutes} onChange={num("nudgeMinutes")} />
          </div>
          <div>
            <label className="label" htmlFor="r-ws">Work starts</label>
            <input id="r-ws" type="time" className="field" value={r.workStart} onChange={(e) => set("workStart", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="r-we">Work ends</label>
            <input id="r-we" type="time" className="field" value={r.workEnd} onChange={(e) => set("workEnd", e.target.value)} />
          </div>
        </div>
        <fieldset className="py-2">
          <legend className="label">Work days (briefing, review and nudges)</legend>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((d, i) => {
              const n = i + 1;
              const on = r.workDays.includes(n);
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => set("workDays", on ? r.workDays.filter((x) => x !== n) : [...r.workDays, n].sort())}
                  className={`h-8 w-12 rounded-[6px] text-[13px] ${on ? "bg-primary text-primary-ink" : "bg-active text-muted"}`}>
                  {d}
                </button>
              );
            })}
          </div>
        </fieldset>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>Save reminders</button>
        <button type="button" className="btn" onClick={() => test.mutate(undefined)}>Send a test notification</button>
        {!dirty && save.isSuccess && <span className="text-xs text-muted">Saved</span>}
        {save.isError && <span className="text-negative">{errorMessage(save.error)}</span>}
      </div>
    </form>
  );
}

function Startup() {
  const q = useQuery({ queryKey: ["tether", "autostart"], queryFn: api.autostart });
  const set = useAction((v: boolean) => api.setAutostart(v));
  return (
    <div>
      <Toggle id="autostart" label="Start Tether when I sign in" checked={!!q.data} onChange={(v) => set.mutate(v)}
        hint="Tether starts hidden in the tray so reminders work all day. Closing the window keeps it running; Quit is in the tray menu." />
      {(q.isError || set.isError) && <p className="text-negative">{errorMessage(q.error ?? set.error)}</p>}
    </div>
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
      <p className="mt-1 mb-4 text-muted">Everything is stored on this PC.</p>

      <Row title="Appearance" help="Follow Windows, or pick light or dark.">
        <fieldset>
          <legend className="label">Theme</legend>
          <div className="flex gap-1 rounded-[6px] bg-active p-0.5 sm:w-fit">
            {(["system", "light", "dark"] as const).map((t) => (
              <label key={t} className={`flex h-8 flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-[5px] px-4 text-[13px] ${theme === t ? "bg-surface font-medium" : "text-muted"}`}>
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme.mutate(t)} className="sr-only" />
                {t === "system" ? "Match Windows" : t[0].toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
      </Row>

      <Row title="Reminders" help="When and how Tether reminds you. Notifications come from the tray, even with the window closed.">
        <Reminders />
      </Row>

      <Row title="Startup" help="Off by default.">
        <Startup />
      </Row>

      <Row title="Local connection" help="The Chrome extension and Claude Code reach Tether here. It only accepts requests from this PC that carry the secret token.">
        <dl className="grid grid-cols-[140px_1fr] gap-y-2">
          <dt className="text-muted">Address</dt><dd className="num">{info.data?.url ?? "—"}</dd>
          <dt className="text-muted">Token</dt><dd className="num">•••• {info.data?.tokenHint ?? ""}</dd>
          <dt className="text-muted">Data folder</dt><dd className="break-all">{info.data?.dataDir ?? "—"}</dd>
        </dl>
      </Row>

      <Row title="Chrome" help="Right-click selected text on any page and choose Create Task. Captures wait in your Inbox until you approve them.">
        <ChromePairing />
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
