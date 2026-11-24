import { Globe } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { hostOf } from "../../lib/format";
import { ClaudeMark } from "../ui/Bits";
import { openExternal, parseContext, type CtxPart } from "./model";

const RESUME = /resume|pick|continue|where/i;

/** "**bold**" inside a line. */
function bold(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((x, i) => (x.startsWith("**") && x.endsWith("**") ? <strong key={i}>{x.slice(2, -2)}</strong> : x));
}

function Part({ p }: { p: CtxPart }) {
  const resume = RESUME.test(p.label);
  return (
    <>
      {p.label && <div className="lbl">{resume ? "Pick up at" : p.label}</div>}
      {p.text && <p>{resume ? <code>{p.text}</code> : bold(p.text)}</p>}
      {p.items && p.items.length > 0 && <ul>{p.items.map((x, i) => <li key={i}>{bold(x)}</li>)}</ul>}
    </>
  );
}

/**
 * What Claude handed over with the task (it is saved as Markdown in the task notes).
 * The quick panel shows the short form: the first line of context and where to pick up. The page shows all of it.
 */
export function ClaudeContext({ t, full }: { t: TaskDetail; full?: boolean }) {
  if (t.source !== "claude" || !t.notes) return null;
  const all = parseContext(t.notes);
  if (all.length === 0) return null;
  const first = all.find((p) => p.text && !RESUME.test(p.label));
  const resume = all.find((p) => RESUME.test(p.label));
  const shown = full ? all : [first, resume].filter((p): p is CtxPart => !!p);
  if (shown.length === 0) return null;
  return (
    <section className="sec" aria-label="Context from Claude">
      <div className="sec-h"><ClaudeMark size={13} />Context from Claude</div>
      <div className="ctx">{shown.map((p, i) => <Part key={i} p={p} />)}</div>
    </section>
  );
}

/** Text captured from a web page, with a link back to it. Page only. */
export function CapturedText({ t }: { t: TaskDetail }) {
  if (!t.sourceSelection) return null;
  return (
    <section className="sec" aria-label="Captured text">
      <div className="sec-h"><Globe size={14} strokeWidth={1.6} />Captured text</div>
      <div className="cap">
        <blockquote>“{t.sourceSelection}”</blockquote>
        {t.sourceUrl && (
          <a href={t.sourceUrl} onClick={(e) => { e.preventDefault(); void openExternal(t.sourceUrl!); }}>
            {t.sourceTitle || hostOf(t.sourceUrl)} <span className="faint">· {hostOf(t.sourceUrl)}</span> ↗
          </a>
        )}
      </div>
    </section>
  );
}
