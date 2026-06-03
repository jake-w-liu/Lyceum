import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub the xterm-backed view; we only test the panel's tab/session logic.
vi.mock("./TerminalView", () => ({
  TerminalView: ({ id }: { id: string }) => <div data-testid={`view-${id}`} />,
}));

import { TerminalPanel } from "./TerminalPanel";
import { initialTerminalData, useTerminalStore } from "../state/terminalStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

beforeEach(() => {
  useTerminalStore.setState(initialTerminalData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
});

describe("TerminalPanel", () => {
  it("auto-creates a terminal on mount", () => {
    render(<TerminalPanel />);
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Terminal 1" })).toBeInTheDocument();
  });

  it("creates additional terminals with the New Terminal button", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    await user.click(screen.getByRole("button", { name: "New Terminal" }));
    expect(useTerminalStore.getState().terminals).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toBeInTheDocument();
  });

  it("closes a terminal with its close button", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    await user.click(screen.getByRole("button", { name: "New Terminal" }));
    expect(useTerminalStore.getState().terminals).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Close Terminal 2" }));
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
  });
});
