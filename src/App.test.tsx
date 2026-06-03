import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { initialLayoutData, useLayoutStore } from "./state/layoutStore";

// StatusBar fetches platform info over IPC; mock it so tests are deterministic
// and don't depend on a Tauri runtime.
vi.mock("./lib/ipc", () => ({
  getAppInfo: vi.fn(async () => ({
    name: "lyceum",
    version: "0.0.0",
    os: "testos",
    arch: "testarch",
  })),
}));

// The terminal mounts xterm (needs canvas/layout); stub it in the shell test.
vi.mock("./components/TerminalPanel", () => ({ TerminalPanel: () => null }));

const reset = () => useLayoutStore.setState(initialLayoutData, false);

describe("App shell", () => {
  beforeEach(reset);

  it("renders the core workbench regions", async () => {
    render(<App />);
    expect(screen.getByLabelText("Activity Bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Status Bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
    // Flush StatusBar's async effect to avoid act() warnings.
    await screen.findByTestId("status-platform");
  });

  it("toggles the sidebar with the primary modifier + B", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.queryByLabelText("Sidebar")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
  });

  it("opens the bottom panel with the primary modifier + J", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.queryByLabelText("Panel")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    expect(screen.getByLabelText("Panel")).toBeInTheDocument();
  });

  it("opens the preview panel with modifier + Shift + V", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.queryByLabelText("Preview")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "V", ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText("Preview")).toBeInTheDocument();
  });
});
