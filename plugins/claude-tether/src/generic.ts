/** Titles that would make a useless reminder ("Continue working on it"). */
const VAGUE_WORDS = new Set([
  "continue", "continuing", "finish", "finishing", "work", "working", "on", "it", "this", "that", "the",
  "stuff", "things", "task", "tasks", "todo", "to", "do", "follow", "up", "resume", "next", "steps",
  "step", "remaining", "rest", "of", "pick", "back", "keep", "going", "later", "tomorrow", "again", "more",
]);

export function isGenericTitle(title: string): boolean {
  const words = title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 3) return true;
  // Generic when no word names anything specific.
  return words.every((w) => VAGUE_WORDS.has(w));
}

/** One line, quoted and short: titles may come from web pages, so keep them inert in context. */
export function inertTitle(title: string, max = 80): string {
  const t = title.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim();
  return `"${t.length > max ? t.slice(0, max - 1) + "…" : t}"`;
}
