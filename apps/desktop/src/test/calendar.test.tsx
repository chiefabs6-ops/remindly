import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addDays } from "@tether/core";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";
import { todayIso } from "../lib/format";

beforeEach(() => {
  // Fixed evening clock: the sample "09:00 today" task is already overdue, whatever time the suite runs.
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
  queryClient.clear();
  window.location.hash = "#/calendar";
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

const mondayOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return addDays(iso, -((new Date(y, m - 1, d).getDay() + 6) % 7));
};
const col = (cls: string, date: string) => {
  const el = document.querySelector<HTMLElement>(`.cw .${cls}[data-date="${date}"]`);
  if (!el) throw new Error(`no .${cls} for ${date}`);
  return el;
};

describe("Calendar", () => {
  it("puts a timed task in its day column and an untimed one in the Due row", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Calendar" })).toBeInTheDocument();
    const today = todayIso();
    const timed = await within(await waitFor(() => col("dcol", today))).findByText("Review course import from LearnWorlds");
    expect(timed.closest("a")).toHaveClass("ev");
    expect(within(col("ad", today)).getByText("Order replacement laptop charger").closest("a")).toHaveClass("done");
    expect(document.querySelector(".cw .dh.td")).toHaveAccessibleName(/./);
  });

  it("‹ and › move a week and update ?week=", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Next week" });
    const mon = mondayOf(todayIso());
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(window.location.hash).toContain(`week=${addDays(mon, 7)}`));
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(window.location.hash).toContain(`week=${addDays(mon, -7)}`));
    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(window.location.hash).not.toContain("week="));
  });

  it("an overdue untimed task shows the overdue chip style", async () => {
    const day = addDays(todayIso(), -2);
    window.location.hash = `#/calendar?week=${mondayOf(day)}`;
    render(<App />);
    const chip = await within(await waitFor(() => col("ad", day))).findByText("Send updated teacher list to programme lead");
    expect(chip.closest("a")).toHaveClass("od");
  });

  it("clicking a task opens it in the quick panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    const block = await within(await waitFor(() => col("dcol", todayIso()))).findByText("Review course import from LearnWorlds");
    await user.click(block);
    await waitFor(() => expect(window.location.hash).toMatch(/#\/tasks\?task=/));
  });

  it("Month shows the day cells", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Next week" });
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toContain("view=month"));
  });

  it("an empty week says so", async () => {
    window.location.hash = `#/calendar?week=${addDays(mondayOf(todayIso()), 700)}`;
    render(<App />);
    expect(await screen.findByText("Nothing due this week.")).toBeInTheDocument();
  });
});
