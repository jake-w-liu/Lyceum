import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("useWorkspaceLifecycle", () => {
  beforeEach(resetStores);
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

  it("reverts a workspace change when dirty tabs are not discarded", () => {
    seedWorkspaceScopedUi("/old", true);
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().openWorkspace("/new");
    });

    expect(confirm).toHaveBeenCalledWith(
      "Discard unsaved changes before switching folders?",
    );
    expect(useWorkspaceStore.getState().rootPath).toBe("/old");
    expect(useEditorStore.getState().docs).toHaveLength(1);
    expect(useEditorStore.getState().docs[0].content).toBe("dirty");
  });

  it("clears workspace-scoped UI when dirty tabs are explicitly discarded", () => {
    seedWorkspaceScopedUi("/old", true);
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderHook(() => useWorkspaceLifecycle());

    act(() => {
      useWorkspaceStore.getState().openWorkspace("/new");
    });

    expect(useWorkspaceStore.getState().rootPath).toBe("/new");
    expect(useEditorStore.getState().docs).toEqual([]);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
  });
});
