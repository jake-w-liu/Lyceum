// Frontend bridge to the Rust PTY backend (M5). Thin wrappers over the
// terminal_* commands plus typed listeners for the per-session output/exit
// events. Output is delivered as raw bytes (number[] -> Uint8Array) so multibyte
// UTF-8 split across reads is handled by xterm, not by us.

import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { listenScoped } from "./windowEvents";

export interface CreatePtyOptions {
  shell?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
}

export async function createPty(id: string, opts: CreatePtyOptions): Promise<void> {
  await invoke("terminal_create", {
    id,
    shell: opts.shell ?? null,
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
  });
}

// write/resize/close target a PTY that may already have exited (shell quit, tab
// closed). They are fire-and-forget, so swallow the rejection here rather than
// leaving an unhandled promise rejection at every call site.
export async function writePty(id: string, data: string): Promise<void> {
  try {
    await invoke("terminal_write", { id, data });
  } catch {
    /* PTY gone; terminal input is best-effort */
  }
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  try {
    await invoke("terminal_resize", { id, cols, rows });
  } catch {
    /* PTY gone; resize is best-effort */
  }
}

export async function closePty(id: string): Promise<void> {
  try {
    await invoke("terminal_close", { id });
  } catch {
    /* PTY already closed/never created */
  }
}

/** Decode a base64 string (terminal output payload) to raw bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function onPtyData(
  id: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listenScoped<string>(`terminal:data:${id}`, (event) => {
    cb(base64ToBytes(event.payload));
  });
}

export function onPtyExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listenScoped(`terminal:exit:${id}`, () => cb());
}
