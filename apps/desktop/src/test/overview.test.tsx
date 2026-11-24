import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";
import { reminderMoments } from "../screens/Overview";
import type { Task } from "@tether/core";

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

describe("Overview", () => {
  it("shows the heading and the summary counts", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Today's focus" });
    await waitFor(() => expect(screen.getByText(/due today/)).toBeInTheDocument());
    const summary = screen.getByText(/due today/).closest(".summary")!;
    expect(summary.textContent).toMatch(/\d+ due today · \d+ overdue · \d+ coming up/);
    expect(summary.querySelector(".od")).not.toBeNull(); // sample data has overdue tasks
    expect(screen.getByRole("progressbar", { name: "Today's progress" })).toBeInTheDocument();
  });

  it("Today's focus lists the overdue sample task", async () => {
    render(<App />);
    const focus = await screen.findByRole("region", { name: "Today's focus" });
    expect(await within(focus).findByText("Send updated teacher list to programme lead")).toBeInTheDocument();
    expect(within(focus).getByRole("link", { name: /Open My Tasks/ })).toHaveAttribute("href", "#/tasks");
  });

  it("Next 7 days shows tomorrow's sample task", async () => {
    render(<App />);
    const week = await screen.findByRole("region", { name: "Next 7 days" });
    expect(await within(week).findByText("Finish educator profile page")).toBeInTheDocument();
  });

  it("Reminders today lists a timed task due today", async () => {
    render(<App />);
    const card = await screen.findByRole("region", { name: "Reminders today" });
    // 15:30 due, default lead 15 min.
    expect(await within(card).findByText("Review course import from LearnWorlds")).toBeInTheDocument();
    expect(within(card).getByText("15:15")).toBeInTheDocument();
  });

  it("Waiting for you shows the Claude suggestion count and title", async () => {
    render(<App />);
    const card = await screen.findByRole("region", { name: "Waiting for you" });
    const link = await within(card).findByRole("link", { name: /Claude suggestions/ });
    expect(link).toHaveAttribute("href", "#/tasks?tray=1");
    expect(within(link).getByText("1")).toBeInTheDocument();
    expect(within(link).getByText("Wire the profile save to the new API")).toBeInTheDocument();
    // The Chrome capture and the unsorted task are the Inbox's.
    expect(within(card).getByRole("link", { name: /In your Inbox/ })).toHaveTextContent("2");
  });

  it("sidebar has Overview, Inbox, My Tasks, Notes and no Review", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    for (const name of ["Overview", "Inbox", "My Tasks", "Notes", "Settings"]) {
      expect(within(nav).getByRole("link", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole("link", { name: /Review/ })).toBeNull();
  });

  it("old /?approvals=1 link lands on the Inbox", async () => {
    window.location.hash = "#/?approvals=1";
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/inbox"));
  });

  it("old /?s=<id> link lands on /inbox?s=<id>", async () => {
    window.location.hash = "#/?s=abc";
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/inbox?s=abc"));
  });

  it("Plan my day is hidden while AI is off", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.queryByRole("button", { name: /Plan my day/ })).toBeNull();
    expect(screen.getByRole("link", { name: /End-of-day review/ })).toHaveAttribute("href", "#/review");
  });

  it("clicking a focus task opens it in My Tasks", async () => {
    const user = userEvent.setup();
    render(<App />);
    const focus = await screen.findByRole("region", { name: "Today's focus" });
    await user.click(await within(focus).findByRole("button", { name: "Send updated teacher list to programme lead" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/tasks\?task=/));
  });
});

describe("reminderMoments (same rules as the scheduler)", () => {
  const base = { id: "x", title: "T", dueDate: null, dueTime: null, reminderLead: null, reminderRepeat: false, nextReminder: null, snoozedUntil: null } as unknown as Task;
  const rules = { enabled: true, dueSoonMinutes: 15, overdueAfterMinutes: 60, workStart: "09:00", workDays: [1, 2, 3, 4, 5] };
  const line = (m: { time: string; title: string }[]) => m.map((x) => `${x.time} ${x.title}`);

  it("covers lead, morning-of, repeat and one-off reminders", () => {
    const today = "2026-11-24"; // Tuesday
    const once = new Date(2026, 10, 24, 11, 5).toISOString();
    const m = reminderMoments([
      { ...base, id: "a", title: "A", dueDate: today, dueTime: "15:30" },
      { ...base, id: "b", title: "B", dueDate: today, dueTime: "15:30", reminderLead: 60 },
      { ...base, id: "c", title: "C", dueDate: today, reminderLead: -1 },
      { ...base, id: "d", title: "D", dueDate: "2026-11-20", reminderRepeat: true },
      { ...base, id: "e", title: "E", dueDate: today },
      { ...base, id: "f", title: "F", dueDate: today, dueTime: "16:00", reminderLead: 0, nextReminder: once },
    ], today, rules);
    expect(line(m)).toEqual(["09:00 C", "09:00 D", "11:05 F", "14:30 B", "15:15 A", "16:00 F"]);
  });

  it("morning-of after the due time, weekends, midnight and switched-off reminders match the scheduler", () => {
    // Due 08:00 with "morning of" at 09:00: no early reminder, only the due time.
    expect(line(reminderMoments([{ ...base, title: "Early", dueDate: "2026-11-24", dueTime: "08:00", reminderLead: -1 }], "2026-11-24", rules)))
      .toEqual(["08:00 Early"]);
    // Repeat does not fire on a Saturday.
    expect(reminderMoments([{ ...base, dueDate: "2026-11-20", reminderRepeat: true }], "2026-11-28", rules)).toEqual([]);
    // Due tomorrow 00:30 with an hour's lead fires 23:30 today.
    expect(line(reminderMoments([{ ...base, title: "Late", dueDate: "2026-11-25", dueTime: "00:30", reminderLead: 60 }], "2026-11-24", rules)))
      .toEqual(["23:30 Late"]);
    // Reminders off: nothing.
    expect(reminderMoments([{ ...base, dueDate: "2026-11-24", dueTime: "15:00" }], "2026-11-24", { ...rules, enabled: false })).toEqual([]);
    // Snoozed from a notification until 16:00: only the snooze.
    const snoozed = new Date(2026, 10, 24, 16, 0).toISOString();
    expect(line(reminderMoments([{ ...base, title: "S", dueDate: "2026-11-24", dueTime: "15:00", snoozedUntil: snoozed }], "2026-11-24", rules)))
      .toEqual(["16:00 S"]);
    // Snoozed until 10:00: the 14:45 reminder still comes afterwards.
    const morning = new Date(2026, 10, 24, 10, 0).toISOString();
    expect(line(reminderMoments([{ ...base, title: "M", dueDate: "2026-11-24", dueTime: "15:00", snoozedUntil: morning }], "2026-11-24", rules)))
      .toEqual(["10:00 M", "14:45 M"]);
  });
});
