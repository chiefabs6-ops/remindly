import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  resetMock();
  queryClient.clear();
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

/** A backend that answers after a short delay, so the loading state can be seen. */
const slow = (empty: string[]) => (async (cmd: string, args?: Record<string, unknown>) => {
  await new Promise((r) => setTimeout(r, 60));
  const out = await mockInvoke(cmd, args);
  return empty.includes(cmd) ? [] : out;
}) as typeof mockInvoke;

describe("Loading and empty states", () => {
  it("Projects shows a skeleton, then the empty state, never the empty state first", async () => {
    setBackend(slow(["projects_list"]));
    window.location.hash = "#/projects";
    render(<App />);
    expect(await screen.findByRole("group", { name: "Loading projects" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument();
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Loading projects" })).not.toBeInTheDocument();
  });

  it("My Tasks shows a skeleton, then the empty state", async () => {
    setBackend(slow(["tasks_list"]));
    window.location.hash = "#/tasks";
    render(<App />);
    expect(await screen.findByRole("group", { name: "Loading tasks" })).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("heading", { level: 2, name: /./ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Loading tasks" })).not.toBeInTheDocument();
  });

  it("a missing task shows a friendly line and a way back", async () => {
    setBackend(mockInvoke);
    window.location.hash = "#/task/does-not-exist";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "This task no longer exists" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to My Tasks" })).toBeInTheDocument();
  });
});
