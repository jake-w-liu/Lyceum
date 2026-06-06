// Keeps already-open editor tabs in sync with filesystem watcher events.
// Binary viewer tabs need a remount so their byte-loading effects re-run; clean
// text tabs can be safely replaced with fresh disk content.

import { isTextDoc, useEditorStore } from "../state/editorStore";
import { readFile } from "./ipc";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function reloadOpenEditorPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  const changed = new Set(paths.map(normalizePath));
  const docs = useEditorStore
    .getState()
    .docs.filter((doc) => changed.has(normalizePath(doc.path)));

  for (const doc of docs) {
    if (doc.kind === "pdf" || doc.kind === "image") {
      useEditorStore.getState().bumpReloadVersion(doc.path);
      continue;
    }

    if (!isTextDoc(doc) || doc.content !== doc.savedContent) continue;

    try {
      const content = await readFile(doc.path);
      useEditorStore.getState().replaceCleanContentFromDisk(doc.path, content);
    } catch {
      // The path may have been deleted/renamed between the watcher event and
      // the read. The tree refresh handles visibility; keep the open tab stable.
    }
  }
}
