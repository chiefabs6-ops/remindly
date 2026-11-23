import { useEffect, useState, type ReactNode } from "react";
import { api, errorMessage, type AiSettings, type BackupSettings, type ReminderSettings } from "../lib/api";
import { useAction, useSettings } from "../lib/queries";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 mb-4 text-muted">{help}</p>
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

function Backups() {
  const cfg = useQuery({ queryKey: ["tether", "backup-settings"], queryFn: api.backupSettings });
  const files = useQuery({ queryKey: ["tether", "backups"], queryFn: api.backups });
  const health = useQuery({ queryKey: ["tether", "db-health"], queryFn: api.dbHealth });
  const [b, setB] = useState<BackupSettings | null>(null);
  useEffect(() => {
    if (cfg.data) setB(cfg.data);
  }, [cfg.data]);
  const save = useAction((v: BackupSettings) => api.setBackupSettings(v));
  const now = useAction(() => api.backupNow());
  const restore = useAction((name: string) => api.restoreBackup(name));
  const exp = useAction(() => api.exportJson());
  if (!b) return <div className="h-32 rounded-[8px] bg-active" aria-busy="true" />;
  const dirty = b.autoDaily !== cfg.data?.autoDaily || b.dir !== cfg.data?.dir || b.keepDaily !== cfg.data?.keepDaily || b.keepWeekly !== cfg.data?.keepWeekly;
  const list = files.data ?? [];
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString("en-IE")} KB`;
  const err = save.error ?? now.error ?? restore.error ?? exp.error ?? health.error;

  return (
    <div className="space-y-3">
      <p className={health.data && health.data !== "ok" ? "text-negative" : "text-muted"}>
        Database check: {health.data === "ok" ? "healthy" : health.data ? `problem found (${health.data}) — restore a backup below` : "…"}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={now.isPending} onClick={() => now.mutate(undefined)}>Back up now</button>
        <button className="btn" disabled={exp.isPending} onClick={() => exp.mutate(undefined)}>Export as JSON</button>
      </div>
      {now.data && <p className="text-xs text-muted">Saved {now.data.name}</p>}
      {exp.data && (
        <p className="text-xs text-muted break-all">
          Exported to {exp.data} <button className="underline" onClick={() => api.reveal(exp.data!)}>Show</button>
        </p>
      )}
      <form className="space-y-1 pt-2" onSubmit={(e) => { e.preventDefault(); save.mutate(b); }}>
        <Toggle id="b-auto" label="Back up automatically every day" checked={b.autoDaily} onChange={(v) => setB({ ...b, autoDaily: v })}
          hint={`Keeps the last ${b.keepDaily} days and ${b.keepWeekly} weekly copies. Your own backups are never deleted.`} />
        <div>
          <label className="label" htmlFor="b-dir">Backup folder</label>
          <input id="b-dir" className="field" placeholder={cfg.data?.folder} value={b.dir} onChange={(e) => setB({ ...b, dir: e.target.value })} />
          <p className="mt-1 text-xs text-muted">Leave empty for {cfg.data?.folder}. Copy this folder to move Tether to another PC.</p>
        </div>
        <div className="flex gap-3">
          <div className="w-32">
            <label className="label" htmlFor="b-days">Daily copies</label>
            <input id="b-days" type="number" min={1} max={60} className="field" value={b.keepDaily} onChange={(e) => setB({ ...b, keepDaily: Number(e.target.value) || 1 })} />
          </div>
          <div className="w-32">
            <label className="label" htmlFor="b-weeks">Weekly copies</label>
            <input id="b-weeks" type="number" min={0} max={52} className="field" value={b.keepWeekly} onChange={(e) => setB({ ...b, keepWeekly: Number(e.target.value) || 0 })} />
          </div>
        </div>
        {cfg.data?.lastError && (
          <p className="text-negative">The last automatic backup failed: {cfg.data.lastError}. It tries again tomorrow; use Back up now to retry.</p>
        )}
        <div className="pt-2"><button className="btn" disabled={!dirty || save.isPending}>Save backup settings</button></div>
      </form>
      <div className="pt-2">
        <p className="label">Backups in this folder <span className="num">{list.length}</span></p>
        {list.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-line px-3 py-2.5 text-muted">No backups yet.</p>
        ) : (
          <ul className="max-h-[320px] overflow-y-auto rounded-[8px] border border-line">
            {list.map((f) => (
              <li key={f.name} className="flex items-center gap-3 border-b border-rule px-3 py-2 last:border-0">
                <span className="num flex-1">{f.takenAt}{f.name.includes("-auto") ? " · automatic" : f.name.includes("before-restore") ? " · before a restore" : ""}</span>
                <span className="num w-20 text-right text-xs text-muted">{kb(f.bytes)}</span>
                <button className="btn btn-ghost h-8" disabled={restore.isPending}
                  onClick={() => confirm(`Restore the backup from ${f.takenAt}? Your current data is backed up first, then replaced.`) && restore.mutate(f.name)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
        {restore.data && <p className="mt-2 text-xs text-muted">Restored. Your previous data is in {restore.data.name}.</p>}
      </div>
      {err && <p className="text-negative">{errorMessage(err)}</p>}
    </div>
  );
}

function LocalAi() {
  const cfg = useQuery({ queryKey: ["tether", "ai-settings"], queryFn: api.aiSettings });
  const status = useQuery({ queryKey: ["tether", "ai-status"], queryFn: api.aiStatus });
  const [a, setA] = useState<AiSettings | null>(null);
  useEffect(() => {
    if (cfg.data) setA(cfg.data);
  }, [cfg.data]);
  const save = useAction((v: AiSettings) => api.setAiSettings(v));
  const test = useAction(() => api.aiExtract("Please send the updated teacher list to the programme lead before Friday", null));
  if (!a) return <div className="h-24 rounded-[8px] bg-active" aria-busy="true" />;
  const dirty = JSON.stringify(a) !== JSON.stringify(cfg.data);
  const st = status.data;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(a, { onSuccess: () => status.refetch() }); }}>
      <Toggle id="ai-on" label="Use local AI" checked={a.enabled} onChange={(v) => setA({ ...a, enabled: v })}
        hint="Adds “Suggest with AI” and “Break into steps”. Results are suggestions you confirm. Text never leaves this PC. A small model (qwen2.5:1.5b, about 1 GB, loaded only while working) is enough." />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="ai-model">Model</label>
          <input id="ai-model" className="field" value={a.model} onChange={(e) => setA({ ...a, model: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ai-url">Ollama address (this PC only)</label>
          <input id="ai-url" className="field" value={a.url} onChange={(e) => setA({ ...a, url: e.target.value })} />
        </div>
      </div>
      <p className="text-[13px] text-muted">
        {!st ? "Checking Ollama…" : !st.enabled ? "Local AI is off. Turn it on and Save to check Ollama." :
          !st.reachable ? "Ollama is not running. Install it from ollama.com and start it." :
          st.modelInstalled ? `Ollama ${st.version} is running and ${cfg.data?.model} is installed.` :
          `Ollama ${st.version} is running, but ${cfg.data?.model} is not installed. Run: ollama pull ${cfg.data?.model}`}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button className="btn btn-primary" disabled={!dirty || save.isPending}>Save</button>
        <button type="button" className="btn" disabled={!cfg.data?.enabled || test.isPending} onClick={() => test.mutate(undefined)}>
          {test.isPending ? "Thinking…" : "Try it"}
        </button>
        {test.data && <span className="num text-xs text-muted">{test.data.tokensPerSecond.toFixed(1)} tokens/s on this PC</span>}
      </div>
      {test.data && <p className="rounded-[8px] bg-raised p-3">Example: “{test.data.value.title}”{test.data.value.dueDate ? `, due ${test.data.value.dueDate}` : ""}</p>}
      {(save.error ?? test.error) && <p className="text-negative">{errorMessage(save.error ?? test.error)}</p>}
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

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "reminders", label: "Reminders" },
  { id: "backups", label: "Backups" },
  { id: "ai", label: "Local AI" },
  { id: "startup", label: "Startup" },
  { id: "connection", label: "Local connection" },
  { id: "chrome", label: "Chrome" },
  { id: "keyboard", label: "Keyboard" },
] as const;

export function SettingsScreen() {
  const settings = useSettings();
  const info = useQuery({ queryKey: ["tether", "api-info"], queryFn: api.apiInfo });
  const setTheme = useAction((t: string) => api.setSetting("theme", t));
  const theme = (settings.data?.theme as string | undefined) ?? "system";
  const [params, setParams] = useSearchParams();
  const wanted = params.get("section");
  const section = SECTIONS.find((s) => s.id === wanted)?.id ?? SECTIONS[0].id;
  const choose = (id: string) => setParams({ section: id }, { replace: true });

  return (
    <div className="px-6 py-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">Settings</h1>
      <p className="mt-1 mb-4 text-muted">Everything is stored on this PC.</p>

      <div className="md:flex md:items-start md:gap-8">
        <nav aria-label="Settings sections" className="mb-4 flex gap-1 overflow-x-auto md:mb-0 md:w-[200px] md:shrink-0 md:flex-col md:overflow-visible">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => choose(s.id)} aria-current={section === s.id ? "page" : undefined}
              className={`h-8 shrink-0 whitespace-nowrap rounded-[6px] px-3 text-left ${section === s.id ? "bg-active font-medium" : "text-muted hover:bg-active"}`}>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 max-w-[720px] flex-1">
          {section === "appearance" && (
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
          )}

          {section === "reminders" && (
            <Row title="Reminders" help="When and how Tether reminds you. Notifications come from the tray, even with the window closed.">
              <Reminders />
            </Row>
          )}

          {section === "backups" && (
            <Row title="Backups" help="Copies of your database on this PC. Nothing is written until you back up or turn on daily backups.">
              <Backups />
            </Row>
          )}

          {section === "ai" && (
            <Row title="Local AI" help="Optional. Uses Ollama on this PC; off unless you turn it on. Everything works without it.">
              <LocalAi />
            </Row>
          )}

          {section === "startup" && (
            <Row title="Startup" help="Off by default.">
              <Startup />
            </Row>
          )}

          {section === "connection" && (
            <Row title="Local connection" help="The Chrome extension and Claude Code reach Tether here. It only accepts requests from this PC that carry the secret token.">
              <dl className="grid grid-cols-[140px_1fr] gap-y-2">
                <dt className="text-muted">Address</dt><dd className="num">{info.data?.url ?? "—"}</dd>
                <dt className="text-muted">Token</dt><dd className="num">•••• {info.data?.tokenHint ?? ""}</dd>
                <dt className="text-muted">Data folder</dt><dd className="break-all">{info.data?.dataDir ?? "—"}</dd>
              </dl>
            </Row>
          )}

          {section === "chrome" && (
            <Row title="Chrome" help="Right-click selected text on any page and choose Create Task. Captures wait in your Inbox until you approve them.">
              <ChromePairing />
            </Row>
          )}

          {section === "keyboard" && (
            <Row title="Keyboard" help="Capture and find things without the mouse.">
              <dl className="grid grid-cols-[140px_1fr] gap-y-2">
                <dt><kbd className="pill">Ctrl N</kbd></dt><dd>Add a task</dd>
                <dt><kbd className="pill">Ctrl K</kbd></dt><dd>Search tasks</dd>
                <dt><kbd className="pill">Esc</kbd></dt><dd>Clear the add box</dd>
              </dl>
            </Row>
          )}
        </div>
      </div>
    </div>
  );
}
