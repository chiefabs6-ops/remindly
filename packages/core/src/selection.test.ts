import { describe, expect, it } from "vitest";
import { captureKey, cleanChatText, suggestFromSelection } from "./selection";

const REF = new Date(2026, 10, 23, 10, 30); // Monday

describe("suggestFromSelection", () => {
  it("handles the Niamh example from the brief", () => {
    const s = suggestFromSelection(
      "Follow up with Niamh about the updated SEPI teacher list before Friday.",
      { url: "https://mail.google.com/mail/u/0/#inbox/1", title: "Inbox" },
      REF,
    );
    expect(s.payload.title).toBe("Follow up with Niamh");
    expect(s.payload.description).toBe("The updated SEPI teacher list");
    expect(s.payload.dueDate).toBe("2026-11-27");
    expect(s.confidence.dueDate).toBeLessThan(0.8);
    expect(s.payload.sourceUrl).toBe("https://mail.google.com/mail/u/0/#inbox/1");
    expect(s.payload.sourceSelection).toContain("SEPI");
  });

  it("drops polite lead-ins and trailing punctuation", () => {
    const s = suggestFromSelection("Please can you send the invoice tomorrow!", {}, REF);
    expect(s.payload.title).toBe("Send the invoice");
    expect(s.payload.dueDate).toBe("2026-11-24");
  });

  it("keeps text without a date or splitter as the title", () => {
    const s = suggestFromSelection("Update the onboarding checklist", {}, REF);
    expect(s.payload).toMatchObject({ title: "Update the onboarding checklist", description: null, dueDate: null });
    expect(s.confidence).toEqual({});
  });

  it("clips long text and keeps the full text once, as the selection", () => {
    const long = "Review the proposal for the new learning management integration and check every section against the procurement rules";
    const s = suggestFromSelection(long, {}, REF);
    expect(s.payload.title.length).toBeLessThanOrEqual(81);
    expect(s.payload.title.endsWith("…")).toBe(true);
    expect(s.payload.description).toBeNull();
    expect(s.payload.sourceSelection).toContain("procurement rules");
  });

  it("uses the first sentence for the title and keeps the rest", () => {
    const s = suggestFromSelection("Book the room for Thursday. We need space for twelve people.", {}, REF);
    expect(s.payload.title).toBe("Book the room");
    expect(s.payload.description).toBe("We need space for twelve people.");
    expect(s.payload.dueDate).toBe("2026-11-26");
  });

  it("refuses non-web source links", () => {
    const s = suggestFromSelection("x y", { url: "chrome://extensions" }, REF);
    expect(s.payload.sourceUrl).toBeNull();
  });
});

describe("captureKey", () => {
  it("is stable and whitespace-insensitive", async () => {
    const a = await captureKey("https://a.test", "Call  Niamh\n");
    const b = await captureKey("https://a.test", "Call Niamh");
    const c = await captureKey("https://b.test", "Call Niamh");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^chrome:[0-9a-f]{32}$/);
  });
});

describe("cleanChatText and chat captures", () => {
  const chat = "Anna Murphy\n10:12\nCan you send the NVB1 forms?\nYou\n10:14\nSure";

  it("rewrites a multi-line chat as one line per message", () => {
    expect(cleanChatText(chat)).toBe("Anna Murphy: Can you send the NVB1 forms?\nYou: Sure");
    const s = suggestFromSelection(chat, {}, REF);
    expect(s.payload.sourceSelection).toBe("Anna Murphy: Can you send the NVB1 forms?\nYou: Sure");
    expect(s.payload.title).toBe("Send the NVB1 forms");
    expect(s.payload.description).toBe("You: Sure");
    expect(s.payload.dueDate).toBeNull();
    expect(s.payload.dueTime).toBeNull();
  });

  it("handles comma-wrapped, day-prefixed and AM/PM times, and continued messages", () => {
    const t = "Anna Murphy\n, 10:12,\nFirst line\nSecond line\nYou\nYesterday 10:14\nOk\nBen\nMon 9:05 AM\nHi";
    expect(cleanChatText(t)).toBe("Anna Murphy: First line\nAnna Murphy: Second line\nYou: Ok\nBen: Hi");
  });

  it("strips inline times between name and text", () => {
    expect(cleanChatText("Anna Murphy,10:12,Can you send the forms?")).toBe("Anna Murphy: Can you send the forms?");
    expect(cleanChatText("Anna Murphy , 10:12 , Can you send the forms?")).toBe("Anna Murphy: Can you send the forms?");
    const s = suggestFromSelection("Anna Murphy,10:12,Can you send the forms?", {}, REF);
    expect(s.payload.sourceSelection).not.toContain("10:12");
    expect(s.payload.dueTime).toBeNull();
  });

  it("leaves non-chat text unchanged", () => {
    const t = "Please meet at 10:12 tomorrow\nbring the forms";
    expect(cleanChatText(t)).toBe(t);
    const s = suggestFromSelection("Line one\n\n\n\nLine   two", {}, REF);
    expect(s.payload.sourceSelection).toBe("Line one\n\nLine two");
  });

  it("still finds a real date in the message", () => {
    const s = suggestFromSelection("Anna Murphy\n10:12\nSend the forms before Friday", {}, REF);
    expect(s.payload.dueDate).toBe("2026-11-27");
    expect(s.payload.dueTime).toBeNull();
    expect(s.payload.title).toBe("Send the forms");
  });
});

describe("chat detection", () => {
  it("does not treat an agenda with one time line as chat", () => {
    const text = "Agenda\n10:30\nIntro";
    expect(cleanChatText(text)).toBe(text);
  });
  it("a single header counts when the name has two words or is You", () => {
    expect(cleanChatText("Anna Murphy\n10:12\nCan you send it?")).toBe("Anna Murphy: Can you send it?");
    expect(cleanChatText("You\n10:12\nOn it")).toBe("You: On it");
  });
});
