// Editor state (Zustand): the set of open documents/viewers and the active tab.
//
// Text files track their on-disk text (savedContent) and in-memory text
// (content); a text doc is "dirty" when these differ. Binary/previewable files
// (PDF/images) still participate in the same tab model but are not writable
// Monaco documents. The tab bar drives setActive/closeDoc.

import { create } from "zustand";
import { ask } from "@tauri-apps/plugin-dialog";

import { baseName } from "./workspaceStore";
import { languageForPath } from "../lib/language";

export type EditorDocKind = "text" | "pdf" | "image";

export interface EditorDoc {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  language: string;
  kind: EditorDocKind;
  reloadVersion: number;
}

/** A 1-based position to reveal once the doc is bound to the editor. */
export interface PendingReveal {
  path: string;
  line: number;
  column: number;
}

export interface EditorData {
  docs: EditorDoc[];
  activePath: string | null;
  /** Current selection text in the active editor (for run-selection, M8). */
  selection: string;
  /** Cursor target for the next editor bind (set on open-at-position; consumed
   * and cleared by MonacoEditor so it never re-reveals on later tab switches). */
  pendingReveal: PendingReveal | null;
  /** The last rename/move applied to open docs, consumed by MonacoEditor to
   * re-key its path->model map (preserving undo history and view state). */
  lastDocMoves: { moves: Array<{ from: string; to: string }>; seq: number } | null;
}

/** True when the in-memory content has unsaved changes. */
export function isDirty(doc: EditorDoc): boolean {
  return doc.kind === "text" && doc.content !== doc.savedContent;
}

/** True when the tab is backed by an editable Monaco text model. */
export function isTextDoc(doc: EditorDoc): boolean {
  return doc.kind === "text";
}

// MonacoEditor registers a flusher that synchronously commits its debounced
// editor->store content write. Anything that reads doc.content (saves, dirty
// checks, run/build save-before-run) calls flushPendingEdits() first so the
// store can never lag behind the buffer at a decision point. Lives here (not in
// MonacoEditor) so callers don't pull the lazy-loaded monaco chunk.
let pendingEditsFlusher: (() => void) | null = null;
export function setPendingEditsFlusher(flush: (() => void) | null): void {
  pendingEditsFlusher = flush;
}
export function flushPendingEdits(): void {
  pendingEditsFlusher?.();
}

/**
 * Native yes/no confirmation via the dialog plugin. `window.confirm` is
 * unreliable in Tauri WebViews (can return immediately / render oddly), so use
 * the plugin and fall back to `confirm` only outside Tauri (vite dev, tests).
 */
export async function askDiscard(message: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Unsaved Changes", kind: "warning" });
  } catch {
    return confirm(message);
  }
}

/**
 * Guard closing a document that has unsaved changes. Resolves true when the doc
 * is clean/absent or when the user confirms discarding; false to cancel the
 * close. Centralized so the tab bar and Cmd+W keybinding behave identically.
 */
export async function confirmDiscard(path: string): Promise<boolean> {
  flushPendingEdits();
  const doc = useEditorStore.getState().docs.find((d) => d.path === path);
  if (!doc || !isDirty(doc)) return true;
  return askDiscard(`Discard unsaved changes to ${doc.name}?`);
}

/** The doc whose path matches activePath, or null when none is active. */
export function getActiveDoc(state: {
  docs: EditorDoc[];
  activePath: string | null;
}): EditorDoc | null {
  return state.docs.find((doc) => doc.path === state.activePath) ?? null;
}

