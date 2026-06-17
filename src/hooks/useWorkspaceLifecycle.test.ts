import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native dialog plugin (used by askDiscard) and the window-close listener.
const askMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: askMock }));

type CloseHandler = (event: {
  preventDefault: () => void;
}) => void | Promise<void>;
const { onCloseRequestedMock, destroyMock, getCloseHandler } = vi.hoisted(() => {
  let handler: CloseHandler | null = null;
  const onCloseRequestedMock = vi.fn(async (h: CloseHandler) => {
    handler = h;
    return () => {
      handler = null;
    };
  });
  const destroyMock = vi.fn(async () => {});
  return { onCloseRequestedMock, destroyMock, getCloseHandler: () => handler };
});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: onCloseRequestedMock,
    destroy: destroyMock,
  }),
}));

const flushSettingsPersistenceMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/settingsPersistence", () => ({
  flushSettingsPersistence: flushSettingsPersistenceMock,
}));

import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialGitData, useGitStore } from "../state/gitStore";
import {
  initialLspStatusData,
  useLspStatusStore,
} from "../state/lspStatusStore";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";
import { initialSearchData, useSearchStore } from "../state/searchStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";

function resetStores() {
  useWorkspaceStore.setState(initialWorkspaceData, false);
  useEditorStore.setState(initialEditorData, false);
  usePreviewStore.setState(initialPreviewData, false);
  useTreeStore.setState(initialTreeData, false);
  useSearchStore.setState(initialSearchData, false);
  useGitStore.setState(initialGitData, false);
  useLspStatusStore.setState(initialLspStatusData, false);
}

