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

  useEffect(() => {
    if (!pendingOpenPath) return;
    const path = pendingOpenPath;

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

    let active = true;
    (async () => {
      try {
        const content = await readFile(path);
        if (!active) return;
        useEditorStore.getState().openDoc({
          path,
          content,
          language: languageForPath(path),
        });
      } catch (e) {
        console.error("Failed to open", path, e);
      } finally {
        if (active) useWorkspaceStore.getState().clearPendingOpen();
      }
    })();
    return () => {
      active = false;
    };
  }, [pendingOpenPath]);
}
