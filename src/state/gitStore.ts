// Git decoration state (Zustand) for the file explorer.
//
// Holds the working-tree status of changed files (absolute path -> status) plus
// a derived per-folder rollup so a collapsed directory can show that it contains
// changes (VS Code-style). `refresh()` reads the current workspace root from
// `workspaceStore` and re-queries the backend; it is called on workspace open,
// after any tree mutation (refresh nonce), after a save, and on window focus.

import { create } from "zustand";
import { gitStatus, type GitFileStatus } from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";

/** A folder rollup preserves the strongest visible child decoration:
 * tracked changes beat untracked files, and untracked files beat ignored-only
 * contents. */
export type FolderGitStatus = "modified" | "untracked" | "ignored";
export type GitScope = "workspace" | "nested";
export type GitDecorationStatus = GitFileStatus | FolderGitStatus;

export interface FolderGitDecoration {
  status: FolderGitStatus;
  scope: GitScope;
}

/** Status values that color a folder as "modified" (tracked changes) rather
 * than "untracked" (only new files). */
const TRACKED_CHANGE: ReadonlySet<GitFileStatus> = new Set<GitFileStatus>([
  "modified",
  "deleted",
  "renamed",
  "conflict",
]);

/** Parent directory of an absolute path, or "" once the filesystem root is
 * passed. Handles both separators and avoids looping at "/". */
export function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return "";
  if (idx === 0) return path.length === 1 ? "" : "/";
  return path.slice(0, idx);
}

/** Roll file statuses up to every ancestor directory. Modified beats untracked,
 * and both beat ignored-only contents. */
export function computeFolders(
  files: Record<string, GitFileStatus>,
): Record<string, FolderGitStatus> {
  return computeFolderDecorations(files, {}).statuses;
}

function scopeForRepo(repoRoot: string | undefined, rootRepo: string | null): GitScope {
  if (!repoRoot) return "workspace";
  if (!rootRepo) return "nested";
  return repoRoot === rootRepo ? "workspace" : "nested";
}

function dominantScope(previous: GitScope | undefined, next: GitScope): GitScope {
  return previous === "workspace" || next === "workspace" ? "workspace" : "nested";
}

/** Roll file statuses and repo ownership up to every ancestor directory.
 * Modified beats untracked, and both beat ignored-only contents. Workspace-repo
 * changes beat nested-repo changes only when the same folder contains both. */
export function computeFolderDecorations(
  files: Record<string, GitFileStatus>,
  fileScopes: Record<string, GitScope>,
): {
  statuses: Record<string, FolderGitStatus>;
  scopes: Record<string, GitScope>;
} {
  const folders: Record<string, FolderGitStatus> = {};
  const folderScopes: Record<string, GitScope> = {};
  for (const [path, status] of Object.entries(files)) {
    const tracked = TRACKED_CHANGE.has(status);
    const scope = fileScopes[path] ?? "workspace";
    let p = parentOf(path);
    while (p) {
      if (tracked) {
        folders[p] = "modified";
        folderScopes[p] = dominantScope(folderScopes[p], scope);
      } else if (status === "ignored") {
        if (!folders[p]) {
          folders[p] = "ignored";
        }
        folderScopes[p] = dominantScope(folderScopes[p], scope);
      } else if (folders[p] !== "modified") {
        folders[p] = "untracked";
        folderScopes[p] = dominantScope(folderScopes[p], scope);
      } else {
        folderScopes[p] = dominantScope(folderScopes[p], scope);
      }
      const next = parentOf(p);
      if (next === p) break;
      p = next;
    }
  }
  return { statuses: folders, scopes: folderScopes };
}

function ignoredAncestorScope(
  path: string,
  files: Record<string, GitFileStatus>,
  fileScopes: Record<string, GitScope>,
): GitScope | null {
  let p = parentOf(path);
  while (p) {
    if (files[p] === "ignored") {
      return fileScopes[p] ?? "workspace";
    }
    const next = parentOf(p);
    if (next === p) break;
    p = next;
  }
  return null;
}

export function gitStatusForEntry(
  data: GitData,
  path: string,
  isDir: boolean,
): GitDecorationStatus | null {
  const directStatus = data.files[path] ?? null;
  const folderStatus = isDir ? data.folders[path] ?? null : null;
  if (isDir && folderStatus && folderStatus !== "ignored") return folderStatus;
  if (directStatus) return directStatus;
  if (folderStatus) return folderStatus;
  return ignoredAncestorScope(path, data.files, data.fileScopes) ? "ignored" : null;
}

export function gitScopeForEntry(
  data: GitData,
  path: string,
  isDir: boolean,
): GitScope {
  const directStatus = data.files[path] ?? null;
  const folderStatus = isDir ? data.folders[path] ?? null : null;
  if (isDir && folderStatus && folderStatus !== "ignored") {
    return data.folderScopes[path] ?? "workspace";
  }
  if (directStatus) return data.fileScopes[path] ?? "workspace";
  if (folderStatus) return data.folderScopes[path] ?? "workspace";
  return ignoredAncestorScope(path, data.files, data.fileScopes) ?? "workspace";
}

export interface GitData {
  isRepo: boolean;
  rootRepo: string | null;
  repoRoots: string[];
  files: Record<string, GitFileStatus>;
  fileScopes: Record<string, GitScope>;
  folders: Record<string, FolderGitStatus>;
  folderScopes: Record<string, GitScope>;
}

export interface GitActions {
  /** Re-query git status for the current workspace root. */
  refresh: () => Promise<void>;
  /** Clear all decorations (e.g. when the workspace closes). */
  clear: () => void;
}

export type GitState = GitData & GitActions;

export const initialGitData: GitData = {
  isRepo: false,
  rootRepo: null,
  repoRoots: [],
  files: {},
  fileScopes: {},
  folders: {},
  folderScopes: {},
};

// Monotonic refresh id: only the LATEST in-flight refresh may write state, so a
// slow earlier git query can't clobber a newer one even within the same root
// (e.g. refresh-on-save racing refresh-on-focus).
let refreshSeq = 0;

export const useGitStore = create<GitState>()((set) => ({
  ...initialGitData,

  refresh: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    const seq = (refreshSeq += 1);
    const isCurrent = () =>
      seq === refreshSeq && useWorkspaceStore.getState().rootPath === root;
    if (!root) {
      set(initialGitData);
      return;
    }
    try {
      const res = await gitStatus(root);
      if (!isCurrent()) return;
      const rootRepo = res.rootRepo ?? null;
      const fileScopes = Object.fromEntries(
        Object.keys(res.files).map((path) => [
          path,
          scopeForRepo(res.fileRepos?.[path], rootRepo),
        ]),
      );
      const folders = computeFolderDecorations(res.files, fileScopes);
      set({
        isRepo: res.isRepo,
        rootRepo,
        repoRoots: res.repoRoots ?? [],
        files: res.files,
        fileScopes,
        folders: folders.statuses,
        folderScopes: folders.scopes,
      });
    } catch {
      if (!isCurrent()) return;
      // No Tauri backend (web/dev) or git error: show no decorations.
      set(initialGitData);
    }
  },

  clear: () => set(initialGitData),
}));
