// Small shared marks from mockup E: priority bars, subtask ring, Claude spark, completion check.
import { PRIORITY_LABEL, type Priority } from "@tether/core";

export function PriorityBars({ priority, className = "" }: { priority: Priority; className?: string }) {
  return (
    <span className={`pri pri-${priority} ${className}`} role="img" aria-label={`${PRIORITY_LABEL[priority]} priority`} title={`${PRIORITY_LABEL[priority]} priority`}>
      <i /><i /><i />
    </span>
  );
}

/** "2/5" with a small ring that fills as subtasks are done. */
export function SubtaskRing({ done, total }: { done: number; total: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${done} of ${total} subtasks done`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        <circle cx="6" cy="6" r={r} fill="none" stroke="var(--control)" strokeWidth="1.6" />
        <circle cx="6" cy="6" r={r} fill="none" stroke="var(--muted)" strokeWidth="1.6"
          strokeDasharray={`${total ? (c * done) / total : 0} ${c}`} transform="rotate(-90 6 6)" />
      </svg>
      <span className="num">{done}/{total}</span>
      <span className="sr-only"> subtasks done</span>
    </span>
  );
}

/** Claude's mark: a small four-point spark in a warm clay. */
export function ClaudeMark({ size = 12, label }: { size?: number; label?: string }) {
  return (
    <span className="claude-mark" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5z" />
        <path d="M19 15.5c.25 1.9 1.1 2.75 3 3-1.9.25-2.75 1.1-3 3-.25-1.9-1.1-2.75-3-3 1.9-.25 2.75-1.1 3-3z" />
      </svg>
    </span>
  );
}

/** Round completion check; amber ring for High priority. */
export function Check({ done, high, label, onToggle, disabled, size }: {
  done: boolean; high?: boolean; label: string; onToggle: () => void; disabled?: boolean; size?: number;
}) {
  return (
    <button type="button" className={`ck ${done ? "ck-on" : high ? "ck-high" : ""}`} aria-label={label} aria-pressed={done}
      disabled={disabled} onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={size ? { width: size, height: size } : undefined}>
      <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
    </button>
  );
}
