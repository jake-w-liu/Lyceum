// Tests for QuickOpen: lists workspace files, fuzzy-filters by name, and on
// Enter records the selected path as the workspace's pending-open intent.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickOpen } from "./QuickOpen";
import { initialUiData, useUiStore } from "../state/uiStore";
import { initialWorkspaceData, useWorkspaceStore } from "../state/workspaceStore";

vi.mock("../lib/ipc", () => ({
  listWorkspaceFiles: vi.fn(async () => ["/w/src/main.ts", "/w/README.md"]),
}));

describe("QuickOpen", () => {
  beforeEach(() => {
    useUiStore.setState(initialUiData, false);
    useWorkspaceStore.setState(initialWorkspaceData, false);
    useWorkspaceStore.getState().openWorkspace("/w");
    useUiStore.getState().openModal("quickOpen");
  });

  it("lists workspace files by basename", async () => {
    render(<QuickOpen />);

    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("fuzzy-filters by the typed query", async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);

    await screen.findByText("README.md");
    await user.type(screen.getByLabelText("File search"), "read");

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
  });

  it("opens the selected file on Enter and closes", async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);

    await screen.findByText("README.md");
    await user.type(screen.getByLabelText("File search"), "read");
    await user.keyboard("{Enter}");

    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/w/README.md");
    expect(useUiStore.getState().activeModal).toBeNull();
  });
});
