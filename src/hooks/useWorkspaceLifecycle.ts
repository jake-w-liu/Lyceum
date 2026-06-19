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
import { cancelQuit } from "../lib/ipc";
import { flushSettingsPersistence } from "../lib/settingsPersistence";

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
    let switchSeq = 0;
    let applying = false;
    return useWorkspaceStore.subscribe((state) => {
      if (applying) return;
      const nextRoot = state.rootPath;
      if (nextRoot === previousRoot) return;
      if (hasDirtyWorkspaceDocs()) {
        const requestSeq = ++switchSeq;
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
            if (requestSeq !== switchSeq) return;
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
      switchSeq += 1;
      previousRoot = nextRoot;
      resetWorkspaceScopedUi();
    });
  }, []);

  // Guard the native window close (traffic-light / Alt+F4) behind the same
  // discard confirmation. The original close request is always cancelled
  // synchronously, then we explicitly destroy the window after any async prompt.
  // That keeps the native close path deterministic while preserving the dirty
  // document guard. Degrades to a no-op outside Tauri.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let closing = false;
    void (async () => {
      try {
        const currentWindow = getCurrentWindow();
        const off = await currentWindow.onCloseRequested((event) => {
          if (closing) return;
          event.preventDefault();
          void (async () => {
            if (hasDirtyWorkspaceDocs()) {
              const ok = await askDiscard(
                "Discard unsaved changes and close the window?",
              );
              if (!ok) {
                // Declined: abort any in-progress Quit so its QUIT_REQUESTED latch
                // can't force-exit the app on a later, unrelated last-window close.
                void cancelQuit();
                return;
              }
              if (disposed) return;
            }
            closing = true;
            try {
              await flushSettingsPersistence();
              if (disposed) {
                closing = false;
                return;
              }
              await currentWindow.destroy();
            } catch {
              closing = false;
            }
          })();
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
