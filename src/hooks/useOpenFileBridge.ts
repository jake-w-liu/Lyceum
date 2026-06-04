// Bridges the explorer's open-file intent to the right surface (M3 + M6):
// binary previews (PDF/images) open in the preview panel; everything else opens
// as a text document in the editor. Keeps the explorer decoupled from
// editor/preview internals.

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
      usePreviewStore.getState().openPdf(path);
      useLayoutStore.getState().setPdfPanelVisible(true);
      useWorkspaceStore.getState().clearPendingOpen();
      return;
    }
    if (isImagePath(path)) {
      usePreviewStore.getState().openImage(path);
      useLayoutStore.getState().setPdfPanelVisible(true);
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
