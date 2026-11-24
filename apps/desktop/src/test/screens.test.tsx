import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { mockInvoke, resetMock, sampleStore } from "../lib/mock";
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

describe("Today", () => {
  it("shows overdue and due-today sections with the finding", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    const overdue = await screen.findByRole("region", { name: "Overdue" });
    expect(within(overdue).getByText("Send updated teacher list to programme lead")).toBeInTheDocument();
    expect(screen.getAllByText(/3 overdue/).length).toBeGreaterThan(0);
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
    await waitFor(async () => {
      const [t] = await mockInvoke<{ status: string }[]>("tasks_list", { filter: { query: "Book car service" } });
      expect(t.status).toBe("completed");
    });
  });
});

describe("Inbox", () => {
  it("approves a Chrome suggestion with edits", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/inbox"; // redirects to Today's approvals panel
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Follow up about the updated teacher list/ }));
    const title = await screen.findByLabelText("Title");
    expect(screen.getByText(/Looks like a task you already have/)).toBeInTheDocument();
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
    window.location.hash = "#/inbox"; // redirects to Today's approvals panel
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Follow up about the updated teacher list/ }));
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
    window.location.hash = "#/settings?section=backups";
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

describe("Settings sections", () => {
  it("shows one section at a time and keeps it in the address", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/settings";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByText(/Database check/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Backups" }));
    expect(await screen.findByText(/Database check: healthy/)).toBeInTheDocument();
    expect(window.location.hash).toContain("section=backups");
  });
});

describe("Projects", () => {
  it("cards show open and overdue counts", async () => {
    window.location.hash = "#/projects";
    render(<App />);
    expect(await screen.findByText("2 overdue")).toBeInTheDocument();
    expect(screen.getByText("6 open")).toBeInTheDocument();
  });
});

