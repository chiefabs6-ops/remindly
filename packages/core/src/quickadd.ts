import { findDate } from "./dates";
import type { Priority, Project, TaskInput } from "./types";

/**
 * Quick-add syntax (Todoist-style):
 *   "Call Niamh friday 3pm #educator @admin !high"
 *   - a date/time phrase anywhere → due date/time ("before Friday" works too)
 *   - #word  → project whose name matches (prefix of the name or of a word in it)
 *   - @word  → tag
 *   - !high / !med / !low or !3 / !2 / !1 → priority
 * Anything unmatched stays in the title.
 */
export interface QuickAddResult {
  input: TaskInput;
  /** Pieces recognised, for showing chips under the input. */
  parts: { kind: "date" | "project" | "tag" | "priority"; text: string; value: string }[];
  /** `#word` that matched no project (or more than one). */
  unknownProjects: string[];
}

const PRIORITY_WORDS: Record<string, Priority> = {
  high: 3,
  h: 3,
  "3": 3,
  medium: 2,
  med: 2,
  m: 2,
  "2": 2,
  low: 1,
  l: 1,
  "1": 1,
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Projects whose name, or any word in it, starts with `word`. */
export function matchProjects(word: string, projects: Project[]): Project[] {
  const w = norm(word).replace(/\s+/g, "");
  if (!w) return [];
  const exact = projects.filter((p) => norm(p.name).replace(/\s+/g, "") === w);
  if (exact.length) return exact;
  return projects.filter((p) => {
    const n = norm(p.name);
    return n.replace(/\s+/g, "").startsWith(w) || n.split(" ").some((part) => part.startsWith(w));
  });
}

export function parseQuickAdd(
  text: string,
  projects: Project[],
  ref: Date = new Date(),
): QuickAddResult {
  const parts: QuickAddResult["parts"] = [];
  const unknownProjects: string[] = [];
  const tags: string[] = [];
  let projectId: string | null = null;
  let priority: Priority = 0;

  // Tokens first, so "#fri" is not read as a date.
  let rest = text.replace(/(^|\s)([#@!])([\p{L}\p{N}_\-–.]+)/gu, (whole, pre: string, sigil: string, word: string) => {
    if (sigil === "@") {
      tags.push(word);
      parts.push({ kind: "tag", text: `@${word}`, value: word });
      return pre;
    }
    if (sigil === "!") {
      const p = PRIORITY_WORDS[word.toLowerCase()];
      if (p === undefined) return whole;
      priority = p;
      parts.push({ kind: "priority", text: `!${word}`, value: String(p) });
      return pre;
    }
    const matches = matchProjects(word, projects);
    if (matches.length === 1) {
      projectId = matches[0].id;
      parts.push({ kind: "project", text: `#${word}`, value: matches[0].name });
      return pre;
    }
    unknownProjects.push(word);
    return whole;
  });

  let dueDate: string | null = null;
  let dueTime: string | null = null;
  const found = findDate(rest, ref);
  if (found) {
    dueDate = found.date;
    dueTime = found.time;
    parts.push({ kind: "date", text: found.text, value: found.time ? `${found.date} ${found.time}` : found.date });
    rest = rest.slice(0, found.index) + rest.slice(found.index + found.text.length);
  }

  const title = rest.replace(/\s+/g, " ").trim();
  return {
    input: { title, dueDate, dueTime, projectId, tags, priority },
    parts,
    unknownProjects,
  };
}
