import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock, sampleStore } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";
import { actionItems } from "../screens/Notes";

beforeEach(() => {
  // Fixed evening clock: the sample "09:00 today" task is already overdue, whatever time the suite runs.
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
  queryClient.clear();
  window.location.hash = "#/notes";
  // jsdom has no matchMedia.
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
});

type N = { id: string; title: string; bodyMd: string; kind: string; taskId: string | null; tags: string[] };
const noteByTitle = async (q: string) => (await mockInvoke<N[]>("notes_list", { filter: { query: q } }))[0];

describe("Notes", () => {
  it("lists notes and filters by kind", async () => {
    const user = userEvent.setup();
    render(<App />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(await within(list).findByText("Weekly sync")).toBeInTheDocument();
    expect(within(list).getByText("Ideas for the onboarding email")).toBeInTheDocument();
    expect(screen.getByText("Pick a note, or start a new one.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Idea" }));
    expect(within(list).queryByText("Weekly sync")).not.toBeInTheDocument();
    expect(within(list).getByText("Ideas for the onboarding email")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Research" }));
    expect(within(list).getByText("No notes match.")).toBeInTheDocument();
  });

  it("opens a note and saves an edited title on blur", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Ideas for the onboarding email/ }));
    const title = await screen.findByLabelText("Note title");
    await user.clear(title);
    await user.type(title, "Onboarding email ideas");
    await user.tab();
    await waitFor(async () => expect((await noteByTitle("Onboarding email ideas"))?.title).toBe("Onboarding email ideas"));
  });

  it("a meeting note shows summary status and action items; Make task creates a task", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Weekly sync/ }));
    const bar = await screen.findByLabelText("Meeting summary");
    expect(within(bar).getByText(/Summarised/)).toBeInTheDocument();
    expect(screen.getByText(/Google Meet captions · 40 min/)).toBeInTheDocument();
    const items = screen.getByLabelText("Action items");
    expect(within(items).getByText("Send the report on Friday")).toBeInTheDocument();
    expect(within(items).getByText("Not yours")).toBeInTheDocument();
    await user.click(within(items).getByRole("button", { name: /Make task/ }));
    expect(await within(items).findByRole("link", { name: /Task/ })).toBeInTheDocument();
    const tasks = await mockInvoke<{ title: string }[]>("tasks_list", { filter: { query: "Send the report on Friday" } });
    expect(tasks.length).toBe(1);
  });

  it("Turn lines into tasks creates one task per line", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Monday team meeting/ }));
    await user.click(await screen.findByRole("button", { name: /Turn lines into tasks/ }));
    await waitFor(async () => {
      expect((await mockInvoke<unknown[]>("tasks_list", { filter: { query: "Confirm room bookings" } })).length).toBe(1);
      expect((await mockInvoke<unknown[]>("tasks_list", { filter: { query: "Share the timetable draft" } })).length).toBe(1);
    });
  });

  it("shows the linked task card when the note has a task", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string; title: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    const n = await noteByTitle("Ideas for the onboarding email");
    await mockInvoke("note_update", { id: n.id, input: { title: n.title, bodyMd: n.bodyMd, kind: n.kind, tags: n.tags, taskId: t.id } });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Ideas for the onboarding email/ }));
    const card = await screen.findByRole("link", { name: `Linked task: ${t.title}` });
    expect(card).toHaveAttribute("href", `#/task/${t.id}`);
  });

  it("New note opens an empty editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /New note/ }));
    expect(await screen.findByLabelText("Note title")).toHaveValue("New note");
  });
});

describe("actionItems", () => {
  it("reads only the Action items section, and the due date meeting summaries add", () => {
    const body = "## Decisions\n- Ship it\n\n## Action items\n- [ ] Send the report (due 2026-11-27)\n- (Sarah) Check translations\n- [x] Done thing\n\n## Transcript\n- not me";
    expect(actionItems(body)).toEqual([
      { text: "Send the report", who: null, done: false, dueDate: "2026-11-27" },
      { text: "Check translations", who: "Sarah", done: false, dueDate: null },
      { text: "Done thing", who: null, done: true, dueDate: null },
    ]);
  });

  it("an item already in the Inbox links there; Make task makes one task that is remembered", async () => {
    const base = sampleStore();
    const waiting = { ...base.suggestions[0], id: "sug-venue", origin: "note" as const, status: "pending" as const,
      payload: { ...(base.suggestions[0].payload as object), title: "Book the venue" } };
    resetMock({ suggestions: [...base.suggestions, waiting] });
    const user = userEvent.setup();
    const note = await mockInvoke<{ id: string }>("note_create", {
      input: { title: "Planning call", bodyMd: "## Action items\n- [ ] Book the venue\n- [ ] Order badges (due 2026-12-01)", kind: "meeting" },
    });
    window.location.hash = `#/notes?note=${note.id}`;
    const { unmount } = render(<App />);
    const items = await screen.findByLabelText("Action items");
    expect(await within(items).findByRole("link", { name: "In Inbox" })).toHaveAttribute("href", "#/inbox?s=sug-venue");
    expect(within(items).queryByRole("button", { name: "Make task: Book the venue" })).not.toBeInTheDocument();

    await user.click(await within(items).findByRole("button", { name: "Make task: Order badges" }));
    await waitFor(async () => {
      const made = await mockInvoke<{ title: string; dueDate: string | null }[]>("tasks_list", { filter: { query: "Order badges" } });
      expect(made).toHaveLength(1);
      expect(made[0].dueDate).toBe("2026-12-01");
    });
    // Leaving the note and coming back shows the task, not another "Make task".
    unmount();
    queryClient.clear();
    render(<App />);
    const again = await screen.findByLabelText("Action items");
    expect(await within(again).findByRole("link", { name: /Task/ })).toBeInTheDocument();
    expect(within(again).queryByRole("button", { name: "Make task: Order badges" })).not.toBeInTheDocument();
  });

  it("the note body saves by itself, and when you leave the note", async () => {
    const user = userEvent.setup();
    const note = await mockInvoke<{ id: string }>("note_create", { input: { title: "Scratch", bodyMd: "first", kind: "general" } });
    window.location.hash = `#/notes?note=${note.id}`;
    const { unmount } = render(<App />);
    const body = await screen.findByLabelText("Note");
    await user.type(body, " second");
    // No blur: closing the note still keeps the text.
    unmount();
    await waitFor(async () => expect((await mockInvoke<{ bodyMd: string }>("note_get", { id: note.id })).bodyMd).toBe("first second"));
  });
});
