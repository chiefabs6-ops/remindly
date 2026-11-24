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

const renderAi = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings?section=ai"]}>
        <SettingsScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );

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
