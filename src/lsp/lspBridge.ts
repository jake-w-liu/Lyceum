// Frontend bridge to the Rust LSP process manager (M9). Thin wrappers over the
// lsp_* commands plus a listener for framed server->client messages. The
// JSON-RPC framing/correlation lives in jsonRpc.ts; this module only moves
// already-serialized message strings across the Tauri boundary.

import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { listenScoped } from "../lib/windowEvents";

export async function lspStart(
  id: string,
  serverId: string,
  cwd: string | null,
  juliaPath: string | null,
): Promise<void> {
  await invoke("lsp_start", {
    request: { id, serverId, cwd, juliaPath },
  });
}

// Sends can target a server that already exited (e.g. a debounced didChange
// flushing after a crash); the Rust side rejects with "no such lsp server".
// They are fire-and-forget, so swallow the rejection here rather than leaving
// an unhandled promise rejection at every call site.
export async function lspSend(id: string, message: string): Promise<void> {
  try {
    await invoke("lsp_send", { id, message });
  } catch (e) {
    console.debug("lsp_send failed (server gone?)", id, e);
  }
}

export async function lspStop(id: string): Promise<void> {
  await invoke("lsp_stop", { id });
}

export function onLspMessage(
  id: string,
  cb: (raw: string) => void,
): Promise<UnlistenFn> {
  return listenScoped<string>(`lsp:message:${id}`, (event) => cb(event.payload));
}

export function onLspExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listenScoped(`lsp:exit:${id}`, () => cb());
}
