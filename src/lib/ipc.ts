// Thin, typed wrappers around Tauri IPC (`invoke`).
//
// Centralizing IPC here keeps command names/types in one place and lets the UI
// degrade gracefully when running outside a Tauri webview (e.g. plain `vite`
// dev server, unit tests), where `invoke` is unavailable.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

const FALLBACK_APP_INFO: AppInfo = {
  name: "lyceum",
  version: "0.1.0",
  os: "web",
  arch: "unknown",
};

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

/** List the immediate children of a directory (file explorer, M2). */
export async function readDirectory(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_directory", { path });
}

/** List the immediate children of a directory (file explorer, M2). */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  return invoke<string[]>("list_workspace_files", { root });
}

/** Read a UTF-8 file's contents (editor open, M3). */
export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** Write a UTF-8 file's contents (editor save, M3). */
export async function writeFile(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, content });
}

/**
 * Read a file's raw bytes (PDF viewer, M6). The backend returns a binary IPC
 * response, so the bytes arrive as an ArrayBuffer — no intermediate JSON
 * `number[]` and no second full-size copy.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buf);
}

/** Cancel an in-flight Julia/build run by id (`run_cancel`). */
export async function runCancel(id: string): Promise<void> {
  await invoke("run_cancel", { id });
}

/** Create a new empty file (errors if it already exists). */
export async function createFile(path: string): Promise<void> {
  await invoke("create_file", { path });
}

/** Create a directory (and any missing parents). */
export async function createDirectory(path: string): Promise<void> {
  await invoke("create_directory", { path });
}

/** Rename/move a path (errors if the destination exists). */
export async function renamePath(from: string, to: string): Promise<void> {
  await invoke("rename_path", { from, to });
}

/** Delete a file or directory tree. */
export async function deletePath(path: string): Promise<void> {
  await invoke("delete_path", { path });
}

/** A single workspace content-search match, mirroring the Rust `SearchMatch`. */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

/** Search file contents under a workspace root (Cmd/Ctrl+Shift+F). */
export async function searchWorkspace(
  root: string,
  query: string,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_workspace", { root, query });
}

/**
 * Open the native folder picker and return the chosen directory, or null if the
 * user cancelled. Returns null when not running inside Tauri.
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}
