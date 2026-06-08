// Editor state (Zustand): the set of open documents/viewers and the active tab.
//
// Text files track their on-disk text (savedContent) and in-memory text
// (content); a text doc is "dirty" when these differ. Binary/previewable files
// (PDF/images) still participate in the same tab model but are not writable
// Monaco documents. The tab bar drives setActive/closeDoc.

import { create } from "zustand";

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

export interface EditorData {
  docs: EditorDoc[];
  activePath: string | null;
  /** Current selection text in the active editor (for run-selection, M8). */
  selection: string;
}

/** True when the in-memory content has unsaved changes. */
export function isDirty(doc: EditorDoc): boolean {
  return doc.kind === "text" && doc.content !== doc.savedContent;
}

/** True when the tab is backed by an editable Monaco text model. */
export function isTextDoc(doc: EditorDoc): boolean {
  return doc.kind === "text";
}

/**
 * Guard closing a document that has unsaved changes. Returns true when the doc
 * is clean/absent or when the user confirms discarding; false to cancel the
 * close. Centralized so the tab bar and Cmd+W keybinding behave identically.
 */
export function confirmDiscard(path: string): boolean {
  const doc = useEditorStore.getState().docs.find((d) => d.path === path);
  if (!doc || !isDirty(doc)) return true;
  return confirm(`Discard unsaved changes to ${doc.name}?`);
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
  }) => void;
  closeDoc: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  /**
   * Replace a clean text document with disk content observed through the
   * workspace watcher. Dirty buffers are rechecked inside the action so an async
   * file read can never overwrite edits typed while the read was in flight.
   */
  replaceCleanContentFromDisk: (path: string, content: string) => void;
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
}

export type EditorState = EditorData & EditorActions;

export const initialEditorData: EditorData = {
  docs: [],
  activePath: null,
  selection: "",
};

export const useEditorStore = create<EditorState>()((set) => ({
  ...initialEditorData,

  openDoc: (input) =>
    set((s) => {
      if (s.docs.some((doc) => doc.path === input.path)) {
        return { activePath: input.path };
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
      return { docs: [...s.docs, doc], activePath: input.path };
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

  setActive: (path) => set({ activePath: path }),

  updateContent: (path, content) =>
    set((s) => ({
      docs: s.docs.map((doc) =>
        doc.path === path && doc.kind === "text" ? { ...doc, content } : doc,
      ),
    })),

  replaceCleanContentFromDisk: (path, content) =>
    set((s) => ({
      docs: s.docs.map((doc) => {
        if (doc.path !== path || doc.kind !== "text" || isDirty(doc)) {
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
      const docs = s.docs.map((doc) => {
        const path = movedPath(doc.path);
        if (path === doc.path) return doc;
        // A rename can change the extension, so recompute the editor language
        // for text docs (e.g. notes.txt -> notes.md should switch to markdown).
        const language =
          doc.kind === "text" ? languageForPath(path) : doc.language;
        return { ...doc, path, name: baseName(path), language };
      });
      const activePath = s.activePath ? movedPath(s.activePath) : s.activePath;
      return { docs, activePath };
    });
  },

  setSelection: (text) => set({ selection: text }),
}));
