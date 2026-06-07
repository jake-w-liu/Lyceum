// Tests for QuickOpen: lists workspace files, fuzzy-filters by name, and on
// Enter records the selected path as the workspace's pending-open intent.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickOpen } from "./QuickOpen";
import { initialUiData, useUiStore } from "../state/uiStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import { initialWorkspaceData, useWorkspaceStore } from "../state/workspaceStore";
import { listWorkspaceFiles } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  listWorkspaceFiles: vi.fn(async () => ["/w/src/main.ts", "/w/README.md"]),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("QuickOpen", () => {
  beforeEach(() => {
    vi.mocked(listWorkspaceFiles).mockReset();
    vi.mocked(listWorkspaceFiles).mockResolvedValue([
      "/w/src/main.ts",
      "/w/README.md",
    ]);
    useUiStore.setState(initialUiData, false);
    useTreeStore.setState(initialTreeData, false);
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

  it("refreshes open file results without clearing the typed query", async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);

    await screen.findByText("README.md");
    await user.type(screen.getByLabelText("File search"), "new");
    expect(screen.getByText("No matching files")).toBeInTheDocument();

    vi.mocked(listWorkspaceFiles).mockResolvedValue(["/w/src/new-file.ts"]);
    act(() => useTreeStore.getState().refresh());

    expect(await screen.findByText("new-file.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("File search")).toHaveValue("new");
  });

  it("clears old file results while a new workspace listing is loading", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    vi.mocked(listWorkspaceFiles)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);

    render(<QuickOpen />);
    act(() => first.resolve(["/w/old.ts"]));
    expect(await screen.findByText("old.ts")).toBeInTheDocument();

    act(() => useWorkspaceStore.getState().openWorkspace("/next"));

    expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
    act(() => second.resolve(["/next/new.ts"]));
    expect(await screen.findByText("new.ts")).toBeInTheDocument();
  });
});
