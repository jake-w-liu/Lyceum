// Workspace state (Zustand): the currently opened folder and the most recent
// "open file" intent from the explorer/search/quick-open.
//
// An open-file intent records the path plus an optional target position (e.g. a
// search result's line/column). `pendingOpenSeq` increments on every request so
// the bridge re-runs even when the same path is requested twice (e.g. two
// search results in one file).

import { create } from "zustand";

/** Basename of a path (the workspace/file display name). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** A 1-based editor position to reveal after opening a file. */
export interface OpenFilePosition {
  line: number;
  column?: number;
}

export interface WorkspaceData {
  rootPath: string | null;
  pendingOpenPath: string | null;
  pendingOpenPosition: OpenFilePosition | null;
  /** Monotonic id so repeated requests for the same path still re-trigger. */
  pendingOpenSeq: number;
}

export interface WorkspaceActions {
  openWorkspace: (path: string) => void;
  closeWorkspace: () => void;
  requestOpenFile: (path: string, position?: OpenFilePosition) => void;
  clearPendingOpen: () => void;
}

export type WorkspaceState = WorkspaceData & WorkspaceActions;

export const initialWorkspaceData: WorkspaceData = {
  rootPath: null,
  pendingOpenPath: null,
  pendingOpenPosition: null,
  pendingOpenSeq: 0,
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialWorkspaceData,

  openWorkspace: (path) =>
    set({ rootPath: path, pendingOpenPath: null, pendingOpenPosition: null }),
  closeWorkspace: () =>
    set({ rootPath: null, pendingOpenPath: null, pendingOpenPosition: null }),
  requestOpenFile: (path, position) =>
    set((s) => ({
      pendingOpenPath: path,
      pendingOpenPosition: position ?? null,
      pendingOpenSeq: s.pendingOpenSeq + 1,
    })),
  clearPendingOpen: () =>
    set({ pendingOpenPath: null, pendingOpenPosition: null }),
}));
