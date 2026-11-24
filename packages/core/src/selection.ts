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

const DAY = "(?:today|yesterday|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const CHAT_TIME = String.raw`(?:${DAY},?\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?`;
// A line that is only a time, optionally wrapped in commas: ", 10:12," / "Yesterday 10:12".
const TIME_LINE = new RegExp(String.raw`^[,\s]*${CHAT_TIME}[,\s]*$`, "i");
// "Anna Murphy,10:12, Can you send..." on one line.
const INLINE_HEADER = new RegExp(String.raw`^(\p{L}[\p{L}'’.\- ]{0,40}?)\s*,\s*${CHAT_TIME}\s*,\s*(.+)$`, "iu");
const NAME_LINE = /^\p{L}[\p{L}'’.\- ]{0,40}$/u;

interface ChatMessage {
  name: string;
  text: string;
}

function isNameLine(line: string): boolean {
  return NAME_LINE.test(line) && !/[.!?]$/.test(line) && line.split(" ").length <= 5;
}

/** Parse Google Chat style text into messages, or null when it is not a chat transcript. */
function parseChat(text: string): { before: string[]; messages: ChatMessage[] } | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trim());
  const before: string[] = [];
  const messages: ChatMessage[] = [];
  let name: string | null = null;
  let headers = 0;
  let firstName = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const inline = INLINE_HEADER.exec(line);
    if (inline) {
      headers++;
      name = inline[1].trim();
      if (headers === 1) firstName = name;
      messages.push({ name, text: inline[2].trim() });
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !lines[j]) j++;
    if (isNameLine(line) && j < lines.length && TIME_LINE.test(lines[j])) {
      headers++;
      name = line;
      if (headers === 1) firstName = name;
      i = j;
      continue;
    }
    if (name) messages.push({ name, text: line });
    else before.push(line);
  }
  // One header is enough only when it looks like a person ("Anna Murphy", "You"); a lone "Agenda / 10:30" is not chat.
  const personLike = firstName.split(" ").length >= 2 || firstName.toLowerCase() === "you";
  return headers >= 2 || (headers === 1 && personLike) ? { before, messages } : null;
}

/**
 * Rewrite Google Chat style text ("Anna Murphy" / "10:12" / message) as one line per
 * message ("Anna Murphy: message") with the times dropped. Text that has no
 * name + time header passes through unchanged.
 */
export function cleanChatText(text: string): string {
  const chat = parseChat(text);
  if (!chat) return text;
  return [...chat.before, ...chat.messages.map((m) => `${m.name}: ${m.text}`)].join("\n");
}

/** Keep line breaks; collapse spaces within a line, trim lines, and squash long blank runs. */
function normalizeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function suggestFromSelection(
  selection: string,
  page: { url?: string | null; title?: string | null } = {},
  ref: Date = new Date(),
): SelectionSuggestion {
  const chat = parseChat(selection);
  const original = normalizeLines(chat ? cleanChatText(selection) : selection).slice(0, MAX_SELECTION).trim();
  const confidence: Record<string, number> = {};

  // Use the first sentence (or first message) for the title; keep everything as the selection.
  let firstSentence: string;
  let rest: string;
  if (chat && chat.before.length === 0 && chat.messages.length > 0) {
    const first = chat.messages[0].text.replace(/\s+/g, " ");
    firstSentence = first.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? first;
    const tail = [first.slice(firstSentence.length).trim(), ...chat.messages.slice(1).map((m) => `${m.name}: ${m.text}`)];
    rest = tail.filter(Boolean).join("\n");
  } else {
    const flat = original.replace(/\s+/g, " ");
    firstSentence = flat.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? flat;
    // Same split on the line-preserving text, so the rest keeps its line breaks.
    const raw = original.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? original;
    rest = original.slice(raw.length).trim();
  }
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
    title = clip(title, MAX_TITLE);
    confidence.title = 0.4;
  }
  // The full text is kept once, as the selection. The description holds only what the title leaves out.
  if (rest && !description) description = rest;

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
