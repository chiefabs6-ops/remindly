// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CaptionTracker,
  findCaptionsRegion,
  findLeaveButton,
  meetCodeFromUrl,
  readCaptionBlocks,
  titleFromDocument,
} from "./meet-parse";

const t0 = new Date("2026-01-01T10:00:00Z");
const obs = (blockId: string, speaker: string, text: string, now = t0) => ({ blockId, speaker, text, now });

describe("meetCodeFromUrl", () => {
  it("parses meet urls", () => {
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij?authuser=1")).toBe("abc-defg-hij");
  });
  it("rejects others", () => {
    expect(meetCodeFromUrl("http://meet.google.com/abc-defg-hij")).toBeNull();
    expect(meetCodeFromUrl("https://meet.google.com/landing")).toBeNull();
    expect(meetCodeFromUrl("https://evil.com/abc-defg-hij")).toBeNull();
    expect(meetCodeFromUrl("https://meet.google.com.evil.com/abc-defg-hij")).toBeNull();
    expect(meetCodeFromUrl("not a url")).toBeNull();
  });
});

describe("titleFromDocument", () => {
  it("strips suffix and generic titles", () => {
    expect(titleFromDocument("Weekly sync - Google Meet", "abc-defg-hij")).toBe("Weekly sync");
    expect(titleFromDocument("Meet - abc-defg-hij", "abc-defg-hij")).toBeNull();
    expect(titleFromDocument("Google Meet", "abc-defg-hij")).toBeNull();
    expect(titleFromDocument("", "abc-defg-hij")).toBeNull();
  });
});

describe("CaptionTracker", () => {
  it("keeps one segment per block with latest text", () => {
    const tr = new CaptionTracker("p");
    tr.observe(obs("b1", "You", "hello"));
    tr.observe(obs("b1", "You", "hello there", new Date(t0.getTime() + 5000)));
    const all = tr.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ speaker: "You", text: "hello there", at: t0.toISOString() });
  });
  it("keeps newer shorter text", () => {
    const tr = new CaptionTracker("p");
    tr.observe(obs("b1", "Sam", "I think we should ship"));
    tr.observe(obs("b1", "Sam", "I think"));
    expect(tr.all()[0].text).toBe("I think");
  });
  it("ignores empty text, trims, caps", () => {
    const tr = new CaptionTracker("p");
    expect(tr.observe(obs("b1", "A", "   "))).toBe(false);
    tr.observe(obs("b2", "  " + "n".repeat(300) + " ", "  " + "x".repeat(5000) + "  "));
    const s = tr.all()[0];
    expect(s.text).toHaveLength(4000);
    expect(s.speaker).toHaveLength(100);
    tr.observe(obs("b3", " ", "hi"));
    expect(tr.all()[1].speaker).toBe("Unknown");
  });
  it("reports whether an observation changed anything", () => {
    const tr = new CaptionTracker("p");
    expect(tr.observe(obs("b1", "A", "x"))).toBe(true);
    expect(tr.observe(obs("b1", "A", "x"))).toBe(false);
  });
  it("changedSince returns new and changed only", () => {
    const tr = new CaptionTracker("p");
    tr.observe(obs("b1", "A", "one"));
    tr.observe(obs("b2", "B", "two"));
    const sent = new Map<string, string>();
    expect(tr.changedSince(sent)).toHaveLength(2);
    for (const s of tr.all()) sent.set(s.id, s.text);
    expect(tr.changedSince(sent)).toHaveLength(0);
    tr.observe(obs("b2", "B", "two more"));
    const changed = tr.changedSince(sent);
    expect(changed.map((s) => s.text)).toEqual(["two more"]);
  });
  it("ids are unique per prefix", () => {
    const a = new CaptionTracker("a");
    const b = new CaptionTracker("b");
    a.observe(obs("b1", "A", "x"));
    b.observe(obs("b1", "A", "x"));
    expect(a.all()[0].id).not.toBe(b.all()[0].id);
  });
});

const FIXTURE = `
<div>
  <button aria-label="Leave call"></button>
  <div role="region" aria-label="Captions">
    <div class="nMcdL">
      <div><img src="x.png"><div class="zs7s8d">You</div></div>
      <div class="iTTPOb">I'll send the report</div>
      <div class="iTTPOb">on Friday</div>
    </div>
    <div class="nMcdL">
      <div><img src="y.png"><div class="zs7s8d">Sarah Lee</div></div>
      <div class="iTTPOb">Sounds good</div>
    </div>
  </div>
</div>`;

describe("DOM reading", () => {
  it("reads blocks from the fixture", () => {
    document.body.innerHTML = FIXTURE;
    expect(findLeaveButton(document)).not.toBeNull();
    expect(findCaptionsRegion(document)).not.toBeNull();
    const blocks = readCaptionBlocks(document);
    expect(blocks.map((b) => [b.speaker, b.text])).toEqual([
      ["You", "I'll send the report on Friday"],
      ["Sarah Lee", "Sounds good"],
    ]);
  });
  it("keeps block ids stable across reads", () => {
    document.body.innerHTML = FIXTURE;
    const a = readCaptionBlocks(document).map((b) => b.blockId);
    const b = readCaptionBlocks(document).map((b) => b.blockId);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });
  it("derives blocks from speaker elements without block class", () => {
    document.body.innerHTML = `<div jsname="dsyhDe"><div><span class="KcIKyf">Bo</span><span jsname="tgaKEf">hi all</span></div></div>`;
    expect(readCaptionBlocks(document).map((b) => [b.speaker, b.text])).toEqual([["Bo", "hi all"]]);
  });
  it("falls back to structure when classes are unknown", () => {
    document.body.innerHTML = `<div role="region" aria-label="Live captions"><div><img src="a.png"><span>Ana</span><span>good morning</span></div></div>`;
    expect(readCaptionBlocks(document).map((b) => [b.speaker, b.text])).toEqual([["Ana", "good morning"]]);
  });
  it("returns nothing when captions are off", () => {
    document.body.innerHTML = `<div><button aria-label="Leave call"></button></div>`;
    expect(readCaptionBlocks(document)).toEqual([]);
  });
});
