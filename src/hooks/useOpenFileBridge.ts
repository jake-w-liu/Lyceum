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
    const position = useWorkspaceStore.getState().pendingOpenPosition;

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
    (async () => {
      try {
        const content = await readFile(path);
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
        console.error("Failed to open", path, e);
      } finally {
        if (!superseded) useWorkspaceStore.getState().clearPendingOpen();
      }
    })();
    return () => {
      superseded = true;
    };
  }, [pendingOpenPath, pendingOpenSeq]);
}
