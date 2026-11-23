import { findDate } from "./dates";
import type { SuggestedTask } from "./types";

/**
 * Turn text selected on a web page into a task suggestion, without AI.
 *
 *   "Follow up with Niamh about the updated SEPI teacher list before Friday."
 *   → title "Follow up with Niamh", description "The updated SEPI teacher list",
 *     dueDate = coming Friday (confidence 0.6), the full text kept as sourceSelection.
 *
 * Everything here is a suggestion the user reviews in the Inbox.
 */
export interface SelectionSuggestion {
  payload: SuggestedTask;
  /** 0..1 per guessed field. */
  confidence: Record<string, number>;
}

export const MAX_TITLE = 80;
const MAX_SELECTION = 4000;

// Words that link "who/what to do" to "what it is about".
const SPLITTERS = /\s+(?:about|regarding|re:|re|on the subject of|concerning)\s+/i;
// Lead-ins worth dropping from the start of a title.
const POLITE = /^(?:(?:please|pls|kindly|can you|could you|would you|remember to|don't forget to|dont forget to|need to|we need to|i need to|todo:|to do:|action:)\s+)+/i;

function sentenceCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : s.slice(0, max)).replace(/[,;:\-–—\s]+$/, "") + "…";
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-–—•*·>:;,]+/, "")
    .replace(/[\s.,;:!?]+$/, "");
}

export function suggestFromSelection(
  selection: string,
  page: { url?: string | null; title?: string | null } = {},
  ref: Date = new Date(),
): SelectionSuggestion {
  const original = selection.replace(/\s+/g, " ").trim().slice(0, MAX_SELECTION);
  const confidence: Record<string, number> = {};

  // Use the first sentence (or line) for the title; keep everything as the selection.
  const firstSentence = original.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? original;
  let text = firstSentence;

  let dueDate: string | null = null;
  let dueTime: string | null = null;
  const found = findDate(text, ref);
  if (found) {
    dueDate = found.date;
    dueTime = found.time;
    // A named weekday or "tomorrow" is a fair guess; "by"/"before" makes it a deadline but still a guess.
    confidence.dueDate = 0.6;
    text = text.slice(0, found.index) + text.slice(found.index + found.text.length);
  }

  text = tidy(text).replace(POLITE, "");
  let title = text;
  let description: string | null = null;
  const parts = text.split(SPLITTERS);
  if (parts.length >= 2 && parts[0].split(" ").length >= 2) {
    title = parts[0];
    description = sentenceCase(tidy(text.slice(parts[0].length).replace(SPLITTERS, "")));
  }
  title = sentenceCase(tidy(title)) || "Follow up";
  if (title.length > MAX_TITLE) {
    description = description ?? sentenceCase(text);
    title = clip(title, MAX_TITLE);
    confidence.title = 0.4;
  }
  // Longer selections keep the rest as description so nothing is lost.
  if (original.length > firstSentence.length + 1 && !description) {
    description = original;
  }

  return {
    payload: {
      title,
      description,
      dueDate,
      dueTime,
      sourceUrl: page.url && /^https?:\/\//.test(page.url) ? page.url : null,
      sourceTitle: page.title?.trim().slice(0, 300) || null,
      sourceSelection: original,
    },
    confidence,
  };
}

/** Stable key so re-sending the same capture (retries, double clicks) never makes two suggestions. */
export async function captureKey(url: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${url}\n${text.replace(/\s+/g, " ").trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return (
    "chrome:" +
    Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
