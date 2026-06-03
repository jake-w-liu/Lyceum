// Workspace state (Zustand): the currently opened folder and the most recent
// "open file" intent from the explorer.
//
// In M2 the explorer emits an open-file *intent* (records the path) because the
// editor/tab system arrives in M3; M3 will consume `pendingOpenPath` (or replace
// `requestOpenFile` with a real editor action).

import { create } from "zustand";

/** Basename of a path (the workspace/file display name). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export interface WorkspaceData {
  rootPath: string | null;
  pendingOpenPath: string | null;
}

export interface WorkspaceActions {
  openWorkspace: (path: string) => void;
  closeWorkspace: () => void;
  requestOpenFile: (path: string) => void;
  clearPendingOpen: () => void;
}

export type WorkspaceState = WorkspaceData & WorkspaceActions;

export const initialWorkspaceData: WorkspaceData = {
  rootPath: null,
  pendingOpenPath: null,
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialWorkspaceData,

  openWorkspace: (path) => set({ rootPath: path, pendingOpenPath: null }),
  closeWorkspace: () => set({ rootPath: null, pendingOpenPath: null }),
  requestOpenFile: (path) => set({ pendingOpenPath: path }),
  clearPendingOpen: () => set({ pendingOpenPath: null }),
}));
