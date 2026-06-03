// Editor state (Zustand): the set of open documents and the active tab.
//
// Each open file is an EditorDoc tracking its on-disk text (savedContent) and
// in-memory text (content); a doc is "dirty" when these differ. The Monaco
// wrapper drives updateContent/markSaved; the tab bar drives setActive/closeDoc.

import { create } from "zustand";

import { baseName } from "./workspaceStore";

export interface EditorDoc {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  language: string;
}

export interface EditorData {
  docs: EditorDoc[];
  activePath: string | null;
  /** Current selection text in the active editor (for run-selection, M8). */
  selection: string;
}

/** True when the in-memory content has unsaved changes. */
export function isDirty(doc: EditorDoc): boolean {
  return doc.content !== doc.savedContent;
}

/** The doc whose path matches activePath, or null when none is active. */
export function getActiveDoc(state: {
  docs: EditorDoc[];
  activePath: string | null;
}): EditorDoc | null {
  return state.docs.find((doc) => doc.path === state.activePath) ?? null;
}

export interface EditorActions {
  openDoc: (input: { path: string; content: string; language: string }) => void;
  closeDoc: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  markSaved: (path: string) => void;
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
        doc.path === path ? { ...doc, content } : doc,
      ),
    })),

  markSaved: (path) =>
    set((s) => ({
      docs: s.docs.map((doc) =>
        doc.path === path ? { ...doc, savedContent: doc.content } : doc,
      ),
    })),

  setSelection: (text) => set({ selection: text }),
}));