describe("Local AI", () => {
  it("AI buttons are hidden while off; Plan my day works without AI", async () => {
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    window.location.hash = `#/?task=${t.id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Book car service" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with AI/ })).toBeNull();
    window.location.hash = "#/";
    expect(await screen.findByText(/Start with/)).toBeInTheDocument();
  });

  it("when on, breaks a task into chosen subtasks", async () => {
    await mockInvoke("ai_settings_set", { value: { enabled: true, url: "http://127.0.0.1:11434", model: "qwen2.5:1.5b" } });
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


describe("Task page", () => {
  it("opens a task as a readable page with where it came from, and Edit shows the form", async () => {
    const user = userEvent.setup();
    const [s0] = await mockInvoke<{ id: string }[]>("suggestions_list", { status: "pending" });
    const r = await mockInvoke<{ id: string }>("suggestion_approve", { id: s0.id });
    window.location.hash = `#/task/${r.id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Follow up about the updated teacher list" })).toBeInTheDocument();
    expect(screen.getByText(/Captured in Chrome/)).toBeInTheDocument();
    expect(screen.getByText(/“Follow up about the updated teacher list before Friday\.”/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Re: Teacher list/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Title")).toHaveValue("Follow up about the updated teacher list");
  });

  it("shows captured text once when the description repeats it", async () => {
    const [s0] = await mockInvoke<{ id: string; payload: Record<string, unknown> }[]>("suggestions_list", { status: "pending" });
    const sel = "Follow up about the updated teacher list before Friday.";
    const r = await mockInvoke<{ id: string }>("suggestion_approve", { id: s0.id, edited: { ...s0.payload, description: sel, sourceSelection: sel } });
    window.location.hash = `#/task/${r.id}`;
    render(<App />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByText(new RegExp(sel.replace(/\./g, "\\.")))).toHaveLength(1);
  });

  it("changing priority in the panel keeps the other fields", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Approve October expense claims" } });
    await mockInvoke("task_update", { id: t.id, input: { title: "Approve October expense claims", dueDate: todayIso(), dueTime: "09:00", priority: 2, tags: ["finance"] } });
    window.location.hash = `#/task/${t.id}`;
    render(<App />);
    await user.selectOptions(await screen.findByLabelText("Priority"), "3");
    await waitFor(async () => {
      const d = await mockInvoke<{ priority: number; tags: string[]; dueTime: string; dueDate: string }>("task_get", { id: t.id });
      expect(d.priority).toBe(3);
      expect(d.tags).toEqual(["finance"]);
      expect(d.dueTime).toBe("09:00");
      expect(d.dueDate).toBe(todayIso());
    });
  });

  it("tags save on blur, not on each key, and follow later changes", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    window.location.hash = `#/task/${t.id}`;
    render(<App />);
    const tags = await screen.findByLabelText("Tags");
    await user.type(tags, "car, car, #home");
    let d = await mockInvoke<{ tags: string[] }>("task_get", { id: t.id });
    expect(d.tags).toEqual([]);
    await user.tab();
    await waitFor(async () => {
      d = await mockInvoke<{ tags: string[] }>("task_get", { id: t.id });
      expect(d.tags).toEqual(["car", "home"]);
    });
    await waitFor(() => expect(screen.getByLabelText("Tags")).toHaveValue("car, home"));
  });

  it("a due date typed in the panel is saved once, on blur, keeping the time", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Approve October expense claims" } });
    window.location.hash = `#/task/${t.id}`;
    render(<App />);
    const due = await screen.findByLabelText("Due");
    await user.clear(due);
    let d = await mockInvoke<{ dueDate: string | null }>("task_get", { id: t.id });
    expect(d.dueDate).toBe(todayIso());
    await user.type(due, "2027-01-15");
    await user.tab();
    await waitFor(async () => {
      const x = await mockInvoke<{ dueDate: string; dueTime: string; history: { field: string | null }[] }>("task_get", { id: t.id });
      expect(x.dueDate).toBe("2027-01-15");
      expect(x.dueTime).toBe("09:00");
    });
  });

  it("a cleared due time stays cleared when the date moves", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Approve October expense claims" } });
    window.location.hash = `#/task/${t.id}`;
    render(<App />);
    const time = await screen.findByLabelText("Due time");
    await user.clear(time);
    await user.tab();
    await waitFor(async () => {
      const d = await mockInvoke<{ dueTime: string | null }>("task_get", { id: t.id });
      expect(d.dueTime).toBeNull();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Tomorrow" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    await waitFor(async () => {
      const d = await mockInvoke<{ dueDate: string; dueTime: string | null }>("task_get", { id: t.id });
      expect(d.dueDate).not.toBe(todayIso());
      expect(d.dueTime).toBeNull();
    });
  });

  it("tags changed in the Edit form show in the panel and are not saved back", async () => {
    const user = userEvent.setup();
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Draft newsletter intro" } });
    window.location.hash = `#/task/${t.id}`;
    render(<App />);
    expect(await screen.findByLabelText("Tags")).toHaveValue("writing");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = await screen.findByLabelText(/^Tags/);
    await user.clear(field);
    await user.type(field, "newsletter");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(screen.getByLabelText("Tags")).toHaveValue("newsletter"));
    await user.click(screen.getByLabelText("Tags"));
    await user.tab();
    const d = await mockInvoke<{ tags: string[] }>("task_get", { id: t.id });
    expect(d.tags).toEqual(["newsletter"]);
  });

  it("old ?task= links land on the task page", async () => {
    const [t] = await mockInvoke<{ id: string }[]>("tasks_list", { filter: { query: "Book car service" } });
    window.location.hash = `#/tasks?task=${t.id}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Book car service" })).toBeInTheDocument();
  });
});

describe("Meeting notes", () => {
  async function openMeetingNote(user: ReturnType<typeof userEvent.setup>) {
    window.location.hash = "#/notes";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Weekly sync/ }));
    return screen.findByLabelText("Meeting summary");
  }

  it("shows the summary status row for a meeting note", async () => {
    const user = userEvent.setup();
    const bar = await openMeetingNote(user);
    expect(within(bar).getByText(/Summarised/)).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "1 action items in approvals" })).toHaveAttribute("href", expect.stringContaining("approvals=1"));
    expect(within(bar).getByText(/2 lines/)).toBeInTheDocument();
  });

  it("a summary arriving while typing keeps the unsaved text", async () => {
    const user = userEvent.setup();
    await openMeetingNote(user);
    const body = screen.getByLabelText("Note");
    await user.type(body, " my own line");
    const [n] = await mockInvoke<{ id: string; title: string; bodyMd: string; kind: string }[]>("notes_list", { filter: { query: "Weekly sync" } });
    await mockInvoke("note_update", { id: n.id, input: { title: n.title, bodyMd: "New summary from the worker", kind: n.kind, tags: [] } });
    await queryClient.invalidateQueries();
    await new Promise((r) => setTimeout(r, 50));
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toContain("my own line");
  });

  it("Try again asks for a new summary", async () => {
    const user = userEvent.setup();
    const store = sampleStore();
    store.meetings[0] = { ...store.meetings[0], summaryStatus: "failed", summaryError: "Ollama is not running" };
    resetMock(store);
    const bar = await openMeetingNote(user);
    expect(within(bar).getByText("Summary failed: Ollama is not running")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Try again" }));
    await waitFor(async () => {
      const m = await mockInvoke<{ summaryStatus: string } | null>("meeting_for_note", { noteId: store.meetings[0].noteId });
      expect(m?.summaryStatus).toBe("pending");
    });
    expect(await screen.findByText(/Summary on the way/)).toBeInTheDocument();
  });

  it("copies the Claude Code command", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const store = sampleStore();
    resetMock(store);
    const bar = await openMeetingNote(user);
    await user.click(within(bar).getByRole("button", { name: "Summarise with Claude Code" }));
    expect(writeText).toHaveBeenCalledWith(`/tether:meeting ${store.meetings[0].id}`);
    expect(await within(bar).findByText(/Copied — paste it in Claude Code/)).toBeInTheDocument();
  });
});
