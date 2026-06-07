import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import type { WorkspaceFsEvent } from "../lib/ipc";

const {
  listenMock,
  readFileMock,
  unlistenMock,
  unwatchWorkspaceMock,
  watchWorkspaceMock,
  setListener,
  getListener,
} = vi.hoisted(() => {
  let listener: ((event: Event<WorkspaceFsEvent>) => void) | null = null;
  const unlisten = vi.fn();
  return {
    listenMock: vi.fn(
      (_name: string, cb: (event: Event<WorkspaceFsEvent>) => void) => {
        listener = cb;
        return Promise.resolve(unlisten);
      },
    ),
    readFileMock: vi.fn(),
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
  readFile: readFileMock,
  unwatchWorkspace: unwatchWorkspaceMock,
  watchWorkspace: watchWorkspaceMock,
}));

import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useWorkspaceFileWatcher } from "./useWorkspaceFileWatcher";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useWorkspaceFileWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setListener(null);
    readFileMock.mockResolvedValue("disk content");
    unwatchWorkspaceMock.mockResolvedValue(undefined);
    watchWorkspaceMock.mockResolvedValue(undefined);
    useEditorStore.setState(initialEditorData, false);
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

  it("reloads open PDF and image viewer tabs for changed paths", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });
    useEditorStore.getState().openDoc({
      path: "/w/plot.png",
      content: "",
      language: "image",
      kind: "image",
    });
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: {
          root: "/w",
          paths: ["/w/paper.pdf", "/w/plot.png"],
          kind: "Modify(Data)",
        },
      });
      vi.advanceTimersByTime(150);
    });

    const docs = useEditorStore.getState().docs;
    expect(
      docs.find((doc) => doc.path === "/w/paper.pdf")?.reloadVersion,
    ).toBe(1);
    expect(
      docs.find((doc) => doc.path === "/w/plot.png")?.reloadVersion,
    ).toBe(1);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("ignores filesystem events from a stale workspace root", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "old",
      language: "typescript",
    });
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/old", paths: ["/w/main.ts"], kind: "Modify(Data)" },
      });
      vi.advanceTimersByTime(150);
    });
    await flushPromises();

    expect(useTreeStore.getState().refreshNonce).toBe(0);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("drops a debounced refresh when the workspace changes first", async () => {
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/w", paths: ["/w/main.ts"], kind: "Modify(Data)" },
      });
      useWorkspaceStore.setState({ rootPath: "/next", pendingOpenPath: null });
      vi.advanceTimersByTime(150);
    });

    expect(useTreeStore.getState().refreshNonce).toBe(0);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("reloads clean open text files from disk", async () => {
    readFileMock.mockResolvedValueOnce("external edit");
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "old",
      language: "typescript",
    });
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/w", paths: ["/w/main.ts"], kind: "Modify(Data)" },
      });
      vi.advanceTimersByTime(150);
    });
    await flushPromises();

    const doc = useEditorStore.getState().docs[0];
    expect(readFileMock).toHaveBeenCalledWith("/w/main.ts");
    expect(doc.content).toBe("external edit");
    expect(doc.savedContent).toBe("external edit");
    expect(doc.reloadVersion).toBe(1);
  });

  it("does not overwrite dirty text files on watcher reload", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "old",
      language: "typescript",
    });
    useEditorStore.getState().updateContent("/w/main.ts", "unsaved");
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/w", paths: ["/w/main.ts"], kind: "Modify(Data)" },
      });
      vi.advanceTimersByTime(150);
    });
    await flushPromises();

    const doc = useEditorStore.getState().docs[0];
    expect(readFileMock).not.toHaveBeenCalled();
    expect(doc.content).toBe("unsaved");
    expect(doc.savedContent).toBe("old");
    expect(doc.reloadVersion).toBe(0);
  });

  it("rechecks dirty state before applying an async text reload", async () => {
    let resolveRead!: (content: string) => void;
    readFileMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "old",
      language: "typescript",
    });
    renderHook(() => useWorkspaceFileWatcher());
    await Promise.resolve();

    act(() => {
      getListener()?.({
        event: "workspace:fs-change",
        id: 1,
        payload: { root: "/w", paths: ["/w/main.ts"], kind: "Modify(Data)" },
      });
      vi.advanceTimersByTime(150);
    });
    expect(readFileMock).toHaveBeenCalledWith("/w/main.ts");

    useEditorStore.getState().updateContent("/w/main.ts", "unsaved");
    resolveRead("external edit");
    await flushPromises();

    const doc = useEditorStore.getState().docs[0];
    expect(doc.content).toBe("unsaved");
    expect(doc.savedContent).toBe("old");
    expect(doc.reloadVersion).toBe(0);
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
