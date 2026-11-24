import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";
import { todayIso } from "../lib/format";
import { addDays } from "@tether/core";

beforeEach(() => {
  // Fixed evening clock: the sample "09:00 today" task is already overdue, whatever time the suite runs.
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
  queryClient.clear();
  window.location.hash = "#/tasks";
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

type T = { id: string; title: string; status: string; dueDate: string | null; dueTime: string | null; priority: number; source: string };
const find = async (query: string) => (await mockInvoke<T[]>("tasks_list", { filter: { query } }))[0];

describe("My Tasks", () => {
  it("shows tab counts and the date groups", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "My Tasks" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^All open\s*11$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Today\s*3$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Upcoming\s*5$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Overdue\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Completed\s*1$/ })).toBeInTheDocument();
    for (const name of ["Overdue", "Today", "Tomorrow", "Later", "No date"]) {
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/due today/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Overdue" })).getByText("Send updated teacher list to programme lead")).toBeInTheDocument();
  });

  it("completing a task shows a toast and Undo reopens it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: 'Complete "Review course import from LearnWorlds"' }));
    expect(await screen.findByText("Completed “Review course import from LearnWorlds”")).toBeInTheDocument();
    await waitFor(async () => expect((await find("Review course import")).status).toBe("completed"));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await find("Review course import")).status).toBe("not_started"));
  });

  it("Move all to today reschedules every overdue task", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Move all to today" }));
    await waitFor(async () => expect((await find("Send updated teacher list")).dueDate).toBe(todayIso()));
    expect(await screen.findByText(/Moved 1 task to today/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overdue\s*0$/ })).toBeInTheDocument());
  });

  it("keyboard: J selects a row and X completes it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Overdue" });
    await user.keyboard("j"); // first row: the overdue task
    await user.keyboard("x");
    await waitFor(async () => expect((await find("Send updated teacher list")).status).toBe("completed"));
  });

  it("opening a row shows the task details panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Draft newsletter intro" }));
    expect(await screen.findByRole("complementary", { name: "Task details" })).toBeInTheDocument();
    expect(window.location.hash).toMatch(/task=/);
  });

  it("the Claude tray is collapsed, and Add task approves the suggestion", async () => {
    const user = userEvent.setup();
    render(<App />);
    const head = await screen.findByRole("button", { name: /Claude suggested 1 task/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(head).toHaveTextContent("Wire the profile save to the new API");
    await user.click(head);
    await user.click(await screen.findByRole("button", { name: "Add task" }));
    await waitFor(async () => expect((await find("Wire the profile save")).source).toBe("claude"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Claude suggested/ })).not.toBeInTheDocument());
  });
});

describe("My Tasks — undo, keyboard and drag", () => {
  it("Undo after completing a task with subtasks restores its status and reopens only the subtasks it closed", async () => {
    const user = userEvent.setup();
    render(<App />);
    const parent = await find("Finish educator profile page");
    expect(parent.status).toBe("in_progress");
    await user.click(await screen.findByRole("button", { name: 'Complete "Finish educator profile page"' }));
    await waitFor(async () => expect((await find("Finish educator profile page")).status).toBe("completed"));
    await waitFor(async () => expect((await find("Test Irish translations")).status).toBe("completed"));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await find("Finish educator profile page")).status).toBe("in_progress"));
    await waitFor(async () => expect((await find("Test Irish translations")).status).toBe("not_started"));
    // The subtask that was already done stays done.
    expect((await find("Fix validation errors on profile form")).status).toBe("completed");
  });

  it("keyboard: T moves the selected task to today", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Overdue" });
    await user.keyboard("j");
    await user.keyboard("t");
    await waitFor(async () => expect((await find("Send updated teacher list")).dueDate).toBe(todayIso()));
  });

  it("drag reorders tasks that share date, time and priority, and sends only those", async () => {
    const day = addDays(todayIso(), 20);
    for (const title of ["Alpha same-day", "Beta same-day"]) {
      await mockInvoke("task_create", { input: { title, dueDate: day, priority: 0 } });
    }
    const calls: unknown[] = [];
    const spy = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "task_reorder") calls.push(args?.ids);
      return mockInvoke(cmd, args);
    });
    setBackend(spy as typeof mockInvoke);
    render(<App />);
    const a = await find("Alpha same-day");
    const b = await find("Beta same-day");
    const rowA = (await screen.findByText("Alpha same-day")).closest("[data-id]")!;
    const rowB = screen.getByText("Beta same-day").closest("[data-id]")!;
    const dt = { effectAllowed: "", setData: () => {}, getData: () => b.id };
    fireEvent.dragStart(rowB, { dataTransfer: dt });
    fireEvent.dragOver(rowA, { dataTransfer: dt });
    fireEvent.drop(rowA, { dataTransfer: dt });
    await waitFor(() => expect(calls).toEqual([[b.id, a.id]]));
    // A task with a different date cannot be a drop target.
    const other = screen.getByText("Prepare Q1 training calendar").closest("[data-id]")!;
    fireEvent.dragStart(rowB, { dataTransfer: dt });
    fireEvent.drop(other, { dataTransfer: dt });
    expect(calls).toHaveLength(1);
  });
});
