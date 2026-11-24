import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { InboxScreen } from "../screens/Inbox";
import { ToastProvider } from "../components/ui/Toast";
import { mockInvoke, resetMock, sampleStore } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";

beforeEach(() => {
  // Fixed evening clock, as in tasks.test.tsx.
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(evening);
  resetMock();
  setBackend(mockInvoke);
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

type S = { id: string; origin: string; kind: string; status: string };
const pending = () => mockInvoke<S[]>("suggestions_list", { status: "pending" });

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderInbox(url = "/inbox") {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/inbox" element={<InboxScreen />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Inbox", () => {
  it("lists the Chrome capture with its quote, and counts the tabs", async () => {
    renderInbox();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(await screen.findByText("Follow up about the updated teacher list before Friday.")).toBeInTheDocument();
    expect(screen.getByText(/Captured in Chrome · mail\.google\.com/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Captures\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Unsorted\s*1$/ })).toBeInTheDocument();
    // Claude's sample suggestion is a new task: it lives in the My Tasks tray, so no From Claude tab.
    expect(screen.queryByRole("tab", { name: /From Claude/ })).not.toBeInTheDocument();
    expect(screen.getByText(/2 items need a decision\. Nothing here is a task yet\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Tasks" })).toHaveAttribute("href", "/tasks?tray=1");
  });

  it("Add task approves the suggestion and creates the task (no Undo that would lose the capture)", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole("button", { name: "Add task" }));
    expect(await screen.findByText("Added “Follow up about the updated teacher list” to My Tasks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect((await pending()).filter((s) => s.origin === "chrome")).toHaveLength(0);
    await waitFor(async () =>
      expect(await mockInvoke<{ title: string }[]>("tasks_list", { filter: { query: "Follow up about the updated" } })).toHaveLength(1),
    );
  });

  it("Dismiss dismisses the suggestion", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Dismissed")).toBeInTheDocument();
    expect((await pending()).filter((s) => s.origin === "chrome")).toHaveLength(0);
  });

  it("shows the duplicate warning and Add to existing task merges", async () => {
    const user = userEvent.setup();
    renderInbox();
    expect(await screen.findByText(/Looks like an open task/)).toBeInTheDocument();
    expect(await screen.findByText(/Send updated teacher list to programme lead/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Compare" })).toHaveAttribute("href", expect.stringMatching(/^\/task\//));
    await user.click(screen.getByRole("button", { name: "Add to existing task" }));
    expect(await screen.findByText("Added to the existing task")).toBeInTheDocument();
    expect((await pending()).filter((s) => s.origin === "chrome")).toHaveLength(0);
  });

  it("Unsorted tab lists inbox-status tasks", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole("tab", { name: /Unsorted/ }));
    expect(await screen.findByText("Call about gym membership")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: 'Set project for "Call about gym membership"' }));
    await user.click(await screen.findByRole("menuitem", { name: "Personal" }));
    await waitFor(async () => {
      const t = (await mockInvoke<{ status: string }[]>("tasks_list", { filter: { query: "Call about gym" } }))[0];
      expect(t.status).toBe("not_started");
    });
  });

  it("?s= for a Claude task suggestion goes to the My Tasks tray", async () => {
    const claude = (await pending()).find((s) => s.origin === "claude")!;
    renderInbox(`/inbox?s=${claude.id}`);
    expect(await screen.findByTestId("where")).toHaveTextContent("/tasks?tray=1");
  });

  describe("Approve all / Dismiss all", () => {
    /** The sample Chrome capture (a duplicate) plus two plain captures. */
    function seedThree() {
      const base = sampleStore();
      const dup = base.suggestions.find((s) => s.origin === "chrome")!;
      const plain = (n: number) => ({
        ...dup,
        id: `extra-${n}`,
        possibleDuplicateOf: null,
        payload: { title: `Plain capture ${n}` },
      });
      resetMock({ ...base, suggestions: [...base.suggestions, plain(1), plain(2)] });
    }

    it("Approve all adds the plain captures and leaves the duplicate pending", async () => {
      seedThree();
      const user = userEvent.setup();
      renderInbox();
      await user.click(await screen.findByRole("button", { name: "Approve all" }));
      expect(await screen.findByText("Approved 2. 1 left for you to check (looks like a duplicate).")).toBeInTheDocument();
      const left = (await pending()).filter((s) => s.origin === "chrome");
      expect(left).toHaveLength(1);
      expect(left[0].id).not.toMatch(/^extra-/);
      expect(await mockInvoke<unknown[]>("tasks_list", { filter: { query: "Plain capture" } })).toHaveLength(2);
    });

    it("Dismiss all asks first, then dismisses every capture", async () => {
      seedThree();
      const user = userEvent.setup();
      renderInbox();
      await user.click(await screen.findByRole("button", { name: "Dismiss all" }));
      expect((await pending()).filter((s) => s.origin === "chrome")).toHaveLength(3);
      await user.click(screen.getByRole("button", { name: "Dismiss 3?" }));
      expect(await screen.findByText("Dismissed 3.")).toBeInTheDocument();
      expect((await pending()).filter((s) => s.origin === "chrome")).toHaveLength(0);
    });

    it("shows no bulk buttons for a single capture", async () => {
      renderInbox();
      await screen.findByText("Follow up about the updated teacher list before Friday.");
      expect(screen.queryByRole("button", { name: "Approve all" })).not.toBeInTheDocument();
    });
  });
});
