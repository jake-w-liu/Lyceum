// LSP client lifecycle (M9): starts a language server per language via the Rust
// bridge, runs the initialize/initialized handshake, and forwards document
// sync + server-pushed diagnostics. Tauri-bound (smoke-tested via `tauri dev`);
// the framing (lsp.rs), JSON-RPC correlation (jsonRpc.ts), and protocol helpers
// (lspProtocol.ts) it builds on are unit-tested.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { createRpcClient, type RpcClient } from "./jsonRpc";
import { lspSend, lspStart, lspStop, onLspExit, onLspMessage } from "./lspBridge";
import { serverForLanguage } from "./servers";
import { buildInitializeParams } from "./lspProtocol";
import { useLspStatusStore } from "../state/lspStatusStore";

export interface LspSession {
  id: string;
  languageId: string;
  rpc: RpcClient;
  ready: Promise<void>;
  unlistens: UnlistenFn[];
  openDocs: Set<string>;
  /**
   * Server capabilities from the `initialize` result, used to gate Monaco
   * providers so we never issue (e.g.) rename/format requests to a server that
   * does not advertise them. Empty until the handshake resolves.
   */
  capabilities: Record<string, unknown>;
}

const sessions = new Map<string, LspSession>();

// Monotonic token making every spawned server's id unique, even across a
// stop/restart of the same language. Without this, a restarted server reuses the
// id `lsp-<lang>` and the previous instance's in-flight `lsp:exit:<id>` event
// would tear down the fresh replacement (and the Rust side would emit a spurious
// exit on the shared channel). A unique id per spawn isolates both event streams.
let lspInstanceSeq = 0;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Diagnostics handler set by the Monaco integration (decouples client<->monaco). */
let diagnosticsSink:
  | ((uri: string, diagnostics: unknown[]) => void)
  | null = null;
export function setDiagnosticsSink(
  fn: (uri: string, diagnostics: unknown[]) => void,
): void {
  diagnosticsSink = fn;
}

export function getSession(languageId: string): LspSession | undefined {
  return sessions.get(languageId);
}

/** Start (or reuse) the language server for a language. Returns null if none configured. */
export async function ensureServer(
  languageId: string,
  rootPath: string | null,
  juliaPath: string | null,
): Promise<LspSession | null> {
  const existing = sessions.get(languageId);
  if (existing) return existing;
  const config = serverForLanguage(languageId);
  if (!config) return null;

  const id = `lsp-${languageId}-${(lspInstanceSeq += 1)}`;
  const { cmd, args } = config.build({ juliaPath });
  useLspStatusStore.getState().setStatus(languageId, "starting");

  const rpc = createRpcClient({ send: (message) => void lspSend(id, message) });
  rpc.onNotification("textDocument/publishDiagnostics", (params) => {
    const p = params as { uri?: string; diagnostics?: unknown[] };
    if (p && typeof p.uri === "string") {
      diagnosticsSink?.(p.uri, p.diagnostics ?? []);
    }
  });

  const unlistens: UnlistenFn[] = [];

  const session: LspSession = {
    id,
    languageId,
    rpc,
    // Replaced just below once the handshake promise is constructed.
    ready: Promise.resolve(),
    unlistens,
    openDocs: new Set(),
    capabilities: {},
  };
  sessions.set(languageId, session);

  const ready = (async () => {
    try {
      unlistens.push(await onLspMessage(id, (raw) => rpc.handleMessage(raw)));
      unlistens.push(
        await onLspExit(id, () => {
          useLspStatusStore.getState().setStatus(languageId, "off");
          rpc.dispose("server exited");
          if (sessions.get(languageId) === session) {
            sessions.delete(languageId);
          }
        }),
      );
      // A concurrent stopServer (e.g. the editor unmounting during a cold-start
      // handshake) may have removed this session while we were awaiting the
      // listener registrations above. Its `unlistens` was empty when it ran, so
      // nothing got torn down — detect that here and self-clean instead of leaking
      // the listeners AND spawning a server the user already asked to stop.
      if (sessions.get(languageId) !== session) {
        unlistens.forEach((off) => off());
        rpc.dispose("stopped during startup");
        return;
      }
      await lspStart(id, cmd, args, rootPath);
      // Stopped during the start IPC: the server we just spawned would be a zombie
      // (stop's lspStop ran before it existed). Kill it — but only if no newer
      // session now owns this language id, since a replacement's lspStart already
      // superseded ours in the Rust manager.
      if (sessions.get(languageId) !== session) {
        unlistens.forEach((off) => off());
        rpc.dispose("stopped during startup");
        if (!sessions.has(languageId)) void lspStop(id);
        return;
      }
      const initResult = await rpc.request<{
        capabilities?: Record<string, unknown>;
      }>("initialize", buildInitializeParams(rootPath));
      session.capabilities = initResult?.capabilities ?? {};
      rpc.notify("initialized", {});
      useLspStatusStore.getState().setStatus(languageId, "ready");
    } catch (e) {
      // Start/initialize failed (e.g. server binary missing OR a started server
      // that never answers initialize within the cap): tear everything down and
      // un-cache so a later open retries cleanly instead of reusing a dead session.
      useLspStatusStore.getState().setStatus(languageId, "error");
      unlistens.forEach((off) => off());
      rpc.dispose("lsp init failed");
      if (sessions.get(languageId) === session) {
        sessions.delete(languageId);
      }
      void lspStop(id);
      throw e instanceof Error ? e : new Error(String(e));
    }
  })();
  session.ready = ready;
  // Defensive: ensure the ready rejection is never an unhandled rejection even
  // if no caller awaits it (didOpen/didChange await it in try/catch).
  void ready.catch(() => {});
  return session;
}