export interface EditorActions {
  openDoc: (input: {
    path: string;
    content: string;
    language: string;
    kind?: EditorDocKind;
    /** Default true. False adds the doc without stealing the active tab (used
     * when a superseded open-file request resolves late). */
    activate?: boolean;
  }) => void;
  closeDoc: (path: string) => void;
  /** Close every open doc except `keepPath` (prompts per unsaved doc). */
  closeOtherDocs: (keepPath: string) => Promise<void>;
  /** Close docs positioned after `fromPath` in the tab order. */
  closeDocsToRight: (fromPath: string) => Promise<void>;
  /** Close every open doc. */
  closeAllDocs: () => Promise<void>;
  /** Close only docs with no unsaved changes (never prompts). */
  closeSavedDocs: () => Promise<void>;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  /**
   * Replace a clean text document with disk content observed through the
   * workspace watcher. `expectedSavedContent` is the doc's savedContent captured
   * before the async read began; the doc is left untouched if it has since
   * become dirty OR its savedContent changed (a save landed during the read), so
   * stale disk bytes can never overwrite a newer save.
   */
  replaceCleanContentFromDisk: (
    path: string,
    content: string,
    expectedSavedContent: string,
  ) => void;
  /** Force a remount/re-read of a binary viewer tab for the same path. */
  bumpReloadVersion: (path: string) => void;
  /**
   * Mark a doc saved. Pass `savedContent` = the exact bytes written to disk; the
   * doc stays dirty if its live buffer has since diverged (edits typed during the
   * async write). Omitting it falls back to the current buffer (legacy behavior).
   */
  markSaved: (path: string, savedContent?: string) => void;
  moveDocPaths: (moves: Array<{ from: string; to: string }>) => void;
  setSelection: (text: string) => void;
  setPendingReveal: (path: string, line: number, column: number) => void;
  clearPendingReveal: () => void;
}

export type EditorState = EditorData & EditorActions;

export const initialEditorData: EditorData = {
  docs: [],
  activePath: null,
  selection: "",
  pendingReveal: null,
  lastDocMoves: null,
};

/**
 * Remove `pathsToClose` (after per-doc discard confirmation) and recompute the
 * active tab, choosing the nearest surviving neighbor to the left then right of
 * the old active tab — matching closeDoc's single-tab preference so a single
 * close and a batch close activate the same tab in the same situation.
 */
