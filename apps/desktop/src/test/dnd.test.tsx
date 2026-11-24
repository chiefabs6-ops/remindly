import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const makeDt = () => {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? "",
    get types() { return Object.keys(store); },
    effectAllowed: "",
    dropEffect: "",
  };
};

const sidebar = () => within(screen.getAllByRole("navigation", { name: "Main" })[0]);
const projectLinks = () => Array.from(document.querySelectorAll<HTMLElement>("a[data-project]")).map((a) => a.querySelector("span.flex-1")?.textContent);

describe("Sidebar drag and drop", () => {
  it("dropping a task row on a project link moves the task there, with Undo", async () => {
    render(<App />);
    const row = (await screen.findByText("Review course import from LearnWorlds")).closest<HTMLElement>("[role=listitem]")!;
    const link = await sidebar().findByRole("link", { name: /Administration/ });
    const dt = makeDt();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.types).toContain("application/x-tether-task");
    fireEvent.dragOver(link, { dataTransfer: dt });
    fireEvent.drop(link, { dataTransfer: dt });
    expect(await screen.findByText("Moved to Administration")).toBeInTheDocument();
    const projects = await mockInvoke<{ id: string; name: string }[]>("projects_list", { archived: false });
    const admin = projects.find((p) => p.name === "Administration")!;
    const task = () => mockInvoke<{ projectId: string }[]>("tasks_list", { filter: { query: "LearnWorlds" } }).then((l) => l[0]);
    await waitFor(async () => expect((await task()).projectId).toBe(admin.id));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await task()).projectId).not.toBe(admin.id));
  });

  it("dragging one project link onto another reorders the projects", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "My Tasks" });
    await waitFor(() => expect(projectLinks()).toHaveLength(3));
    expect(projectLinks()).toEqual(["Educator platform", "Administration", "Personal"]);
    const dt = makeDt();
    const links = document.querySelectorAll<HTMLElement>("a[data-project]");
    fireEvent.dragStart(links[2], { dataTransfer: dt });
    fireEvent.dragOver(links[0], { dataTransfer: dt });
    fireEvent.drop(links[0], { dataTransfer: dt });
    await waitFor(() => expect(projectLinks()).toEqual(["Personal", "Educator platform", "Administration"]));
  });
});

describe("My Tasks rows and projects", () => {
  it("a row in the Completed view can still be dropped on a sidebar project", async () => {
    window.location.hash = "#/tasks?view=done";
    render(<App />);
    const row = (await screen.findByText("Order replacement laptop charger")).closest<HTMLElement>("[role=listitem]")!;
    expect(row).toHaveAttribute("draggable", "true");
    const link = await sidebar().findByRole("link", { name: /Administration/ });
    const dt = makeDt();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.types).toContain("application/x-tether-task");
    fireEvent.dragOver(link, { dataTransfer: dt });
    fireEvent.drop(link, { dataTransfer: dt });
    expect(await screen.findByText("Moved to Administration")).toBeInTheDocument();
  });
});
