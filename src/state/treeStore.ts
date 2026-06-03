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
import type { DirEntry } from "../lib/ipc";

export interface TreeData {
  expanded: Record<string, boolean>;
  children: Record<string, DirEntry[]>;
  refreshNonce: number;
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
  /** Restore the store to its initial state. */
  reset: () => void;
}

export type TreeState = TreeData & TreeActions;

export const initialTreeData: TreeData = {
  expanded: {},
  children: {},
  refreshNonce: 0,
};

export const useTreeStore = create<TreeState>()((set) => ({
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
  reset: () => set(initialTreeData, false),
}));
