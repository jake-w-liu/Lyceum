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
import { authorizeWorkspaceRoot } from "../lib/ipc";

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
  /** True when this session was spawned by the automatic crash-restart below.
   * A restarted session that dies again is NOT restarted (no crash loop). */
  restarted: boolean;
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

/**
 * Provider for the currently-open documents of a language, set by the Monaco
 * integration (decouples client<->monaco). Used when a session (re)starts so
 * already-open models are didOpen-ed: without it their didChanges are dropped
 * (openDocs gate) while hover/completion query a doc the server never saw.
 */
export interface OpenLspDoc {
  uri: string;
  languageId: string;
  text: string;
}
let openDocsProvider: ((languageId: string) => OpenLspDoc[]) | null = null;
export function setOpenDocsProvider(
  fn: (languageId: string) => OpenLspDoc[],
): void {
  openDocsProvider = fn;
}

/** Delay before the single automatic restart after an unexpected server exit. */
const RESTART_DELAY_MS = 1000;

export function getSession(languageId: string): LspSession | undefined {
  return sessions.get(languageId);
}

/** Start (or reuse) the language server for a language. Returns null if none configured. */
export async function ensureServer(
  languageId: string,
  rootPath: string | null,
  juliaPath: string | null,
  options?: { isRestart?: boolean },
): Promise<LspSession | null> {
  const existing = sessions.get(languageId);
  if (existing) return existing;
  const config = serverForLanguage(languageId);
  if (!config) return null;

  const id = `lsp-${languageId}-${(lspInstanceSeq += 1)}`;
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
    restarted: options?.isRestart === true,
  };
  sessions.set(languageId, session);

  const ready = (async () => {
    try {
      unlistens.push(await onLspMessage(id, (raw) => rpc.handleMessage(raw)));
      unlistens.push(
        await onLspExit(id, () => {
          rpc.dispose("server exited");
          // Detach this session's webview listeners (lsp:message:<id>/lsp:exit:<id>).
          // The id is never reused, so without this they leak for the window's
          // lifetime on every crash — matching the detach the other teardown
          // paths already do. Safe before the ownership check: a disposed
          // session's listeners are dead regardless of who owns the language now.
          unlistens.forEach((off) => off());
          // Only an UNEXPECTED exit still owns the registry entry: stopServer
          // removes the session before killing, so this branch means a crash.
          if (sessions.get(languageId) !== session) return;
          // Set "off" only when this session STILL owns the language. A stale
          // exit (an old session dying after a newer same-language session became
          // ready) must not clobber the live server's "ready" status back to off.
          useLspStatusStore.getState().setStatus(languageId, "off");
          sessions.delete(languageId);
          // Attempt ONE automatic restart so a crashed server recovers without
          // requiring a new file of that language to be opened. A session that
          // was itself the restart is never restarted again (no crash loop).
          if (session.restarted) return;
          setTimeout(() => {
            if (sessions.has(languageId)) return; // already restarted elsewhere
            // Nothing of this language open anymore (e.g. editor unmounted and
            // stopped the servers): a restart would leak a headless server.
            if ((openDocsProvider?.(languageId) ?? []).length === 0) return;
            void ensureServer(languageId, rootPath, juliaPath, {
              isRestart: true,
            }).catch(() => {});
          }, RESTART_DELAY_MS);
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
      if (rootPath) await authorizeWorkspaceRoot(rootPath);
      await lspStart(id, config.id, rootPath, juliaPath);
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
      // A concurrent stopServer during the (possibly slow) initialize round-trip
      // may have removed and killed this session while the live server still
      // answered initialize over the same pipe. Re-check ownership before
      // mutating session/global state — otherwise we'd set status "ready" for a
      // language with no running server (stuck-ready desync). Mirrors the
      // post-lspStart guard above.
      if (sessions.get(languageId) !== session) {
        unlistens.forEach((off) => off());
        rpc.dispose("stopped during startup");
        if (!sessions.has(languageId)) void lspStop(id);
        return;
      }
      session.capabilities = initResult?.capabilities ?? {};
      rpc.notify("initialized", {});
      useLspStatusStore.getState().setStatus(languageId, "ready");
      // Tell the fresh server about every already-open document of this
      // language. Models created AFTER the session didOpen themselves, but a
      // session started when models already exist (a crash restart, or a slow
      // first start racing multiple opens) must sync them here. `void`: didOpen
      // awaits session.ready (this function), so it proceeds right after the
      // handshake settles; awaiting it here would deadlock.
      for (const doc of openDocsProvider?.(languageId) ?? []) {
        void didOpen(session, doc.uri, doc.languageId, doc.text);
      }
    } catch (e) {
      // Start/initialize failed (e.g. server binary missing OR a started server
      // that never answers initialize within the cap): tear everything down and
      // un-cache so a later open retries cleanly instead of reusing a dead session.
      unlistens.forEach((off) => off());
      rpc.dispose("lsp init failed");
      // Only downgrade to "error" / un-cache when this session STILL owns the
      // language — a concurrent stopServer (which already set "off" and disposed
      // the rpc, rejecting this initialize) must not be clobbered back to "error".
      if (sessions.get(languageId) === session) {
        useLspStatusStore.getState().setStatus(languageId, "error");
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
