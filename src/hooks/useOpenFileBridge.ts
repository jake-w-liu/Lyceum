// Bridges the explorer's open-file intent to the editor tab model (M3 + M6).
// Previewable binary files (PDF/images) open as viewer tabs; everything else is
// read as text. Keeps the explorer decoupled from editor/preview internals.

import { useEffect } from "react";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useEditorStore } from "../state/editorStore";
import { usePreviewStore } from "../state/previewStore";
import { useLayoutStore } from "../state/layoutStore";
import { readFile } from "../lib/ipc";
import { languageForPath } from "../lib/language";
import { isImagePath, isPdfPath } from "../lib/fileTypes";

export function useOpenFileBridge(): void {
  const pendingOpenPath = useWorkspaceStore((s) => s.pendingOpenPath);
  // Re-run even when the same path is requested again (e.g. a second search
  // result in the same file at a different line).
  const pendingOpenSeq = useWorkspaceStore((s) => s.pendingOpenSeq);

  useEffect(() => {
    if (!pendingOpenPath) return;
    const path = pendingOpenPath;
    const workspaceAtRequest = useWorkspaceStore.getState();
    const position = workspaceAtRequest.pendingOpenPosition;
    const rootPath = workspaceAtRequest.rootPath;

    if (isPdfPath(path)) {
      useEditorStore.getState().openDoc({
        path,
        content: "",
        language: "pdf",
        kind: "pdf",
      });
      usePreviewStore.getState().closePreview();
      useLayoutStore.getState().setPdfPanelVisible(false);
      useWorkspaceStore.getState().clearPendingOpen();
      return;
    }
    if (isImagePath(path)) {
      useEditorStore.getState().openDoc({
        path,
        content: "",
        language: "image",
        kind: "image",
      });
      usePreviewStore.getState().closePreview();
      useLayoutStore.getState().setPdfPanelVisible(false);
      useWorkspaceStore.getState().clearPendingOpen();
      return;
    }

    // `superseded` (not "cancelled"): when a newer open request lands while
    // this read is in flight, the resolved file must STILL open — it just must
    // not steal the active tab or clear the newer request's pending state.
    let superseded = false;
    // Record whether this read has ever outlived its originating workspace.
    // Comparing only the root at resolution misses A → B → A, while using
    // rootChangeSeq incorrectly rejects an explicit same-folder reopen.
    let workspaceInvalidated = false;
    const unwatchWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.rootPath !== rootPath) workspaceInvalidated = true;
    });
    (async () => {
      try {
        const content = await readFile(path);
        // A newer FILE request in the same workspace should still let this read
        // open in the background (the superseded behavior below). A WORKSPACE
        // switch is different: its lifecycle reset intentionally discarded all
        // tabs from the old root, so a late read must not repopulate one.
        if (workspaceInvalidated) return;
        useEditorStore.getState().openDoc({
          path,
          content,
          language: languageForPath(path),
          activate: !superseded,
        });
        if (!superseded && position) {
          useEditorStore
            .getState()
            .setPendingReveal(path, position.line, position.column ?? 1);
        }
      } catch (e) {
        // A workspace switch invalidates this request; errors from its old path
        // are no longer actionable and should not pollute the current workspace.
        if (!workspaceInvalidated) {
          console.error("Failed to open", path, e);
        }
      } finally {
        unwatchWorkspace();
        if (!superseded) useWorkspaceStore.getState().clearPendingOpen();
      }
    })();
    return () => {
      superseded = true;
    };
  }, [pendingOpenPath, pendingOpenSeq]);
}