export async function didOpen(
  session: LspSession,
  uri: string,
  languageId: string,
  text: string,
): Promise<void> {
  try {
    await session.ready;
  } catch {
    return;
  }
  if (session.openDocs.has(uri)) return;
  session.openDocs.add(uri);
  session.rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId, version: 1, text },
  });
}

export async function didChange(
  session: LspSession,
  uri: string,
  version: number,
  text: string,
): Promise<void> {
  try {
    await session.ready;
  } catch {
    return;
  }
  // Only send a change for a doc the server was told is open. Without this, a
  // debounced flush that lost a race with didClose (tab closed mid-debounce)
  // would send didChange AFTER didClose, and a change that resumed before its
  // didOpen would send didChange BEFORE didOpen — both LSP protocol violations.
  // Dropping it is safe: each didChange carries the full text, so the next one
  // after a (re)didOpen is complete.
  if (!session.openDocs.has(uri)) return;
  session.rpc.notify("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

/** Notify the server a document closed and stop tracking it (bounds openDocs). */
export async function didClose(session: LspSession, uri: string): Promise<void> {
  try {
    await session.ready;
  } catch {
    return;
  }
  if (!session.openDocs.delete(uri)) return;
  session.rpc.notify("textDocument/didClose", { textDocument: { uri } });
}

/** Stop and dispose a language server (used for shutdown/restart). Attempts the
 * LSP shutdown/exit handshake so the server can clean up, then force-kills. */
export async function stopServer(languageId: string): Promise<void> {
  const session = sessions.get(languageId);
  if (!session) return;
  // Drop from the registry first so a late exit event can't act on it and a
  // concurrent ensureServer starts a fresh instance under a new id.
  sessions.delete(languageId);
  useLspStatusStore.getState().setStatus(languageId, "off");

  // Best-effort graceful shutdown per the spec (shutdown request, then exit
  // notification) before the force-kill. The message listener stays attached
  // across the round-trip so the shutdown response can be routed.
  try {
    await withTimeout(session.rpc.request("shutdown"), 1500);
    session.rpc.notify("exit");
    await delay(150);
  } catch {
    // Server unready or unresponsive — fall through to the force-kill below.
  }

  session.unlistens.forEach((off) => off());
  session.rpc.dispose("stopped");
  await lspStop(session.id);
}
