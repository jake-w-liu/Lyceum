import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import type { WorkspaceFsEvent } from "../lib/ipc";

const {
  listenMock,
  unlistenMock,
  unwatchWorkspaceMock,
  watchWorkspaceMock,
  setListener,
  getListener,
} = vi.hoisted(() => {
  let listener: ((event: Event<WorkspaceFsEvent>) => void) | null = null;
  const unlisten = vi.fn();
  return {
    listenMock: vi.fn((_name: string, cb: (event: Event<WorkspaceFsEvent>) => void) => {
      listener = cb;
      return Promise.resolve(unlisten);
    }),
    unlistenMock: unlisten,
    unwatchWorkspaceMock: vi.fn(),
    watchWorkspaceMock: vi.fn(),
    setListener: (next: ((event: Event<WorkspaceFsEvent>) => void) | null) => {
      listener = next;
    },
    getListener: () => listener,
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../lib/ipc", () => ({
  unwatchWorkspace: unwatchWorkspaceMock,
  watchWorkspace: watchWorkspaceMock,
}));

import { initialTreeData, useTreeStore } from "../state/treeStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useWorkspaceFileWatcher } from "./useWorkspaceFileWatcher";

describe("useWorkspaceFileWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setListener(null);
    unwatchWorkspaceMock.mockResolvedValue(undefined);
    watchWorkspaceMock.mockResolvedValue(undefined);
    useTreeStore.setState(initialTreeData, false);
    useWorkspaceStore.setState({ rootPath: "/w", pendingOpenPath: null });
  });

  it("watches the workspace and debounces filesystem events into tree refreshes", async () => {
    const { unmount } = renderHook(() => useWorkspaceFileWatcher());

    await Promise.resolve();
    expect(watchWorkspaceMock).toHaveBeenCalledWith("/w");
    expect(useTreeStore.getState().refreshNonce).toBe(0);

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/w", paths: ["/w/new.tex"], kind: "Create(File)" },
      });
      getListener()?.({
        event: "workspace:fs-change",
        id: 2,
        payload: { root: "/w", paths: ["/w/new.pdf"], kind: "Create(File)" },
      });
      vi.advanceTimersByTime(149);
    });
    expect(useTreeStore.getState().refreshNonce).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(useTreeStore.getState().refreshNonce).toBe(1);

    unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledWith("/w");
  });

  it("stops watching when no workspace is open", async () => {
    useWorkspaceStore.setState({ rootPath: null, pendingOpenPath: null });

    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    expect(watchWorkspaceMock).not.toHaveBeenCalled();
    expect(unwatchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledWith();
  });
});
