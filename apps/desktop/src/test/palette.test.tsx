import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";

beforeEach(() => {
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
  queryClient.clear();
  window.location.hash = "#/tasks";
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

const openPalette = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "My Tasks" });
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog");
};

describe("Command palette", () => {
  it("Ctrl+K opens it with the input focused and a hint; Escape closes it", async () => {
    const user = userEvent.setup();
    const dialog = await openPalette(user);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Search");
    expect(within(dialog).getByRole("combobox")).toHaveFocus();
    expect(within(dialog).getByText(/Type to find/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("the top-bar search box opens it too", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Search tasks, notes and projects" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("typing a task title shows it; Enter opens the task page", async () => {
    const user = userEvent.setup();
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "LearnWorlds");
    const opt = await within(dialog).findByRole("option", { name: /Review course import from LearnWorlds/ });
    expect(within(dialog).getByText("Tasks")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox")).toHaveAttribute("aria-activedescendant", opt.id);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/task\/.+/));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ArrowDown moves to the last row, which searches all tasks", async () => {
    const user = userEvent.setup();
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "LearnWorlds");
    await within(dialog).findByRole("option", { name: /Review course import/ });
    const rows = within(dialog).getAllByRole("option");
    for (let i = 1; i < rows.length; i++) await user.keyboard("{ArrowDown}");
    expect(rows[rows.length - 1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?q=LearnWorlds"));
  });

  it("finds a project and opens it", async () => {
    const user = userEvent.setup();
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "Administration");
    await within(dialog).findByText("Projects");
    const row = within(dialog).getAllByRole("option").find((o) => /open$/.test(o.textContent ?? ""))!;
    await user.click(row);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/projects\/.+/));
  });
});
