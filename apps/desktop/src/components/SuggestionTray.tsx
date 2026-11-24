// Claude's suggested tasks, collapsed at the top of My Tasks (mockup E). Nothing is added until you approve.
import { useState } from "react";
import { CalendarDays, Check as CheckIcon, ChevronDown, X } from "lucide-react";
import { relativeDayLabel, type Project, type SuggestedTask, type Suggestion } from "@tether/core";
import { api, errorMessage } from "../lib/api";
import { toneStyle } from "../lib/colors";
import { todayIso } from "../lib/format";
import { useInvalidateAll, useSuggestions } from "../lib/queries";
import { ClaudeMark, PriorityBars } from "./ui/Bits";
import { useToast } from "./ui/Toast";
import { BulkBar, Review } from "../screens/Inbox";

const trunc = (s: string) => (s.length > 38 ? `${s.slice(0, 38)}…` : s);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What to show under the title: the user's own words if the suggestion carries them, else why / description. */
function whyLine(s: Suggestion, p: SuggestedTask): { quote?: string; text?: string } {
  const c = s.context ?? {};
  const quote = str(c.quote) ?? str(c.said);
  if (quote) return { quote };
  const text = str(c.why) ?? str(p.description);
  return text ? { text } : {};
}

/** `startOpen`: open on arrival (links such as /tasks?tray=1 from Overview and Inbox). */
export function SuggestionTray({ projects, startOpen = false }: { projects: Project[]; startOpen?: boolean }) {
  const sugg = useSuggestions("pending");
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState<string | null>(null);
  // Edit opens the full review form in place, so approving keeps Claude's source and context.
  const [editing, setEditing] = useState<string | null>(null);

  const list = (sugg.data ?? []).filter((s) => s.origin === "claude" && s.kind === "task");
  if (list.length === 0) return null;
  const titleOf = (s: Suggestion) => (s.payload as SuggestedTask).title;
  const n = list.length;
  const today = todayIso();

  const run = async (s: Suggestion, fn: () => Promise<void>) => {
    setBusy(s.id);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
      invalidate();
    }
  };

  const approve = (s: Suggestion) =>
    run(s, async () => {
      const r = await api.approveSuggestion(s.id);
      // Undo removes the new task (deleted tasks can be restored); the suggestion itself stays used.
      toast(`Added “${trunc(titleOf(s))}”`, async () => {
        await api.deleteTask(r.id);
        invalidate();
      });
    });

  const dismiss = (s: Suggestion) =>
    run(s, async () => {
      await api.dismissSuggestion(s.id);
      toast("Suggestion dismissed");
    });

  return (
    <div className={`tray ${open ? "open" : ""}`}>
      <button type="button" className="tray-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ClaudeMark size={14} />
        <span>
          <b>Claude suggested {n} {n === 1 ? "task" : "tasks"}</b>
          <span className="tray-x"> — nothing is added until you approve</span>
        </span>
        {!open && <span className="peek">{list.map(titleOf).join(" · ")}</span>}
        <ChevronDown size={14} className="chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="tray-sugg">
          <BulkBar list={list} className="tray-bulk" />
          {list.map((s) => {
            const p = s.payload as SuggestedTask;
            const proj = p.projectId ? projects.find((x) => x.id === p.projectId) : undefined;
            const why = whyLine(s, p);
            const where = str(s.context?.resumeHint);
            if (editing === s.id) {
              return (
                <div key={s.id} className="sg-edit">
                  <Review s={s} projects={projects} onDone={() => { setEditing(null); invalidate(); }} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              );
            }
            return (
              <div key={s.id} className="sg">
                <span className="sg-ring" aria-hidden="true" />
                <div style={{ minWidth: 0 }}>
                  <div className="sg-t">{p.title}</div>
                  {(why.quote || why.text) && (
                    <div className="sg-why">
                      {why.quote ? <>You said <span className="q">“{why.quote}”</span></> : why.text}
                    </div>
                  )}
                  <div className="sg-meta">
                    {proj ? (
                      <span className="chip" style={toneStyle(proj.color)}>{proj.name}</span>
                    ) : p.projectName ? (
                      <span className="pill">{p.projectName}</span>
                    ) : null}
                    {p.dueDate && (
                      <span className="pill"><CalendarDays size={12} strokeWidth={1.6} aria-hidden="true" />
                        {relativeDayLabel(p.dueDate, today)}{p.dueTime ? ` ${p.dueTime}` : ""}
                      </span>
                    )}
                    {!!p.priority && <PriorityBars priority={p.priority} />}
                    {where && <span style={{ color: "var(--faint)", fontSize: 12 }}>{where}</span>}
                  </div>
                </div>
                <div className="sg-acts">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => approve(s)}>
                    <CheckIcon size={14} aria-hidden="true" />Add task
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(s.id)}>Edit</button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss suggestion" title="Dismiss"
                    disabled={busy === s.id} onClick={() => dismiss(s)}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
