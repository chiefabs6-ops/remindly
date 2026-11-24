// Pure logic for reading Google Meet live captions. No chrome APIs here, so it is unit-testable.
// Google does not document Meet's DOM. Every selector lives in SELECTORS so a live test can fix them in one place.

export interface MeetSegment {
  id: string;
  speaker: string;
  text: string;
  /** RFC3339, first time the block was seen. */
  at: string;
}

export interface CaptionObservation {
  blockId: string;
  speaker: string;
  text: string;
  now: Date;
}

export const MAX_TEXT = 4000;
export const MAX_SPEAKER = 100;

export const SELECTORS = {
  /** Captions region, best guess first. */
  region: ['[role="region"][aria-label*="aption" i]', 'div[jsname="dsyhDe"]', ".a4cQT"],
  /** One caption block (speaker + text). Optional: when absent, blocks are derived from speaker elements. */
  block: [".nMcdL", ".TBMuR"],
  /** Speaker name element inside a block. */
  speaker: [".zs7s8d", ".KcIKyf"],
  /** Caption text element inside a block. */
  text: [".iTTPOb", ".bh44bd", '[jsname="tgaKEf"]'],
  /** Leave-call button: present only while joined. */
  leaveButton: ['button[aria-label*="Leave call" i]', '[jsname="CQylAd"]'],
  /** Button that turns captions on. */
  captionsOn: ['button[aria-label*="Turn on captions" i]'],
} as const;

const joined = (list: readonly string[]) => list.join(", ");

export function meetCodeFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "meet.google.com") return null;
  const m = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(u.pathname);
  return m ? m[1] : null;
}

/** Tab title -> meeting title, or null when there is no real title. */
export function titleFromDocument(docTitle: string, meetCode: string): string | null {
  let t = docTitle.trim();
  t = t.replace(/\s*[-–—|]\s*Google Meet\s*$/i, "");
  t = t.replace(/^Meet\s*[-–—|]\s*/i, "");
  t = t.trim();
  if (!t || t.toLowerCase() === "google meet" || t.toLowerCase() === "meet" || t === meetCode) return null;
  return t.slice(0, 200);
}

export class CaptionTracker {
  private segments = new Map<string, MeetSegment>();
  private byBlock = new Map<string, string>();
  private counter = 0;
  private prefix: string;

  /** The prefix keeps segment ids unique across page reloads in the same call. */
  constructor(idPrefix: string = Date.now().toString(36)) {
    this.prefix = idPrefix;
  }

  /** Returns true when the observation created or changed a segment. */
  observe(o: CaptionObservation): boolean {
    const text = o.text.trim().slice(0, MAX_TEXT);
    if (!text) return false;
    const speaker = (o.speaker.trim() || "Unknown").slice(0, MAX_SPEAKER);
    const existingId = this.byBlock.get(o.blockId);
    if (existingId === undefined) {
      const id = `${this.prefix}-${++this.counter}`;
      this.byBlock.set(o.blockId, id);
      this.segments.set(id, { id, speaker, text, at: o.now.toISOString() });
      return true;
    }
    const seg = this.segments.get(existingId)!;
    if (seg.text === text && seg.speaker === speaker) return false;
    // Latest wins, including a shorter text (Meet corrected itself).
    seg.text = text;
    seg.speaker = speaker;
    return true;
  }

  all(): MeetSegment[] {
    return [...this.segments.values()];
  }

  /** Segments new or changed compared to lastSent (segment id -> text last sent). */
  changedSince(lastSent: ReadonlyMap<string, string>): MeetSegment[] {
    return this.all().filter((s) => lastSent.get(s.id) !== s.text);
  }

  get size(): number {
    return this.segments.size;
  }
}

// ---- DOM reading ----

const blockIds = new WeakMap<Element, string>();
let blockCounter = 0;

export function blockIdFor(el: Element): string {
  let id = blockIds.get(el);
  if (!id) {
    id = `b${++blockCounter}`;
    blockIds.set(el, id);
  }
  return id;
}

export function findCaptionsRegion(root: ParentNode): Element | null {
  for (const sel of SELECTORS.region) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function findLeaveButton(root: ParentNode): Element | null {
  return root.querySelector(joined(SELECTORS.leaveButton));
}

export function findCaptionsOnButton(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(joined(SELECTORS.captionsOn));
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Smallest ancestor of `from` (inside `region`) that also contains a text element. */
function blockAround(from: Element, region: Element): Element | null {
  const textSel = joined(SELECTORS.text);
  let cur: Element | null = from.parentElement;
  while (cur && cur !== region) {
    if (cur.querySelector(textSel)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export interface RawBlock {
  blockId: string;
  speaker: string;
  text: string;
}

/** Read caption blocks under a captions region. */
export function readBlocksFromRegion(region: Element): RawBlock[] {
  const out: RawBlock[] = [];
  const speakerSel = joined(SELECTORS.speaker);
  const textSel = joined(SELECTORS.text);

  // Layer 1: known block elements.
  const explicit = [...region.querySelectorAll(joined(SELECTORS.block))];
  const blocks = new Set<Element>();
  for (const b of explicit) if (b.querySelector(textSel)) blocks.add(b);

  // Layer 2: derive blocks from speaker elements.
  if (blocks.size === 0) {
    for (const sp of region.querySelectorAll(speakerSel)) {
      const b = blockAround(sp, region);
      if (b) blocks.add(b);
    }
  }

  for (const b of blocks) {
    const speakerEl = b.querySelector(speakerSel);
    const textEls = [...b.querySelectorAll(textSel)];
    const text = clean(textEls.map((t) => t.textContent).join(" "));
    if (!text) continue;
    out.push({ blockId: blockIdFor(b), speaker: clean(speakerEl?.textContent), text });
  }
  if (out.length > 0) return out;

  // Layer 3: structural guess. Each child of the region is a block; the first short text leaf is the speaker
  // (often next to an avatar img), the rest is the text.
  for (const child of region.children) {
    const leaves = [...child.querySelectorAll("*")].filter(
      (e) => e.children.length === 0 && e.tagName !== "IMG" && clean(e.textContent),
    );
    if (leaves.length < 2) continue;
    const name = clean(leaves[0].textContent);
    if (name.length > MAX_SPEAKER) continue;
    const text = clean(leaves.slice(1).map((l) => l.textContent).join(" "));
    if (!text) continue;
    out.push({ blockId: blockIdFor(child), speaker: name, text });
  }
  return out;
}

/** Find the captions region under root and read all blocks. Empty when captions are not shown. */
export function readCaptionBlocks(root: ParentNode): RawBlock[] {
  const region = findCaptionsRegion(root);
  return region ? readBlocksFromRegion(region) : [];
}
