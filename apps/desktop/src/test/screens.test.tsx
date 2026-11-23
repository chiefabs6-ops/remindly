import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";
import { todayIso } from "../lib/format";

beforeEach(() => {
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

describe("Today", () => {
  it("shows overdue and due-today sections with the finding", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    const overdue = await screen.findByRole("region", { name: "Overdue" });
    expect(within(overdue).getByText("Send updated teacher list to programme lead")).toBeInTheDocument();
    expect(screen.getByText(/overdue — start there/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /next 14 days/ })).toBeInTheDocument();
  });

  it("quick add parses and creates a task", async () => {
    const user = userEvent.setup();
    render(<App />);
    const box = await screen.findByLabelText("Add a task");
    await user.type(box, "Call the bank tomorrow #admin !high");
    expect(screen.getByText("Project: Administration")).toBeInTheDocument();
    expect(screen.getByText("Priority: High")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box).toHaveValue(""));
    const all = await mockInvoke<{ title: string; priority: number }[]>("tasks_list", { filter: { query: "Call the bank" } });
    expect(all).toHaveLength(1);
    expect(all[0].priority).toBe(3);
  });

  it("completing a task from its checkbox moves it to Done today", async () => {
    const user = userEvent.setup();
    render(<App />);
    const box = await screen.findByRole("checkbox", { name: /Complete "Book car service"/ });
    await user.click(box);
    const done = await screen.findByRole("region", { name: /Done today/ });
    await waitFor(() => expect(within(done).getByText("Book car service")).toBeInTheDocument());
  });
});

describe("Inbox", () => {
  it("approves a Chrome suggestion with edits", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/inbox";
    render(<App />);
    const title = await screen.findByLabelText("Title");
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    await user.clear(title);
    await user.type(title, "Chase the teacher list");
    await user.click(screen.getByRole("button", { name: "Approve task" }));
    await waitFor(async () => {
      const t = await mockInvoke<{ title: string; source: string }[]>("tasks_list", { filter: { query: "Chase the teacher" } });
      expect(t).toHaveLength(1);
      expect(t[0].source).toBe("chrome");
    });
  });

  it("dismiss removes the suggestion without creating a task", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/inbox";
    render(<App />);
    await screen.findByLabelText("Title");
    const before = (await mockInvoke<unknown[]>("tasks_list", { filter: {} })).length;
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(async () => expect((await mockInvoke<unknown[]>("suggestions_list", { status: "pending" })).length).toBe(1));
    expect((await mockInvoke<unknown[]>("tasks_list", { filter: {} })).length).toBe(before);
  });
});

describe("First run", () => {
  it("asks for projects before showing the app", async () => {
    resetMock({ projects: [], tasks: [], settings: {} });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Set up Tether" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Project name"), "Website relaunch");
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Start with 1 project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
  });
});

describe("Review", () => {
  it("moves an open task to tomorrow and marks one done", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/review";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "End of day review" })).toBeInTheDocument();
    const row = await screen.findByRole("group", { name: "What to do with Book car service" });
    await user.click(within(row).getByRole("button", { name: "Tomorrow" }));
    await waitFor(async () => {
      const [t] = await mockInvoke<{ scheduledDate: string | null }[]>("tasks_list", { filter: { query: "Book car service" } });
      expect(t.scheduledDate).not.toBe(todayIso());
    });
    const draft = await screen.findByRole("group", { name: "What to do with Draft newsletter intro" });
    await user.click(within(draft).getByRole("button", { name: "Done" }));
    await waitFor(async () => {
      const [t] = await mockInvoke<{ status: string }[]>("tasks_list", { filter: { query: "Draft newsletter" } });
      expect(t.status).toBe("completed");
    });
  });
});

describe("Settings backups", () => {
  it("backs up on request and lists the copy", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/settings";
    render(<App />);
    expect(await screen.findByText(/Database check: healthy/)).toBeInTheDocument();
    expect(screen.getByText("No backups yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText(/^Saved tether-/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    // Automatic backups stay off unless switched on.
    expect(screen.getByRole("switch", { name: "Back up automatically every day" })).not.toBeChecked();
  });
});

describe("Local AI", () => {
  it("AI buttons are hidden while off; Plan my day works without AI", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    window.location.hash = `#/?task=${t.id}`;
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Today" });
    expect(await screen.findByLabelText("Title")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with AI/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Plan my day" }));
    expect(await screen.findByText(/Start with/)).toBeInTheDocument();
  });

  it("when on, breaks a task into chosen subtasks", async () => {
    await mockInvoke("ai_settings_set", { value: { enabled: true, url: "http://127.0.0.1:11434", model: "qwen2.5:3b" } });
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    window.location.hash = `#/?task=${t.id}`;
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Break into steps with AI" }));
    await user.click(await screen.findByRole("checkbox", { name: "Check the full profile flow" }));
    await user.click(screen.getByRole("button", { name: "Add 2 subtasks" }));
    await waitFor(async () => {
      const subs = await mockInvoke<unknown[]>("tasks_list", { filter: { parentId: t.id } });
      expect(subs).toHaveLength(2);
    });
  });
});
