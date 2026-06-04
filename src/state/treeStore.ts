// Centralized file-explorer tree state (Zustand).
//
// The explorer tree previously kept expand/collapse and child-listing state in
// per-node `useState`, which makes tree-wide operations (refresh, collapse-all,
// reveal) impossible. This store lifts that state out so those operations can
// be driven from one place:
//   - `expanded`      which directory paths are currently open
//   - `children`      cached listing per directory path
//   - `refreshNonce`  bumped to force consumers to re-fetch listings

import { create } from "zustand";
import type { DirEntry, TrashBatch } from "../lib/ipc";

const MAX_DELETE_HISTORY = 50;

export interface TreeData {
  expanded: Record<string, boolean>;
  children: Record<string, DirEntry[]>;
  refreshNonce: number;
  selectedPaths: string[];
  anchorPath: string | null;
  focusedPath: string | null;
  deleteUndoStack: TrashBatch[];
  deleteRedoStack: TrashBatch[];
}

export interface TreeActions {
  setChildren: (path: string, entries: DirEntry[]) => void;
  setExpanded: (path: string, value: boolean) => void;
  toggleExpanded: (path: string) => void;
  /** Collapse every directory (expanded back to {}). */
  collapseAll: () => void;
  /** Drop the cached listings and bump the nonce to force a re-fetch. */
  refresh: () => void;
  /** Mark all given paths expanded (used by reveal for each ancestor dir). */
  expandPaths: (paths: string[]) => void;
  /** Replace the Explorer selection. */
  setSelection: (paths: string[], anchorPath?: string | null) => void;
  /** Select exactly one path and use it as the range anchor. */
  selectSingle: (path: string) => void;
  /** Toggle one path in the current selection. */
  toggleSelected: (path: string) => void;
  /** Select a contiguous visible range ending at `path`. */
  selectRange: (visiblePaths: string[], path: string) => void;
  /** Clear selection and range anchor. */
  clearSelection: () => void;
  /** Record an undoable delete and clear redo history. */
  recordDeleteBatch: (batch: TrashBatch) => void;
  /** Push a batch back onto the undo stack without clearing redo history. */
  pushDeleteUndo: (batch: TrashBatch) => void;
  /** Push a batch onto the redo stack. */
  pushDeleteRedo: (batch: TrashBatch) => void;
  /** Pop the latest undoable delete batch. */
  popDeleteUndo: () => TrashBatch | null;
  /** Pop the latest redoable delete batch. */
  popDeleteRedo: () => TrashBatch | null;
  /** Restore the store to its initial state. */
  reset: () => void;
}

export type TreeState = TreeData & TreeActions;

export const initialTreeData: TreeData = {
  expanded: {},
  children: {},
  refreshNonce: 0,
  selectedPaths: [],
  anchorPath: null,
  focusedPath: null,
  deleteUndoStack: [],
  deleteRedoStack: [],
};

export const useTreeStore = create<TreeState>()((set, get) => ({
  ...initialTreeData,

  setChildren: (path, entries) =>
    set((s) => ({ children: { ...s.children, [path]: entries } })),
  setExpanded: (path, value) =>
    set((s) => ({ expanded: { ...s.expanded, [path]: value } })),
  toggleExpanded: (path) =>
    set((s) => ({ expanded: { ...s.expanded, [path]: !s.expanded[path] } })),
  collapseAll: () => set({ expanded: {} }),
  refresh: () =>
    set((s) => ({ children: {}, refreshNonce: s.refreshNonce + 1 })),
  expandPaths: (paths) =>
    set((s) => {
      const expanded = { ...s.expanded };
      for (const path of paths) {
        expanded[path] = true;
      }
      return { expanded };
    }),
  setSelection: (paths, anchorPath) => {
    const unique = uniquePaths(paths);
    const anchor = anchorPath === undefined ? (unique[0] ?? null) : anchorPath;
    set({
      selectedPaths: unique,
      anchorPath: anchor,
      focusedPath: unique[unique.length - 1] ?? anchor ?? null,
    });
  },
  selectSingle: (path) =>
    set({ selectedPaths: [path], anchorPath: path, focusedPath: path }),
  toggleSelected: (path) =>
    set((s) => {
      const selected = s.selectedPaths.includes(path)
        ? s.selectedPaths.filter((p) => p !== path)
        : [...s.selectedPaths, path];
      return {
        selectedPaths: selected,
        anchorPath: path,
        focusedPath: path,
      };
    }),
  selectRange: (visiblePaths, path) =>
    set((s) => {
      const anchor = s.anchorPath ?? s.focusedPath ?? path;
      const from = visiblePaths.indexOf(anchor);
      const to = visiblePaths.indexOf(path);
      if (from < 0 || to < 0) {
        return {
          selectedPaths: [path],
          anchorPath: path,
          focusedPath: path,
        };
      }
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      return {
        selectedPaths: visiblePaths.slice(start, end + 1),
        anchorPath: anchor,
        focusedPath: path,
      };
    }),
  clearSelection: () =>
    set({ selectedPaths: [], anchorPath: null, focusedPath: null }),
  recordDeleteBatch: (batch) =>
    set((s) => ({
      deleteUndoStack: trimHistory([...s.deleteUndoStack, batch]),
      deleteRedoStack: [],
    })),
  pushDeleteUndo: (batch) =>
    set((s) => ({
      deleteUndoStack: trimHistory([...s.deleteUndoStack, batch]),
    })),
  pushDeleteRedo: (batch) =>
    set((s) => ({
      deleteRedoStack: trimHistory([...s.deleteRedoStack, batch]),
    })),
  popDeleteUndo: () => {
    const stack = get().deleteUndoStack;
    const batch = stack[stack.length - 1] ?? null;
    if (batch) set({ deleteUndoStack: stack.slice(0, -1) });
    return batch;
  },
  popDeleteRedo: () => {
    const stack = get().deleteRedoStack;
    const batch = stack[stack.length - 1] ?? null;
    if (batch) set({ deleteRedoStack: stack.slice(0, -1) });
    return batch;
  },
  reset: () => set(initialTreeData, false),
}));

function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function trimHistory<T>(history: T[]): T[] {
  return history.slice(-MAX_DELETE_HISTORY);
}
