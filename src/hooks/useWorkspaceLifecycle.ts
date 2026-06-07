import { useEffect } from "react";

import {
  initialEditorData,
  isDirty,
  useEditorStore,
} from "../state/editorStore";
import { initialGitData, useGitStore } from "../state/gitStore";
import {
  initialLspStatusData,
  useLspStatusStore,
} from "../state/lspStatusStore";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";
import { initialSearchData, useSearchStore } from "../state/searchStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import { useWorkspaceStore } from "../state/workspaceStore";

export function resetWorkspaceScopedUi(): void {
  useEditorStore.setState(initialEditorData, false);
  usePreviewStore.setState(initialPreviewData, false);
  useTreeStore.setState(initialTreeData, false);
  useSearchStore.setState(initialSearchData, false);
  useGitStore.setState(initialGitData, false);
  useLspStatusStore.setState(initialLspStatusData, false);
}

export function hasDirtyWorkspaceDocs(): boolean {
  return useEditorStore.getState().docs.some(isDirty);
}

export function useWorkspaceLifecycle(): void {
  useEffect(() => {
    let previousRoot = useWorkspaceStore.getState().rootPath;
    return useWorkspaceStore.subscribe((state) => {
      const nextRoot = state.rootPath;
      if (nextRoot === previousRoot) return;
      if (
        hasDirtyWorkspaceDocs() &&
        !confirm("Discard unsaved changes before switching folders?")
      ) {
        useWorkspaceStore.setState(
          { rootPath: previousRoot, pendingOpenPath: null },
          false,
        );
        return;
      }
      previousRoot = nextRoot;
      resetWorkspaceScopedUi();
    });
  }, []);
}