function seedWorkspaceScopedUi(root: string, dirty = false) {
  useWorkspaceStore.getState().openWorkspace(root);
  useEditorStore.getState().openDoc({
    path: `${root}/main.ts`,
    content: "old",
    language: "typescript",
  });
  if (dirty) useEditorStore.getState().updateContent(`${root}/main.ts`, "dirty");
  useEditorStore.getState().setSelection("dirty");
  usePreviewStore.getState().openPdf(`${root}/paper.pdf`);
  usePreviewStore
    .getState()
    .setViewState(`${root}/paper.pdf`, { page: 3, zoom: 1.4 });
  useTreeStore.getState().setExpanded(root, true);
  useTreeStore.getState().setChildren(root, [
    { name: "main.ts", path: `${root}/main.ts`, isDir: false },
  ]);
  useTreeStore.getState().selectSingle(`${root}/main.ts`);
  useSearchStore.getState().setQuery("needle");
  useSearchStore.getState().setResults([
    { path: `${root}/main.ts`, line: 1, column: 1, text: "needle" },
  ]);
  useSearchStore.getState().setSearching(true);
  useGitStore.setState(
    {
      isRepo: true,
      files: { [`${root}/main.ts`]: "modified" as const },
      folders: { [root]: "modified" as const },
    },
    false,
  );
  useLspStatusStore.getState().setStatus("typescript", "ready");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useWorkspaceLifecycle", () => {
  beforeEach(() => {
    resetStores();
    askMock.mockReset().mockResolvedValue(true);
    flushSettingsPersistenceMock.mockReset().mockResolvedValue(undefined);
    onCloseRequestedMock.mockClear();
    destroyMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("clears workspace-scoped UI when the workspace root changes", () => {
    seedWorkspaceScopedUi("/old");
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().openWorkspace("/new");
    });

    expect(useWorkspaceStore.getState().rootPath).toBe("/new");
    expect(useEditorStore.getState().docs).toEqual([]);
    expect(useEditorStore.getState().activePath).toBeNull();
    expect(useEditorStore.getState().selection).toBe("");
    expect(usePreviewStore.getState()).toMatchObject(initialPreviewData);
    expect(useTreeStore.getState()).toMatchObject(initialTreeData);
    expect(useSearchStore.getState()).toMatchObject(initialSearchData);
    expect(useGitStore.getState()).toMatchObject(initialGitData);
    expect(useLspStatusStore.getState()).toMatchObject(initialLspStatusData);
  });

  it("keeps state when the same workspace path is opened again", () => {
    seedWorkspaceScopedUi("/same");
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().openWorkspace("/same");
    });

    expect(useEditorStore.getState().docs).toHaveLength(1);
    expect(usePreviewStore.getState().pdfPath).toBe("/same/paper.pdf");
    expect(useTreeStore.getState().selectedPaths).toEqual(["/same/main.ts"]);
    expect(useSearchStore.getState().query).toBe("needle");
    expect(useGitStore.getState().isRepo).toBe(true);
    expect(useLspStatusStore.getState().byLanguage.typescript).toBe("ready");
  });

  it("also clears workspace-scoped UI when the workspace closes", () => {
    seedWorkspaceScopedUi("/old");
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().closeWorkspace();
    });

    expect(useWorkspaceStore.getState().rootPath).toBeNull();
    expect(useEditorStore.getState().docs).toEqual([]);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(useTreeStore.getState().children).toEqual({});
    expect(useSearchStore.getState().results).toEqual([]);
    expect(useGitStore.getState().files).toEqual({});
    expect(useLspStatusStore.getState().byLanguage).toEqual({});
  });

  it("reverts a workspace change when dirty tabs are not discarded", async () => {
    seedWorkspaceScopedUi("/old", true);
    askMock.mockResolvedValue(false);
    renderHook(() => useWorkspaceLifecycle());

    await act(async () => {
      useWorkspaceStore.getState().openWorkspace("/new");
    });

    expect(askMock).toHaveBeenCalledWith(
      "Discard unsaved changes before switching folders?",
      expect.anything(),
    );
    expect(useWorkspaceStore.getState().rootPath).toBe("/old");
    expect(useEditorStore.getState().docs).toHaveLength(1);
    expect(useEditorStore.getState().docs[0].content).toBe("dirty");
  });

  it("clears workspace-scoped UI when dirty tabs are explicitly discarded", async () => {
    seedWorkspaceScopedUi("/old", true);
    askMock.mockResolvedValue(true);
    renderHook(() => useWorkspaceLifecycle());

    await act(async () => {
      useWorkspaceStore.getState().openWorkspace("/new");
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().rootPath).toBe("/new"),
    );
    expect(useEditorStore.getState().docs).toEqual([]);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
  });

  it("ignores a stale dirty-switch confirmation after a newer switch attempt", async () => {
    seedWorkspaceScopedUi("/old", true);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    askMock
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().openWorkspace("/first");
    });
    act(() => {
      useWorkspaceStore.getState().openWorkspace("/second");
    });

    expect(useWorkspaceStore.getState().rootPath).toBe("/old");

    await act(async () => {
      first.resolve(true);
      await first.promise;
    });
    expect(useWorkspaceStore.getState().rootPath).toBe("/old");

    await act(async () => {
      second.resolve(true);
      await second.promise;
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().rootPath).toBe("/second"),
    );
  });

  describe("window close guard", () => {
    it("destroys a clean window without prompting", async () => {
      seedWorkspaceScopedUi("/old", false);
      renderHook(() => useWorkspaceLifecycle());
      await waitFor(() => expect(getCloseHandler()).not.toBeNull());

      const preventDefault = vi.fn();
      await act(async () => {
        await getCloseHandler()!({ preventDefault });
      });

      expect(askMock).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(flushSettingsPersistenceMock).toHaveBeenCalledTimes(1),
      );
      await waitFor(() => expect(destroyMock).toHaveBeenCalledTimes(1));
    });

    it("waits for pending persistence to flush before destroying", async () => {
      const flush = deferred<void>();
      flushSettingsPersistenceMock.mockReturnValueOnce(flush.promise);
      seedWorkspaceScopedUi("/old", false);
      renderHook(() => useWorkspaceLifecycle());
      await waitFor(() => expect(getCloseHandler()).not.toBeNull());

      const preventDefault = vi.fn();
      await act(async () => {
        await getCloseHandler()!({ preventDefault });
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(flushSettingsPersistenceMock).toHaveBeenCalledTimes(1);
      expect(destroyMock).not.toHaveBeenCalled();

      await act(async () => {
        flush.resolve();
        await flush.promise;
      });

      await waitFor(() => expect(destroyMock).toHaveBeenCalledTimes(1));
    });

    it("prevents the close when discarding dirty docs is declined", async () => {
      seedWorkspaceScopedUi("/old", true);
      askMock.mockResolvedValue(false);
      renderHook(() => useWorkspaceLifecycle());
      await waitFor(() => expect(getCloseHandler()).not.toBeNull());

      const preventDefault = vi.fn();
      await act(async () => {
        await getCloseHandler()!({ preventDefault });
      });

      expect(askMock).toHaveBeenCalledWith(
        "Discard unsaved changes and close the window?",
        expect.anything(),
      );
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(flushSettingsPersistenceMock).not.toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("allows the close when the discard is confirmed", async () => {
      seedWorkspaceScopedUi("/old", true);
      askMock.mockResolvedValue(true);
      renderHook(() => useWorkspaceLifecycle());
      await waitFor(() => expect(getCloseHandler()).not.toBeNull());

      const preventDefault = vi.fn();
      await act(async () => {
        await getCloseHandler()!({ preventDefault });
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(destroyMock).toHaveBeenCalledTimes(1));
    });

    it("detaches the close listener on unmount", async () => {
      const { unmount } = renderHook(() => useWorkspaceLifecycle());
      await waitFor(() => expect(getCloseHandler()).not.toBeNull());
      unmount();
      expect(getCloseHandler()).toBeNull();
    });
  });
});
