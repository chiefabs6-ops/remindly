// Plain-text views of Tether data for Claude.

/** Context Claude saved with a task it suggested (stored apart from the user's notes). */
export type ClaudeContext = Record<string, unknown> | null | undefined;

const LABELS: Record<string, string> = {
  said: "You said",
  completed: "Done",
  remaining: "Left to do",
  why: "Why",
  resumeHint: "Pick up at",
  quote: "Said in the meeting",
  repository: "Repository",
  branch: "Branch",
};
const ORDER = ["said", "meeting", "quote", "completed", "remaining", "why", "resumeHint", "repository", "branch"];

const asText = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** "Handover from Claude" (or "from local AI") block: what the user said, what is done, what is left and where to resume. */
export function contextText(ctx: ClaudeContext, who = "Claude"): string {
  if (!ctx || typeof ctx !== "object") return "";
  const keys = [...ORDER.filter((k) => k in ctx), ...Object.keys(ctx).filter((k) => !ORDER.includes(k))];
  const out: string[] = [];
  for (const k of keys) {
    const v = ctx[k];
    const label = LABELS[k] ?? k;
    if (k === "meeting" && v && typeof v === "object") {
      const m = v as Record<string, unknown>;
      if (asText(m.title)) out.push(`From the meeting: ${asText(m.title)}${asText(m.meetingId) ? ` (meeting ${asText(m.meetingId)})` : ""}`);
      continue;
    }
    if (Array.isArray(v)) {
      const items = v.map(asText).filter(Boolean);
      if (items.length) out.push(`${label}:\n${items.map((i) => `- ${i}`).join("\n")}`);
    } else if (asText(v)) {
      out.push(k === "said" ? `${label}: "${asText(v)}"` : `${label}: ${asText(v)}`);
    }
  }
  return out.length ? `\nHandover from ${who}:\n${out.join("\n")}` : "";
}
