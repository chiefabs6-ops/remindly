import { useEffect, useState, type ReactNode } from "react";
import { api, errorMessage, type AiSettings, type BackupSettings, type ReminderSettings } from "../lib/api";
import { useAction, useSettings } from "../lib/queries";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Segmented, Toggle } from "../components/ui/Controls";

/** One section: title, one-line lead, then rows. */
function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`set-${title.replace(/ /g, "-")}`}>
      <h2 id={`set-${title.replace(/ /g, "-")}`}>{title}</h2>
      <p className="lead">{lead}</p>
      <div className="srows">{children}</div>
    </section>
  );
}

/** A row: label and small help on the left, the control on the right. */
function SRow({ label, help, htmlFor, children }: { label: string; help?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="l">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help && <small>{help}</small>}
      </div>
      {children !== undefined && <div className="r">{children}</div>}
    </div>
  );
}

function Status({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`status ${on ? "" : "off"}`}><i />{children}</span>;
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
    <>
      <SRow label="Extension" help="Install: open chrome://extensions, turn on Developer mode, choose Load unpacked and pick the apps\extension\dist folder. Then click the Tether icon and enter the code.">
        <Status on={count > 0}>{count === 0 ? "Chrome is not paired yet." : "Chrome is paired."}</Status>
        <button className="btn btn-sm btn-primary" disabled={start.isPending}
          onClick={() => start.mutate(undefined, { onSuccess: (r) => { setPairedAtStart(count > 0); setNow(Date.now()); setCode({ code: r.code, until: Date.now() + r.expiresInSecs * 1000 }); } })}>
          {code && left > 0 ? "New code" : "Pair Chrome"}
        </button>
        {count > 0 && (
          <button className="btn btn-sm btn-ghost btn-danger"
            onClick={() => confirm("Unpair Chrome? Tether issues a new token, so the extension must be paired again. Claude Code reads the new token by itself.") && unpair.mutate(undefined)}>
            Unpair all
          </button>
        )}
      </SRow>
      {code && left > 0 ? (
        <div className="srow">
          <div className="l">
            <span>Type this code in the Tether extension</span>
            <small className="num">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</small>
          </div>
          <div className="r"><p className="code num" aria-live="polite">{code.code}</p></div>
        </div>
      ) : null}
    </>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Reminders() {
  const q = useQuery({ queryKey: ["tether", "reminders"], queryFn: api.reminders });
  const [r, setR] = useState<ReminderSettings | null>(null);
  useEffect(() => {
    if (q.data) setR(q.data);
  }, [q.data]);
  const save = useAction((v: ReminderSettings) => api.setReminders(v));
  const test = useAction(() => api.testReminder());
  if (!r) return <div className="sskel" aria-busy="true" />;
  const dirty = JSON.stringify(r) !== JSON.stringify(q.data);
  const set = <K extends keyof ReminderSettings>(k: K, v: ReminderSettings[K]) => setR({ ...r, [k]: v });
  const num = (k: "dueSoonMinutes" | "overdueAfterMinutes" | "nudgeMinutes") => (e: { target: { value: string } }) => set(k, Math.max(0, Number(e.target.value) || 0));

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(r); }}>
      <SRow label="Reminders on" help="Windows notifications with Snooze, Tomorrow and Done buttons.">
        <Toggle label="Reminders on" checked={r.enabled} onChange={(v) => set("enabled", v)} />
      </SRow>
      <fieldset disabled={!r.enabled} className="sfs">
        <SRow label="Warn before a timed task (minutes)" htmlFor="r-soon">
          <input id="r-soon" type="number" min={0} className="field num w-24" value={r.dueSoonMinutes} onChange={num("dueSoonMinutes")} />
        </SRow>
        <SRow label="Remind again when overdue after (minutes)" htmlFor="r-over">
          <input id="r-over" type="number" min={0} className="field num w-24" value={r.overdueAfterMinutes} onChange={num("overdueAfterMinutes")} />
        </SRow>
        <SRow label="Morning briefing" help="Today's tasks, overdue work and suggestions waiting.">
          <input type="time" aria-label="Briefing time" className="field num w-28" value={r.briefingTime} onChange={(e) => set("briefingTime", e.target.value)} disabled={!r.briefingEnabled} />
          <Toggle label="Morning briefing" checked={r.briefingEnabled} onChange={(v) => set("briefingEnabled", v)} />
        </SRow>
        <SRow label="End-of-day review" help="Only when something is still open for today.">
          <input type="time" aria-label="Review time" className="field num w-28" value={r.reviewTime} onChange={(e) => set("reviewTime", e.target.value)} disabled={!r.reviewEnabled} />
          <Toggle label="End-of-day review" checked={r.reviewEnabled} onChange={(v) => set("reviewEnabled", v)} />
        </SRow>
        <SRow label="Nudge every (minutes, 0 = off)" htmlFor="r-nudge">
          <input id="r-nudge" type="number" min={0} className="field num w-24" value={r.nudgeMinutes} onChange={num("nudgeMinutes")} />
        </SRow>
        <SRow label="Working hours" help="Nudges and repeats only happen inside these hours.">
          <input type="time" aria-label="Work starts" className="field num w-28" value={r.workStart} onChange={(e) => set("workStart", e.target.value)} />
          <span className="muted">to</span>
          <input type="time" aria-label="Work ends" className="field num w-28" value={r.workEnd} onChange={(e) => set("workEnd", e.target.value)} />
        </SRow>
        <SRow label="Work days" help="Briefing, review and nudges.">
          <div role="group" aria-label="Work days" className="days">
            {DAYS.map((d, i) => {
              const n = i + 1;
              const on = r.workDays.includes(n);
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => set("workDays", on ? r.workDays.filter((x) => x !== n) : [...r.workDays, n].sort())}>
                  {d}
                </button>
              );
            })}
          </div>
        </SRow>
      </fieldset>
      <div className="sfoot">
        <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>Save reminders</button>
        <button type="button" className="btn" onClick={() => test.mutate(undefined)}>Send a test notification</button>
        {!dirty && save.isSuccess && <span className="muted">Saved</span>}
        {save.isError && <span className="err">{errorMessage(save.error)}</span>}
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
  if (!b) return <div className="sskel" aria-busy="true" />;
  const dirty = b.autoDaily !== cfg.data?.autoDaily || b.dir !== cfg.data?.dir || b.keepDaily !== cfg.data?.keepDaily || b.keepWeekly !== cfg.data?.keepWeekly;
  const list = files.data ?? [];
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString("en-IE")} KB`;
  const err = save.error ?? now.error ?? restore.error ?? exp.error ?? health.error;

  return (
    <>
      <SRow label="Database" help={
        <span className={health.data && health.data !== "ok" ? "err" : ""}>
          Database check: {health.data === "ok" ? "healthy" : health.data ? `problem found (${health.data}) — restore a backup below` : "…"}
        </span>
      } />
      <SRow label="Back up now" help={now.data ? `Saved ${now.data.name}` : "A copy of your database, kept until you delete it."}>
        <button className="btn btn-sm btn-primary" disabled={now.isPending} onClick={() => now.mutate(undefined)}>Back up now</button>
        <button className="btn btn-sm" disabled={exp.isPending} onClick={() => exp.mutate(undefined)}>Export as JSON</button>
      </SRow>
      {exp.data && (
        <SRow label="Exported" help={<span className="break-all">Exported to {exp.data}</span>}>
          <button className="btn btn-sm btn-ghost" onClick={() => api.reveal(exp.data!)}>Show</button>
        </SRow>
      )}
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(b); }}>
        <SRow label="Back up automatically every day" help={`Keeps the last ${b.keepDaily} days and ${b.keepWeekly} weekly copies. Your own backups are never deleted.`}>
          <Toggle label="Back up automatically every day" checked={b.autoDaily} onChange={(v) => setB({ ...b, autoDaily: v })} />
        </SRow>
        <SRow label="Backup folder" htmlFor="b-dir" help={`Leave empty for ${cfg.data?.folder}. Copy this folder to move Tether to another PC.`}>
          <input id="b-dir" className="field w-72" placeholder={cfg.data?.folder} value={b.dir} onChange={(e) => setB({ ...b, dir: e.target.value })} />
        </SRow>
        <SRow label="Daily copies" htmlFor="b-days">
          <input id="b-days" type="number" min={1} max={60} className="field num w-24" value={b.keepDaily} onChange={(e) => setB({ ...b, keepDaily: Number(e.target.value) || 1 })} />
        </SRow>
        <SRow label="Weekly copies" htmlFor="b-weeks">
          <input id="b-weeks" type="number" min={0} max={52} className="field num w-24" value={b.keepWeekly} onChange={(e) => setB({ ...b, keepWeekly: Number(e.target.value) || 0 })} />
        </SRow>
        {cfg.data?.lastError && (
          <p className="err pad">The last automatic backup failed: {cfg.data.lastError}. It tries again tomorrow; use Back up now to retry.</p>
        )}
        <div className="sfoot"><button className="btn" disabled={!dirty || save.isPending}>Save backup settings</button></div>
      </form>
      <div className="srow stack">
        <div className="l"><span>Backups in this folder <span className="num muted">{list.length}</span></span></div>
        {list.length === 0 ? (
          <p className="sempty">No backups yet.</p>
        ) : (
          <ul className="blist">
            {list.map((f) => (
              <li key={f.name}>
                <span className="num flex-1">{f.takenAt}{f.name.includes("-auto") ? " · automatic" : f.name.includes("before-restore") ? " · before a restore" : ""}</span>
                <span className="num size">{kb(f.bytes)}</span>
                <button className="btn btn-sm btn-ghost" disabled={restore.isPending}
                  onClick={() => confirm(`Restore the backup from ${f.takenAt}? Your current data is backed up first, then replaced.`) && restore.mutate(f.name)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
        {restore.data && <p className="muted">Restored. Your previous data is in {restore.data.name}.</p>}
      </div>
      {err && <p className="err pad">{errorMessage(err)}</p>}
    </>
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
  if (!a) return <div className="sskel" aria-busy="true" />;
  const dirty = JSON.stringify(a) !== JSON.stringify(cfg.data);
  const st = status.data;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(a, { onSuccess: () => status.refetch() }); }}>
      <SRow label="Use local AI"
        help="Adds “Suggest with AI” and “Break into steps”. Results are suggestions you confirm. Text never leaves this PC. A small model (qwen2.5:1.5b, about 1 GB, loaded only while working) is enough.">
        <Status on={!!st?.enabled && !!st.reachable}>{st?.enabled ? (st.reachable ? "On" : "Not running") : "Off"}</Status>
        <Toggle label="Use local AI" checked={a.enabled} onChange={(v) => setA({ ...a, enabled: v })} />
      </SRow>
      <SRow label="Model" htmlFor="ai-model">
        <input id="ai-model" className="field w-56" value={a.model} onChange={(e) => setA({ ...a, model: e.target.value })} />
      </SRow>
      <SRow label="Ollama address (this PC only)" htmlFor="ai-url"
        help={!st ? "Checking Ollama…" : !st.enabled ? "Local AI is off. Turn it on and Save to check Ollama." :
          !st.reachable ? "Ollama is not running. Install it from ollama.com and start it." :
          st.modelInstalled ? `Ollama ${st.version} is running and ${cfg.data?.model} is installed.` :
          `Ollama ${st.version} is running, but ${cfg.data?.model} is not installed. Run: ollama pull ${cfg.data?.model}`}>
        <input id="ai-url" className="field w-56" value={a.url} onChange={(e) => setA({ ...a, url: e.target.value })} />
      </SRow>
      <div className="sfoot">
        <button className="btn btn-primary" disabled={!dirty || save.isPending}>Save</button>
        <button type="button" className="btn" disabled={!cfg.data?.enabled || test.isPending} onClick={() => test.mutate(undefined)}>
          {test.isPending ? "Thinking…" : "Try it"}
        </button>
        {test.data && <span className="num muted">{test.data.tokensPerSecond.toFixed(1)} tokens/s on this PC</span>}
      </div>
      {test.data && <p className="sample">Example: “{test.data.value.title}”{test.data.value.dueDate ? `, due ${test.data.value.dueDate}` : ""}</p>}
      {(save.error ?? test.error) && <p className="err pad">{errorMessage(save.error ?? test.error)}</p>}
    </form>
  );
}

function Startup() {
  const q = useQuery({ queryKey: ["tether", "autostart"], queryFn: api.autostart });
  const set = useAction((v: boolean) => api.setAutostart(v));
  return (
    <>
      <SRow label="Start Tether when I sign in" help="Tether starts hidden in the tray so reminders work all day. Closing the window keeps it running; Quit is in the tray menu.">
        <Toggle label="Start Tether when I sign in" checked={!!q.data} onChange={(v) => set.mutate(v)} />
      </SRow>
      {(q.isError || set.isError) && <p className="err pad">{errorMessage(q.error ?? set.error)}</p>}
    </>
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
  { id: "calendar", label: "Calendar" },
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
    <div className="set">
      <nav aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => choose(s.id)} aria-current={section === s.id ? "page" : undefined} className={section === s.id ? "on" : ""}>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="set-main">
        <h1>Settings</h1>

        {section === "appearance" && (
          <Section title="Appearance" lead="Follow Windows, or pick light or dark.">
            <SRow label="Theme">
              <Segmented label="Theme" value={theme} onChange={(t) => setTheme.mutate(t)}
                options={[{ value: "system", label: "Match Windows" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            </SRow>
          </Section>
        )}

        {section === "reminders" && (
          <Section title="Reminders" lead="When and how Tether reminds you. Notifications come from the tray, even with the window closed.">
            <Reminders />
          </Section>
        )}

        {section === "backups" && (
          <Section title="Backups" lead="Copies of your database on this PC. Nothing is written until you back up or turn on daily backups.">
            <Backups />
          </Section>
        )}

        {section === "ai" && (
          <Section title="Local AI" lead="Optional. Uses Ollama on this PC; off unless you turn it on. Everything works without it.">
            <LocalAi />
          </Section>
        )}

        {section === "startup" && (
          <Section title="Startup" lead="Off by default.">
            <Startup />
          </Section>
        )}

        {section === "connection" && (
          <Section title="Local connection" lead="The Chrome extension and Claude Code reach Tether here. It only accepts requests from this PC that carry the secret token.">
            <SRow label="Address"><span className="num">{info.data?.url ?? "—"}</span></SRow>
            <SRow label="Token"><span className="num">•••• {info.data?.tokenHint ?? ""}</span></SRow>
            <SRow label="Data folder"><span className="break-all">{info.data?.dataDir ?? "—"}</span></SRow>
          </Section>
        )}

        {section === "chrome" && (
          <Section title="Chrome" lead="Right-click selected text on any page and choose Create Task. Captures wait in your Inbox until you approve them.">
            <ChromePairing />
          </Section>
        )}

        {section === "calendar" && (
          <Section title="Calendar" lead="Show your meetings next to your tasks. Read-only.">
            <SRow label="Google Calendar" help="Shows your meetings next to your tasks. Not available yet.">
              <Status on={false}>Off</Status>
              <span className="pill">Coming later</span>
              <button type="button" className="btn btn-sm" disabled>Connect</button>
            </SRow>
          </Section>
        )}

        {section === "keyboard" && (
          <Section title="Keyboard" lead="Capture and find things without the mouse.">
            <SRow label="Add a task"><kbd className="pill">Ctrl N</kbd></SRow>
            <SRow label="Search tasks"><kbd className="pill">Ctrl K</kbd></SRow>
            <SRow label="Clear the add box"><kbd className="pill">Esc</kbd></SRow>
          </Section>
        )}
      </div>
    </div>
  );
}
