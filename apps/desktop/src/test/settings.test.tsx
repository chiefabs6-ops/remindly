import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SettingsScreen } from "../screens/Settings";
import { mockInvoke, resetMock } from "../lib/mock";
import { setBackend } from "../lib/api";
import { queryClient } from "../lib/queries";

beforeEach(() => {
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

const renderSection = (section: string) =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
        <SettingsScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const renderAi = () => renderSection("ai");

describe("Settings: Local AI Test connection", () => {
  it("is disabled with a hint while Local AI is off", async () => {
    renderAi();
    expect(await screen.findByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(screen.getByText("Turn Local AI on first")).toBeInTheDocument();
  });

  it("shows the plain error from the backend", async () => {
    await mockInvoke("ai_settings_set", { value: { enabled: true, url: "http://127.0.0.1:11434", model: "qwen2.5:1.5b" } });
    const user = userEvent.setup();
    renderAi();
    const btn = await screen.findByRole("button", { name: "Test connection" });
    await vi.waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(await screen.findByText("Ollama is not running on this PC. Start Ollama and try again.")).toBeInTheDocument();
  });
});

describe("Settings: Updates", () => {
  it("shows the running version and how far behind it is", async () => {
    renderSection("updates");
    expect(await screen.findByText(/This app: a1b2c3d/)).toBeInTheDocument();
    expect(screen.getByText("2 new changes on main")).toBeInTheDocument();
    expect(screen.getByText("Latest on main: f00ba12")).toBeInTheDocument();
  });

  it("asks before updating, then starts the update", async () => {
    const user = userEvent.setup();
    renderSection("updates");
    await user.click(await screen.findByRole("button", { name: "Update Tether" }));
    expect(screen.getByText("Tether will close and reopen — update now?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Updating in a separate window/)).toBeInTheDocument();
  });

  it("Cancel goes back without updating", async () => {
    const user = userEvent.setup();
    renderSection("updates");
    await user.click(await screen.findByRole("button", { name: "Update Tether" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Update Tether" })).toBeInTheDocument();
    expect(screen.queryByText(/Updating in a separate window/)).not.toBeInTheDocument();
  });

  it("saving a folder that is not the source shows the error", async () => {
    const user = userEvent.setup();
    renderSection("updates");
    const field = await screen.findByLabelText("Source folder");
    await user.clear(field);
    await user.type(field, "C:\\Temp\\nothing");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/is not the Tether source folder/)).toBeInTheDocument();
  });

  it("disables Update and shows the reason when it cannot update", async () => {
    await mockInvoke("settings_set", { key: "updatesStatus", value: { canUpdate: false, reason: "You have unsaved changes in the source folder." } });
    renderSection("updates");
    expect(await screen.findByRole("button", { name: "Update Tether" })).toBeDisabled();
    expect(screen.getByText("You have unsaved changes in the source folder.")).toBeInTheDocument();
  });
});
