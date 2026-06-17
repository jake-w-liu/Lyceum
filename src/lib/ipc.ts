// Thin, typed wrappers around Tauri IPC (`invoke`).
//
// Centralizing IPC here keeps command names/types in one place and lets the UI
// degrade gracefully when running outside a Tauri webview (e.g. plain `vite`
// dev server, unit tests), where `invoke` is unavailable.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../state/workspaceStore";

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
}

/** A single file-explorer entry, mirroring the Rust `DirEntryDto`. */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface TrashItem {
  originalPath: string;
  trashedPath: string;
  isDir: boolean;
}

export interface TrashBatch {
  id: string;
  items: TrashItem[];
}

export interface MovedPath {
  from: string;
  to: string;
  isDir: boolean;
}

export interface WorkspaceFsEvent {
  root: string;
  paths: string[];
  kind: string;
  /**
   * True when the watcher saw Git metadata change under `.git`. These events
   * should refresh decorations without forcing the visible Explorer tree to
   * reload.
   */
  gitChanged?: boolean;
}

const FALLBACK_APP_INFO: AppInfo = {
  name: "lyceum",
  version: "0.2.0",
  os: "web",
  arch: "unknown",
};

function normalizePathForCompare(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "") || normalized;
}

function isSameOrDescendant(path: string, root: string): boolean {
  const p = normalizePathForCompare(path);
  const r = normalizePathForCompare(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

export async function authorizeWorkspaceRoot(root: string): Promise<string> {
  try {
    const result = await invoke<string>("authorize_workspace_root", { root });
    return typeof result === "string" ? result : root;
  } catch {
    return root;
  }
}

async function ensureCurrentWorkspaceAccess(path: string): Promise<void> {
  const root = useWorkspaceStore.getState().rootPath;
  if (root && isSameOrDescendant(path, root)) {
    await authorizeWorkspaceRoot(root);
  }
}

/**
 * Fetch app/platform info from the Rust backend (`get_app_info`).
 * Returns a safe fallback when not running inside Tauri.
 */
export async function getAppInfo(): Promise<AppInfo> {
  try {
    return await invoke<AppInfo>("get_app_info");
  } catch {
    return FALLBACK_APP_INFO;
  }
}

/** Open another Lyceum application window. */
export async function newWindow(): Promise<void> {
  await invoke("new_window");
}

/** Exit the application (called after the frontend's unsaved-changes check). */
export async function quitApp(): Promise<void> {
  await invoke("quit_app");
}

/** List the immediate children of a directory (file explorer, M2). */
export async function readDirectory(path: string): Promise<DirEntry[]> {
  await ensureCurrentWorkspaceAccess(path);
  return invoke<DirEntry[]>("read_directory", { path });
}

/** Start recursively watching the current workspace for filesystem changes. */
export async function watchWorkspace(root: string): Promise<void> {
  await invoke("watch_workspace", { root });
}

/** Stop the active workspace filesystem watcher, if any. */
export async function unwatchWorkspace(root?: string): Promise<void> {
  await invoke("unwatch_workspace", { root: root ?? null });
}

/** List the immediate children of a directory (file explorer, M2). */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  await authorizeWorkspaceRoot(root);
  return invoke<string[]>("list_workspace_files", { root });
}

/** Read a UTF-8 file's contents (editor open, M3). */
export async function readFile(path: string): Promise<string> {
  await ensureCurrentWorkspaceAccess(path);
  return invoke<string>("read_file", { path });
}

/** Write a UTF-8 file's contents (editor save, M3). */
export async function writeFile(path: string, content: string): Promise<void> {
  await ensureCurrentWorkspaceAccess(path);
  await invoke("write_file", { path, content });
}

/**
 * Read a file's raw bytes (PDF viewer, M6). The backend returns a binary IPC
 * response, so the bytes arrive as an ArrayBuffer — no intermediate JSON
 * `number[]` and no second full-size copy.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  await ensureCurrentWorkspaceAccess(path);
  const buf = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buf);
}

/** Cancel an in-flight Julia/build run by id (`run_cancel`). */
export async function runCancel(id: string): Promise<void> {
  await invoke("run_cancel", { id });
}

/** Create a new empty file (errors if it already exists). */
export async function createFile(path: string): Promise<void> {
  await ensureCurrentWorkspaceAccess(path);
  await invoke("create_file", { path });
}

/** Create a directory (and any missing parents). */
export async function createDirectory(path: string): Promise<void> {
  await ensureCurrentWorkspaceAccess(path);
  await invoke("create_directory", { path });
}

/** Rename/move a path (errors if the destination exists). */
export async function renamePath(from: string, to: string): Promise<void> {
  await ensureCurrentWorkspaceAccess(from);
  await ensureCurrentWorkspaceAccess(to);
  await invoke("rename_path", { from, to });
}

/** Move files/directories into an existing workspace directory. */
export async function movePaths(
  root: string,
  paths: string[],
  destinationDir: string,
): Promise<MovedPath[]> {
  await authorizeWorkspaceRoot(root);
  return invoke<MovedPath[]>("move_paths", { root, paths, destinationDir });
}

/** Move files/directories into Lyceum's workspace-local trash for undoable delete. */
export async function movePathsToTrash(
  root: string,
  paths: string[],
): Promise<TrashBatch> {
  await authorizeWorkspaceRoot(root);
  return invoke<TrashBatch>("move_paths_to_trash", { root, paths });
}

/** Restore a previously deleted trash batch. */
export async function restoreTrashBatch(
  root: string,
  items: TrashItem[],
): Promise<void> {
  await authorizeWorkspaceRoot(root);
  await invoke("restore_trash_batch", { root, items });
}

/** Re-apply a previously undone delete batch. */
export async function redoTrashBatch(
  root: string,
  items: TrashItem[],
): Promise<void> {
  await authorizeWorkspaceRoot(root);
  await invoke("redo_trash_batch", { root, items });
}

/** A single workspace content-search match, mirroring the Rust `SearchMatch`. */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

/** Git working-tree status for a single tree entry (mirrors the Rust vocabulary). */
export type GitFileStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflict"
  | "ignored";

/** Workspace git status, mirroring the Rust `GitStatusDto`. */
export interface GitStatus {
  isRepo: boolean;
  /** Top-level repository containing the opened workspace root, when any. */
  rootRepo?: string | null;
  /** Repository roots queried for this workspace. */
  repoRoots?: string[];
  /** Absolute path -> status. */
  files: Record<string, GitFileStatus>;
  /** Absolute path -> owning repository top-level path. */
  fileRepos?: Record<string, string>;
}

/**
 * Fetch git working-tree status for the workspace (Explorer decorations).
 * The backend is best-effort: a folder with no Git repository resolves to
 * `{ isRepo: false }`; folders containing nested repositories still return
 * those nested decorations.
 */
export async function gitStatus(root: string): Promise<GitStatus> {
  await authorizeWorkspaceRoot(root);
  return invoke<GitStatus>("git_status", { root });
}

/** Search file contents under a workspace root (Cmd/Ctrl+Shift+F). */
export async function searchWorkspace(
  root: string,
  query: string,
): Promise<SearchMatch[]> {
  await authorizeWorkspaceRoot(root);
  return invoke<SearchMatch[]>("search_workspace", { root, query });
}

/**
 * Resolve a path to its canonical, symlink-free absolute form (best-effort: the
 * input is returned unchanged outside Tauri or if it cannot be resolved). The
 * workspace is canonicalized at open time so the tree listing, git decorations,
 * search, and watcher all key off ONE canonical root — otherwise a root reached
 * through a symlinked component (e.g. macOS `/tmp`) makes git's canonical paths
 * disagree with the tree's and every decoration silently drops.
 */
export async function canonicalizePath(path: string): Promise<string> {
  try {
    const result = await invoke<string>("canonicalize_path", { path });
    // Defensive: fall back to the input if the backend is unavailable (returns a
    // non-string, e.g. outside Tauri) so callers always get a usable path.
    return typeof result === "string" ? result : path;
  } catch {
    return path;
  }
}

/**
 * Open the native folder picker and return the chosen directory (canonicalized),
 * or null if the user cancelled. Returns null when not running inside Tauri.
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return null;
    return await canonicalizePath(selected);
  } catch {
    return null;
  }
}
