import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import App from "../App";
import { QuickPanel } from "../components/QuickPanel";
import { mockInvoke, resetMock } from "../lib/mock";
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
  it("shows the title, properties and activity", async () => {
    const id = await taskId("Approve October expense claims");
    await mockInvoke("task_comment", { id, text: "Sent the batch to finance" });
    window.location.hash = `#/task/${id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Approve October expense claims" })).toBeInTheDocument();
    const props = screen.getByRole("complementary", { name: "Properties" });
    expect(within(props).getByRole("group", { name: "Priority" })).toBeInTheDocument();
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
    const group = await screen.findByRole("group", { name: "Priority" });
    await user.click(within(group).getByRole("button", { name: "High" }));
    await waitFor(async () => {
      const d = await mockInvoke<{ priority: number; title: string }>("task_get", { id });
      expect(d.priority).toBe(3);
      expect(d.title).toBe("Approve October expense claims");
    });
    expect(within(screen.getByRole("group", { name: "Priority" })).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Mark done completes the task and shows a toast with Undo", async () => {
    const user = userEvent.setup();
    const id = await taskId("Approve October expense claims");
    window.location.hash = `#/task/${id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Mark done" }));
    const toast = await screen.findByRole("status");
    await waitFor(() => expect(toast).toHaveTextContent(/Completed/));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).toBe("completed"));
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await mockInvoke<{ status: string }>("task_get", { id })).status).not.toBe("completed"));
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
