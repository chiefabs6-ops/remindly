import { Link } from "react-router";
import { Globe } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { hostOf } from "../../lib/format";
import { ClaudeMark } from "../ui/Bits";
import { LinkedText } from "./LinkedText";
import { contextParts, openExternal, parseContext, same, type CtxPart } from "./model";

const RESUME = /resume|pick|continue|where/i;
const META = /^(repository|branch)$/i;

/** "**bold**" inside a line (older Markdown context only). */
function bold(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((x, i) => (x.startsWith("**") && x.endsWith("**") ? <strong key={i}>{x.slice(2, -2)}</strong> : x));
}

function Part({ p }: { p: CtxPart }) {
  const resume = RESUME.test(p.label);
  return (
    <>
      {p.label && <div className="lbl">{resume ? "Pick up at" : p.label}</div>}
      {p.text && <p>{p.link ? <Link className="underline" to={p.link}>{p.text}</Link> : resume ? <code>{p.text}</code> : bold(p.text)}</p>}
      {p.items && p.items.length > 0 && <ul>{p.items.map((x, i) => <li key={i}>{bold(x)}</li>)}</ul>}
    </>
  );
}

/**
 * What Claude handed over with the task. Newer tasks keep it in `claudeContext` (with the user's own
 * words in `said`); older ones have it as Markdown in the notes. The quick panel shows the short form:
 * what you said and where to pick up. The page shows all of it.
 */
export function ClaudeContext({ t, full }: { t: TaskDetail; full?: boolean }) {
  if (t.source !== "claude" && t.source !== "ai") return null;
  const who = t.source === "ai" ? "local AI" : "Claude";
  const structured = contextParts(t.claudeContext);
  const said = structured.said;
  const all = t.claudeContext ? structured.parts : parseContext(t.notes);
  if (!said && all.length === 0) return null;
  const resume = all.find((p) => RESUME.test(p.label));
  const first = said ? undefined : all.find((p) => p.text && !RESUME.test(p.label) && !META.test(p.label));
  const shown = full ? all : [first, resume].filter((p): p is CtxPart => !!p);
  return (
    <section className="sec" aria-label={`Context from ${who}`}>
      <div className="sec-h"><ClaudeMark size={13} />Context from {who}</div>
      <div className="ctx">
        {said && (<><div className="lbl">You said</div><p>“{said}”</p></>)}
        {shown.map((p, i) => <Part key={i} p={p} />)}
      </div>
    </section>
  );
}

/** Text captured from a web page, with a link back to it. Page only. */
export function CapturedText({ t }: { t: TaskDetail }) {
  if (!t.sourceSelection) return null;
  // A meeting task already shows this line under "Said in the meeting".
  const quote = t.claudeContext && typeof t.claudeContext.quote === "string" ? t.claudeContext.quote : null;
  if (quote && same(quote, t.sourceSelection)) return null;
  return (
    <section className="sec" aria-label="Captured text">
      <div className="sec-h"><Globe size={14} strokeWidth={1.6} />Captured text</div>
      <div className="cap">
        <blockquote>“<LinkedText text={t.sourceSelection} />”</blockquote>
        {t.sourceUrl && (
          <a href={t.sourceUrl} onClick={(e) => { e.preventDefault(); void openExternal(t.sourceUrl!); }} onAuxClick={(e) => e.preventDefault()}>
            {t.sourceTitle || hostOf(t.sourceUrl)} <span className="faint">· {hostOf(t.sourceUrl)}</span> ↗
          </a>
        )}
      </div>
    </section>
  );
}
