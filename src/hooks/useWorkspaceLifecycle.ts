import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  askDiscard,
  flushPendingEdits,
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
  // Commit any debounced editor->store write first so the check can't miss
  // edits typed within the last debounce window.
  flushPendingEdits();
  return useEditorStore.getState().docs.some(isDirty);
}

export function useWorkspaceLifecycle(): void {
  // Guard workspace switches behind a discard confirmation for dirty docs.
  useEffect(() => {
    let previousRoot = useWorkspaceStore.getState().rootPath;
    let applying = false;
    return useWorkspaceStore.subscribe((state) => {
      if (applying) return;
      const nextRoot = state.rootPath;
      if (nextRoot === previousRoot) return;
      if (hasDirtyWorkspaceDocs()) {
        // The native ask dialog is async, so we cannot block the subscriber:
        // revert the root synchronously, then re-apply the switch only if the
        // user confirms discarding.
        applying = true;
        useWorkspaceStore.setState(
          { rootPath: previousRoot, pendingOpenPath: null, pendingOpenPosition: null },
          false,
        );
        applying = false;
        void askDiscard("Discard unsaved changes before switching folders?").then(
          (ok) => {
            if (!ok) return;
            // The user may have switched/closed again while the dialog was up.
            if (useWorkspaceStore.getState().rootPath !== previousRoot) return;
            previousRoot = nextRoot;
            resetWorkspaceScopedUi();
            applying = true;
            useWorkspaceStore.setState(
              { rootPath: nextRoot, pendingOpenPath: null, pendingOpenPosition: null },
              false,
            );
            applying = false;
          },
        );
        return;
      }
      previousRoot = nextRoot;
      resetWorkspaceScopedUi();
    });
  }, []);

  // Guard the native window close (traffic-light / Alt+F4) behind the same
  // discard confirmation. Degrades to a no-op outside Tauri.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const off = await getCurrentWindow().onCloseRequested(async (event) => {
          if (!hasDirtyWorkspaceDocs()) return;
          const ok = await askDiscard(
            "Discard unsaved changes and close the window?",
          );
          if (!ok) event.preventDefault();
        });
        // Effect already cleaned up before the listener resolved: detach now.
        if (disposed) off();
        else unlisten = off;
      } catch {
        /* not running inside Tauri */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
