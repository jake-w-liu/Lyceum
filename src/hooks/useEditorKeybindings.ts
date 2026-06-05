// Editor keybindings (M3): save (mod+S), close tab (mod+W), and cycle tabs
// (mod+Tab / mod+Shift+Tab). Like useLayoutKeybindings this is a small focused
// handler; M4 folds it into the command/keybinding registry. The save/cycle
// helpers are exported so they can be unit-tested without the DOM.

import { useEffect } from "react";
import { isMac } from "./useLayoutKeybindings";
import { getActiveDoc, isTextDoc, useEditorStore } from "../state/editorStore";
import { writeFile } from "../lib/ipc";

/** Persist the active document to disk and mark it saved. No-op if none open. */
export async function saveActiveDoc(): Promise<void> {
  const doc = getActiveDoc(useEditorStore.getState());
  if (!doc || !isTextDoc(doc)) return;
  try {
    await writeFile(doc.path, doc.content);
    // Pass the exact content written: if the user kept typing during the async
    // write, the live buffer diverges and the doc must stay dirty (not be cleared).
    useEditorStore.getState().markSaved(doc.path, doc.content);
  } catch (e) {
    // Surfaced via the problems/output panel in a later milestone.
    console.error("Failed to save", doc.path, e);
  }
}

/** Move the active tab by `dir` (+1 next, -1 previous), wrapping around. */
export function focusAdjacentTab(dir: 1 | -1): void {
  const { docs, activePath, setActive } = useEditorStore.getState();
  if (docs.length === 0) return;
  const idx = docs.findIndex((d) => d.path === activePath);
  const nextIdx = (idx + dir + docs.length) % docs.length;
  setActive(docs[nextIdx].path);
}

/** Close the active tab, if any. */
export function closeActiveTab(): void {
  const { activePath, closeDoc } = useEditorStore.getState();
  if (activePath) closeDoc(activePath);
}

export function useEditorKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (e.code === "Tab") {
        e.preventDefault();
        focusAdjacentTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void saveActiveDoc();
      } else if (key === "w") {
        e.preventDefault();
        closeActiveTab();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
