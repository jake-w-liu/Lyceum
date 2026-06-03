// Frontend bridge to the Rust LSP process manager (M9). Thin wrappers over the
// lsp_* commands plus a listener for framed server->client messages. The
// JSON-RPC framing/correlation lives in jsonRpc.ts; this module only moves
// already-serialized message strings across the Tauri boundary.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function lspStart(
  id: string,
  command: string,
  args: string[],
  cwd: string | null,
): Promise<void> {
  await invoke("lsp_start", { id, command, args, cwd });
}

export async function lspSend(id: string, message: string): Promise<void> {
  await invoke("lsp_send", { id, message });
}

export async function lspStop(id: string): Promise<void> {
  await invoke("lsp_stop", { id });
}

export function onLspMessage(
  id: string,
  cb: (raw: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`lsp:message:${id}`, (event) => cb(event.payload));
}

export function onLspExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen(`lsp:exit:${id}`, () => cb());
}
