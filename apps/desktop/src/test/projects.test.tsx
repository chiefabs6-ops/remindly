import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
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
  window.location.hash = "#/projects";
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

type P = { id: string; name: string; archivedAt: string | null };
const project = async (name: string) => (await mockInvoke<P[]>("projects_list", { includeArchived: true })).find((p) => p.name === name)!;

describe("Project page", () => {
  it("shows the stats and the tasks grouped", async () => {
    const admin = await project("Administration");
    window.location.hash = `#/projects/${admin.id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Administration" })).toBeInTheDocument();
    const stats = screen.getByLabelText("Project numbers");
    expect(within(stats).getByText("Open").querySelector("b")).toHaveTextContent("6");
    expect(within(stats).getByText("Overdue").querySelector("b")).toHaveTextContent("2");
    expect(within(stats).getByText("Due this week")).toBeInTheDocument();
    expect(within(stats).getByText("Done in 30 days")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Overdue" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Overdue" })).getByText("Send updated teacher list to programme lead")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Later" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "No date" })).toBeInTheDocument();
    expect(screen.queryByText("Review course import from LearnWorlds")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in My Tasks/ })).toHaveAttribute("href", `#/tasks?project=${admin.id}`);
  });

  it("completing a task shows the toast and Undo reopens it", async () => {
    const user = userEvent.setup();
    const admin = await project("Administration");
    window.location.hash = `#/projects/${admin.id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: 'Complete "Draft newsletter intro"' }));
    expect(await screen.findByText("Completed “Draft newsletter intro”")).toBeInTheDocument();
    await waitFor(async () => {
      const [t] = await mockInvoke<{ status: string }[]>("tasks_list", { filter: { query: "Draft newsletter" } });
      expect(t.status).toBe("completed");
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => {
      const [t] = await mockInvoke<{ status: string }[]>("tasks_list", { filter: { query: "Draft newsletter" } });
      expect(t.status).toBe("not_started");
    });
  });

  it("lists the project's notes and the empty repos hint", async () => {
    const admin = await project("Administration");
    window.location.hash = `#/projects/${admin.id}`;
    render(<App />);
    const link = await screen.findByRole("link", { name: /Monday team meeting/ });
    expect(link.getAttribute("href")).toMatch(/^#\/notes\?note=/);
    expect(screen.queryByText("Ideas for the onboarding email")).not.toBeInTheDocument();
    expect(screen.getByText(/Claude Code links a repo here the first time/)).toBeInTheDocument();
  });

  it("shows the linked Claude Code repo", async () => {
    const edu = await project("Educator platform");
    window.location.hash = `#/projects/${edu.id}`;
    render(<App />);
    expect(await screen.findByText("educator-platform")).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code links a repo here the first time/)).not.toBeInTheDocument();
  });

  it("an unknown id shows not found with a way back", async () => {
    window.location.hash = "#/projects/nope";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Projects" })).toHaveAttribute("href", "#/projects");
  });

  it("an archived project is not found either", async () => {
    const admin = await project("Administration");
    await mockInvoke("project_set_archived", { id: admin.id, archived: true });
    window.location.hash = `#/projects/${admin.id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
  });

  it("quick add creates a task in this project", async () => {
    const user = userEvent.setup();
    const admin = await project("Administration");
    window.location.hash = `#/projects/${admin.id}`;
    render(<App />);
    await user.type(await screen.findByPlaceholderText(/Add a task/), "File the receipts{Enter}");
    await waitFor(async () => {
      const [t] = await mockInvoke<{ projectId: string }[]>("tasks_list", { filter: { query: "File the receipts" } });
      expect(t.projectId).toBe(admin.id);
    });
  });
});

describe("Projects list", () => {
  it("creates a project and archives it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Project name"), "Garden");
    await user.click(screen.getByRole("button", { name: "Add project" }));
    const list = screen.getByRole("list", { name: "Projects" });
    expect(await within(list).findByRole("link", { name: /Garden/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive Garden" }));
    expect(await screen.findByRole("button", { name: "Restore Garden" })).toBeInTheDocument();
    expect((await project("Garden")).archivedAt).not.toBeNull();
  });

  it("edits name, description and colour", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Edit Personal" }));
    const name = screen.getByLabelText("Project name", { selector: "#r-" + (await project("Personal")).id });
    await user.clear(name);
    await user.type(name, "Home");
    await user.click(within(screen.getByRole("form", { name: "Edit Personal" })).getByRole("button", { name: "Rose" }));
    await user.click(within(screen.getByRole("form", { name: "Edit Personal" })).getByRole("button", { name: "Save" }));
    expect(await within(screen.getByRole("list", { name: "Projects" })).findByRole("link", { name: /Home/ })).toBeInTheDocument();
    expect((await mockInvoke<{ name: string; color: string }[]>("projects_list", { includeArchived: true })).find((p) => p.name === "Home")?.color).toBe("#8a1c3c");
  });

  it("opens a project page from the list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await within(await screen.findByRole("list", { name: "Projects" })).findByRole("link", { name: /Personal/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Personal" })).toBeInTheDocument();
    expect(window.location.hash).toMatch(/#\/projects\/.+/);
  });
});
