import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import App from "../App";
import { QuickPanel } from "../components/QuickPanel";
import { mockInvoke, resetMock, sampleStore } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";

beforeEach(() => {
  // Fixed evening clock: the sample "09:00 today" task is already overdue, whatever time the suite runs.
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
  queryClient.clear();
  window.location.hash = "#/";
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

async function taskId(query: string) {
  const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query } });
  return t.id;
}

describe("Full task page", () => {
  it("links in the description are clickable, and clicking the text still edits it", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    await mockInvoke("task_update", { id, input: { title: "Approve October expense claims", description: "Check https://app.clickup.com/t/26441883/869fp12dv please" } });
    window.location.hash = `#/task/${id}`;
    render(<App />);
    expect(await screen.findByRole("link", { name: "https://app.clickup.com/t/26441883/869fp12dv" }))
      .toHaveAttribute("href", "https://app.clickup.com/t/26441883/869fp12dv");
    // The description text is readable as text (not hidden inside a button).
    expect(screen.getByText(/please/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit description" }));
    const box = await screen.findByRole("textbox", { name: "Description" });
    await user.clear(box);
    await user.type(box, "New text");
    await user.tab();
    await waitFor(async () => expect((await mockInvoke<{ description: string | null }>("task_get", { id })).description).toBe("New text"));

    // Escape cancels: nothing is saved.
    await user.click(screen.getByRole("button", { name: "Edit description" }));
    const again = await screen.findByRole("textbox", { name: "Description" });
    await user.clear(again);
    await user.type(again, "Thrown away");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument());
    expect((await mockInvoke<{ description: string | null }>("task_get", { id })).description).toBe("New text");
  });

  it("empty time and do-on fields are buttons, and both can be set", async () => {
    const user = userEvent.setup();
    // A dated task without a time.
    const id = await taskId("Renew domain for portfolio site");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    expect(await screen.findByRole("button", { name: "Add due time" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Due time")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add due time" }));
    const time = await screen.findByLabelText("Due time");
    await user.type(time, "14:30");
    await user.tab();
    await waitFor(async () => expect((await mockInvoke<{ dueTime: string | null }>("task_get", { id })).dueTime).toBe("14:30"));

    await user.click(screen.getByRole("button", { name: /Do on: not set/ }));
    const picker = await screen.findByRole("dialog", { name: "Reschedule" });
    await user.click(within(picker).getByRole("button", { name: /^Tomorrow/ }));
    await waitFor(async () => expect((await mockInvoke<{ scheduledDate: string | null }>("task_get", { id })).scheduledDate).not.toBeNull());
  });

  it("a task from a meeting summary shows the local AI context with a link to the meeting note", async () => {
    // A local-AI suggestion from a meeting summary.
    const base = sampleStore();
    const claude = base.suggestions.find((x) => x.origin === "claude")!;
    // Same shape as the meeting worker writes: the quote is also the captured text.
    const fromMeeting = { ...claude, id: "sug-meeting", origin: "ai" as const,
      payload: { ...(claude.payload as object), sourceSelection: "I'll send it Friday", sourceTitle: "PBL trainers meeting", sourceUrl: "https://meet.google.com/abc-defg-hij" },
      context: { meeting: { meetingId: "m1", noteId: "note-1", title: "PBL trainers meeting" }, quote: "I'll send it Friday" } };
    resetMock({ suggestions: [fromMeeting] });
    const r = await mockInvoke<{ id: string }>("suggestion_approve", { id: "sug-meeting" });
    window.location.hash = `#/task/${r.id}`;
    render(<App />);
    const ctx = await screen.findByRole("region", { name: "Context from local AI" });
    expect(within(ctx).getByRole("link", { name: "PBL trainers meeting" })).toHaveAttribute("href", "#/notes?note=note-1");
    expect(within(ctx).getByText("Said in the meeting")).toBeInTheDocument();
    // The quote is shown once, not again as "Captured text".
    expect(screen.queryByRole("region", { name: "Captured text" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/I'll send it Friday/)).toHaveLength(1);
    expect((await mockInvoke<{ notes: string | null }>("task_get", { id: r.id })).notes).toBeNull();
  });

  it("shows the title, properties and activity", async () => {
    const id = await taskId("Approve October expense claims");
    await mockInvoke("task_comment", { id, text: "Sent the batch to finance" });
    window.location.hash = `#/task/${id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Approve October expense claims" })).toBeInTheDocument();
    const props = screen.getByRole("complementary", { name: "Properties" });
    expect(within(props).getByRole("button", { name: /^Priority: / })).toBeInTheDocument();
    expect(within(props).getByRole("button", { name: /^Project:/ })).toBeInTheDocument();
    expect(within(props).getByRole("button", { name: /^Status:/ })).toBeInTheDocument();
    expect(within(props).getByRole("group", { name: "Remind me" })).toBeInTheDocument();
    expect(within(await screen.findByRole("region", { name: "Activity" })).getByText(/You: Sent the batch to finance/)).toBeInTheDocument();
  });

  it("adds a link and refuses a javascript: link with the reason", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Add link/ }));
    await user.type(screen.getByLabelText("Link address"), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/http/);
    const none = await mockInvoke<{ links: unknown[] }>("task_get", { id });
    expect(none.links).toHaveLength(0);

    await user.clear(screen.getByLabelText("Link address"));
    await user.type(screen.getByLabelText("Link address"), "https://example.com/claims");
    await user.type(screen.getByLabelText("Link title (optional)"), "Claims sheet");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("link", { name: /Claims sheet/ })).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Remove link/ }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Claims sheet/ })).not.toBeInTheDocument());
    const after = await mockInvoke<{ links: unknown[] }>("task_get", { id });
    expect(after.links).toHaveLength(0);
  });

  it("adds an update and shows it in Activity", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.type(await screen.findByLabelText("Add an update"), "Waiting on Sinead");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/You: Waiting on Sinead/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Add an update")).toHaveValue(""));
  });

  it("changing priority with the segmented control saves it and keeps the other fields", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^Priority: / }));
    await user.click(within(await screen.findByRole("menu", { name: "Priority" })).getByRole("menuitemradio", { name: /High/ }));
    await waitFor(async () => {
      const d = await mockInvoke<{ priority: number; title: string }>("task_get", { id });
      expect(d.priority).toBe(3);
      expect(d.title).toBe("Approve October expense claims");
    });
    expect(await screen.findByRole("button", { name: /^Priority: High/ })).toBeInTheDocument();
  });

  it("Mark complete completes the task and shows a toast with Undo; the top bar has no second button", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Mark complete" }));
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    const toast = await screen.findByRole("status");
    await waitFor(() => expect(toast).toHaveTextContent(/Completed/));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).toBe("completed"));
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).not.toBe("completed"));
  });

  it("the full page title has no checkbox", async () => {
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Approve October expense claims" });
    expect(screen.queryByRole("button", { name: "Complete task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen task" })).not.toBeInTheDocument();
  });

  it("Mark complete completes the task, shows Reopen and a Completed badge", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    const side = await screen.findByRole("complementary", { name: "Properties" });
    await user.click(within(side).getByRole("button", { name: "Mark complete" }));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).toBe("completed"));
    expect(await within(side).findByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(within(side).queryByRole("button", { name: "Tomorrow" })).not.toBeInTheDocument();
    expect(document.querySelector(".td-badge")).toHaveTextContent("Completed");
    await user.click(within(side).getByRole("button", { name: "Reopen" }));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).not.toBe("completed"));
  });

  it("the Repeat menu sets a repeat, and a repeating task makes the next one when completed", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^Repeat: does not repeat/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Every week" }));
    await waitFor(async () =>
      expect((await mockInvoke<{ repeat: unknown }>("task_get", { id })).repeat).toEqual({ every: 1, unit: "week" }));
    expect(await screen.findByRole("button", { name: /^Repeat: Every week/ })).toBeInTheDocument();
    expect(screen.getByText(/Next one is due .* after you complete it/)).toBeInTheDocument();

    await user.click(within(screen.getByRole("complementary", { name: "Properties" })).getByRole("button", { name: "Mark complete" }));
    const toast = await screen.findByRole("status");
    await waitFor(() => expect(toast).toHaveTextContent(/Done\. Next one due \w{3} \d{1,2} \w{3}/));
    const done = await mockInvoke<{ repeatNextId: string | null }>("task_get", { id });
    expect(done.repeatNextId).toBeTruthy();
    const next = await mockInvoke<{ status: string; repeat: unknown }>("task_get", { id: done.repeatNextId });
    expect(next.status).toBe("not_started");
    expect(next.repeat).toEqual({ every: 1, unit: "week" });
    // Undo removes the untouched copy.
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await mockInvoke<{ repeatNextId: string | null }>("task_get", { id })).repeatNextId).toBeNull());
  });

  it("a custom repeat can be saved, and a subtask has no Repeat row", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^Repeat:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Custom…" }));
    const every = await screen.findByLabelText("Repeat every");
    await user.clear(every);
    await user.type(every, "3");
    await user.selectOptions(screen.getByLabelText("Repeat unit"), "month");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect((await mockInvoke<{ repeat: unknown }>("task_get", { id })).repeat).toEqual({ every: 3, unit: "month" }));
    expect(await screen.findByRole("button", { name: /^Repeat: Every 3 months/ })).toBeInTheDocument();

    const sub = await mockInvoke<{ id: string }>("task_create", { input: { title: "A subtask" }, parentId: id });
    window.location.hash = `#/task/${sub.id}`;
    await screen.findByRole("heading", { level: 1, name: "A subtask" });
    expect(screen.queryByRole("button", { name: /^Repeat:/ })).not.toBeInTheDocument();
  });

  it("Escape goes back to My Tasks", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Approve October expense claims" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
  });
});

describe("Quick panel", () => {
  async function renderPanel(id: string, onClose = () => {}) {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/tasks"]}>
          <Routes>
            <Route path="/tasks" element={<QuickPanel id={id} onClose={onClose} />} />
            <Route path="/task/:id" element={<p>Full page opened</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("shows the essentials, and Full details opens the full page", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    await renderPanel(id);
    expect(await screen.findByRole("heading", { name: "Approve October expense claims" })).toBeInTheDocument();
    expect(screen.getByText("Added by you")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Due:/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Remind me" })).toBeInTheDocument();
    expect(screen.getByLabelText("Add a subtask")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", `/task/${id}`);
    await user.click(screen.getByRole("button", { name: /Full details/ }));
    expect(await screen.findByText("Full page opened")).toBeInTheDocument();
  });

  it("Close calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const id = await taskId("Approve October expense claims");
    await renderPanel(id, onClose);
    await user.click(await screen.findByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a reminder preset sets a reminder from the due date", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    await renderPanel(id);
    const preset = await screen.findByRole("button", { name: "15 min before" });
    await user.click(preset);
    await waitFor(() => expect(screen.getByRole("button", { name: "15 min before" })).toHaveAttribute("aria-pressed", "true"));
    expect((await mockInvoke<{ reminderLead: number | null }>("task_get", { id })).reminderLead).toBe(15);
  });

  it("keep reminding until done is saved on the task", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    await renderPanel(id);
    await user.click(await screen.findByRole("switch", { name: /Keep reminding me until it/ }));
    await waitFor(async () =>
      expect((await mockInvoke<{ reminderRepeat: boolean }>("task_get", { id })).reminderRepeat).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Keep reminding me until it/ })).toHaveAttribute("aria-checked", "true"));
  });

  it("a task approved from Claude shows what you said, apart from the notes", async () => {
    const pending = await mockInvoke<{ id: string; origin: string }[]>("suggestions_list", { status: "pending" });
    const s = pending.find((x) => x.origin === "claude")!;
    const r = await mockInvoke<{ id: string }>("suggestion_approve", { id: s.id });
    window.location.hash = `#/task/${r.id}`;
    render(<App />);
    const ctx = await screen.findByRole("region", { name: "Context from Claude" });
    expect(within(ctx).getByText("You said")).toBeInTheDocument();
    expect(within(ctx).getByText(/I'll wire the save tomorrow/)).toBeInTheDocument();
    expect(within(ctx).getByText("Left to do")).toBeInTheDocument();
    const t = await mockInvoke<{ notes: string | null }>("task_get", { id: r.id });
    expect(t.notes).toBeNull();
  });
});
