// Editor keybindings (M3): save (mod+S), close tab (mod+W), and cycle tabs
// (ctrl+Tab / ctrl+Shift+Tab). Like useLayoutKeybindings this is a small focused
// handler; M4 folds it into the command/keybinding registry. The save/cycle
// helpers are exported so they can be unit-tested without the DOM.

import { useEffect } from "react";
import { isMac } from "./useLayoutKeybindings";
import {
  confirmDiscard,
  flushPendingEdits,
  getActiveDoc,
  isDirty,
  isTextDoc,
  useEditorStore,
} from "../state/editorStore";
import { useGitStore } from "../state/gitStore";
import { writeFile } from "../lib/ipc";

/** Persist the active document to disk and mark it saved. No-op if none open. */
export async function saveActiveDoc(): Promise<void> {
  // Commit any debounced editor->store write so we save the latest buffer.
  flushPendingEdits();
  const doc = getActiveDoc(useEditorStore.getState());
  if (!doc || !isTextDoc(doc)) return;
  try {
    await writeFile(doc.path, doc.content);
    // Pass the exact content written: if the user kept typing during the async
    // write, the live buffer diverges and the doc must stay dirty (not be cleared).
    useEditorStore.getState().markSaved(doc.path, doc.content);
    // A save changes working-tree status; refresh Explorer git decorations.
    void useGitStore.getState().refresh();
  } catch (e) {
    // Surfaced via the problems/output panel in a later milestone.
    console.error("Failed to save", doc.path, e);
  }
}

/**
 * Persist every dirty text document to disk. Each write captures the exact bytes
 * sent so a doc still being edited during its async write stays dirty (same rule
 * as saveActiveDoc). Refreshes git decorations once after the batch.
 */
export async function saveAllDocs(): Promise<void> {
  flushPendingEdits();
  const dirty = useEditorStore
    .getState()
    .docs.filter((doc) => isTextDoc(doc) && isDirty(doc));
  if (dirty.length === 0) return;
  let wrote = false;
  for (const doc of dirty) {
    const content = doc.content;
    try {
      await writeFile(doc.path, content);
      useEditorStore.getState().markSaved(doc.path, content);
      wrote = true;
    } catch (e) {
      console.error("Failed to save", doc.path, e);
    }
  }
  if (wrote) void useGitStore.getState().refresh();
}

/** Move the active tab by `dir` (+1 next, -1 previous), wrapping around. */
export function focusAdjacentTab(dir: 1 | -1): void {
  const { docs, activePath, setActive } = useEditorStore.getState();
  if (docs.length === 0) return;
  const idx = docs.findIndex((d) => d.path === activePath);
  const nextIdx = (idx + dir + docs.length) % docs.length;
  setActive(docs[nextIdx].path);
}

/** Close the active tab, if any. Prompts before discarding unsaved changes. */
export async function closeActiveTab(): Promise<void> {
  const { activePath } = useEditorStore.getState();
  if (activePath && (await confirmDiscard(activePath))) {
    useEditorStore.getState().closeDoc(activePath);
  }
}

export function useEditorKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Tab cycling uses Ctrl on EVERY platform (VS Code convention): on macOS
      // Cmd+Tab is the OS app switcher and never reaches the WebView.
      if (e.code === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        focusAdjacentTab(e.shiftKey ? -1 : 1);
        return;
      }
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void saveActiveDoc();
      } else if (key === "w") {
        e.preventDefault();
        void closeActiveTab();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