async function closeDocs(
  set: (fn: (s: EditorState) => Partial<EditorState>) => void,
  pathsToClose: string[],
): Promise<void> {
  // Sequential prompts (one native dialog at a time, in tab order).
  const confirmed: string[] = [];
  for (const path of pathsToClose) {
    if (await confirmDiscard(path)) confirmed.push(path);
  }
  if (confirmed.length === 0) return;
  const closing = new Set(confirmed);
  set((s) => {
    const docs = s.docs.filter((doc) => !closing.has(doc.path));
    let activePath = s.activePath;
    if (activePath !== null && closing.has(activePath)) {
      const idx = s.docs.findIndex((doc) => doc.path === activePath);
      let neighbor: EditorDoc | null = null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (!closing.has(s.docs[i].path)) {
          neighbor = s.docs[i];
          break;
        }
      }
      if (!neighbor) {
        for (let i = idx + 1; i < s.docs.length; i += 1) {
          if (!closing.has(s.docs[i].path)) {
            neighbor = s.docs[i];
            break;
          }
        }
      }
      activePath = neighbor ? neighbor.path : null;
    }
    return { docs, activePath };
  });
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  ...initialEditorData,

  openDoc: (input) =>
    set((s) => {
      const activate = input.activate ?? true;
      if (s.docs.some((doc) => doc.path === input.path)) {
        return activate ? { activePath: input.path } : {};
      }
      const doc: EditorDoc = {
        path: input.path,
        name: baseName(input.path),
        content: input.content,
        savedContent: input.content,
        language: input.language,
        kind: input.kind ?? "text",
        reloadVersion: 0,
      };
      return {
        docs: [...s.docs, doc],
        activePath: activate ? input.path : s.activePath,
      };
    }),

  closeDoc: (path) =>
    set((s) => {
      const index = s.docs.findIndex((doc) => doc.path === path);
      if (index === -1) {
        return {};
      }
      const docs = s.docs.filter((doc) => doc.path !== path);
      if (s.activePath !== path) {
        return { docs };
      }
      const neighbor =
        s.docs[index - 1] ?? s.docs[index + 1] ?? null;
      return { docs, activePath: neighbor ? neighbor.path : null };
    }),

  closeOtherDocs: (keepPath) =>
    closeDocs(
      set,
      get()
        .docs.filter((doc) => doc.path !== keepPath)
        .map((doc) => doc.path),
    ),

  closeDocsToRight: async (fromPath) => {
    const docs = get().docs;
    const index = docs.findIndex((doc) => doc.path === fromPath);
    if (index === -1) return;
    await closeDocs(
      set,
      docs.slice(index + 1).map((doc) => doc.path),
    );
  },

  closeAllDocs: () => closeDocs(set, get().docs.map((doc) => doc.path)),

  closeSavedDocs: () => {
    // Flush before filtering: a doc with edits still in the debounce window
    // would otherwise pass the !isDirty check and get prompted as a close.
    flushPendingEdits();
    return closeDocs(
      set,
      get()
        .docs.filter((doc) => !isDirty(doc))
        .map((doc) => doc.path),
    );
  },

  setActive: (path) => set({ activePath: path }),

  updateContent: (path, content) =>
    set((s) => ({
      docs: s.docs.map((doc) =>
        doc.path === path && doc.kind === "text" ? { ...doc, content } : doc,
      ),
    })),

  replaceCleanContentFromDisk: (path, content, expectedSavedContent) =>
    set((s) => ({
      docs: s.docs.map((doc) => {
        if (doc.path !== path || doc.kind !== "text" || isDirty(doc)) {
          return doc;
        }
        // The disk read was async; a save (or edit+save) may have completed
        // while it was in flight, leaving the doc clean again but at NEWER
        // content. If savedContent moved since the read started, these disk
        // bytes are stale — skip rather than overwrite the newer save.
        if (doc.savedContent !== expectedSavedContent) {
          return doc;
        }
        if (doc.content === content && doc.savedContent === content) {
          return doc;
        }
        return {
          ...doc,
          content,
          savedContent: content,
          language: languageForPath(path),
          reloadVersion: doc.reloadVersion + 1,
        };
      }),
    })),

  bumpReloadVersion: (path) =>
    set((s) => ({
      docs: s.docs.map((doc) =>
        doc.path === path
          ? { ...doc, reloadVersion: doc.reloadVersion + 1 }
          : doc,
      ),
    })),

  markSaved: (path, savedContent) =>
    set((s) => ({
      docs: s.docs.map((doc) =>
        doc.path === path && doc.kind === "text"
          ? { ...doc, savedContent: savedContent ?? doc.content }
          : doc,
      ),
    })),

  moveDocPaths: (moves) => {
    if (moves.length === 0) return;
    set((s) => {
      const movedPath = (path: string): string => {
        for (const move of moves) {
          if (path === move.from) return move.to;
          const sep = move.from.includes("\\") ? "\\" : "/";
          const prefix = move.from.endsWith(sep) ? move.from : `${move.from}${sep}`;
          if (path.startsWith(prefix)) {
            return `${move.to}${path.slice(move.from.length)}`;
          }
        }
        return path;
      };
      // Record the per-doc moves so MonacoEditor can re-key its model map
      // (keeping the same model object preserves undo history + view state).
      const applied: Array<{ from: string; to: string }> = [];
      const docs = s.docs.map((doc) => {
        const path = movedPath(doc.path);
        if (path === doc.path) return doc;
        applied.push({ from: doc.path, to: path });
        // A rename can change the extension, so recompute the editor language
        // for text docs (e.g. notes.txt -> notes.md should switch to markdown).
        const language =
          doc.kind === "text" ? languageForPath(path) : doc.language;
        return { ...doc, path, name: baseName(path), language };
      });
      const activePath = s.activePath ? movedPath(s.activePath) : s.activePath;
      const lastDocMoves =
        applied.length > 0
          ? { moves: applied, seq: (s.lastDocMoves?.seq ?? 0) + 1 }
          : s.lastDocMoves;
      return { docs, activePath, lastDocMoves };
    });
  },

  setSelection: (text) => set({ selection: text }),

  setPendingReveal: (path, line, column) =>
    set({ pendingReveal: { path, line, column } }),

  clearPendingReveal: () => set({ pendingReveal: null }),
}));
