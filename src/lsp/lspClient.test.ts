import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lspStartMock = vi.fn();
const lspSendMock = vi.fn();
const lspStopMock = vi.fn();
const onLspMessageMock = vi.fn();
const onLspExitMock = vi.fn();

vi.mock("./lspBridge", () => ({
  lspStart: (...args: unknown[]) => lspStartMock(...args),
  lspSend: (...args: unknown[]) => lspSendMock(...args),
  lspStop: (...args: unknown[]) => lspStopMock(...args),
  onLspMessage: (...args: unknown[]) => onLspMessageMock(...args),
  onLspExit: (...args: unknown[]) => onLspExitMock(...args),
}));

import {
  didChange,
  didClose,
  didOpen,
  ensureServer,
  stopServer,
} from "./lspClient";
import { initialLspStatusData, useLspStatusStore } from "../state/lspStatusStore";

function sentMethods(calls: unknown[][]): string[] {
  return calls.map(([, raw]) => JSON.parse(raw as string).method as string);
}

describe("ensureServer", () => {
  beforeEach(async () => {
    await stopServer("julia");
    lspStartMock.mockReset().mockResolvedValue(undefined);
    lspStopMock.mockReset().mockResolvedValue(undefined);
    onLspExitMock.mockReset().mockResolvedValue(() => {});
    useLspStatusStore.setState(initialLspStatusData, false);
    let onMessage: ((raw: string) => void) | null = null;
    onLspMessageMock.mockReset().mockImplementation(async (_id, cb) => {
      onMessage = cb as (raw: string) => void;
      return () => {};
    });
    lspSendMock.mockReset().mockImplementation(async (_id, raw) => {
      const message = JSON.parse(raw as string);
      if (message.method === "initialize") {
        queueMicrotask(() =>
          onMessage?.(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          ),
        );
      }
    });
  });

  afterEach(async () => {
    await stopServer("julia");
  });

  it("caches a starting session so concurrent opens do not double-start a server", async () => {
    const first = ensureServer("julia", "/w", null);
    const second = ensureServer("julia", "/w", null);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    await a?.ready;

    expect(onLspMessageMock).toHaveBeenCalledTimes(1);
    expect(onLspExitMock).toHaveBeenCalledTimes(1);
    expect(lspStartMock).toHaveBeenCalledTimes(1);
    expect(useLspStatusStore.getState().byLanguage.julia).toBe("ready");
  });

  it("only sends didChange for docs the server was told are open", async () => {
    const session = await ensureServer("julia", "/w", null);
    expect(session).not.toBeNull();
    await session?.ready;
    const uri = "file:///w/a.jl";

    // Before didOpen: a change must be dropped (no didChange-before-didOpen).
    lspSendMock.mockClear();
    await didChange(session!, uri, 2, "v2");
    expect(sentMethods(lspSendMock.mock.calls)).not.toContain(
      "textDocument/didChange",
    );

    // After didOpen: a change is delivered.
    await didOpen(session!, uri, "julia", "v1");
    lspSendMock.mockClear();
    await didChange(session!, uri, 3, "v3");
    expect(sentMethods(lspSendMock.mock.calls)).toContain(
      "textDocument/didChange",
    );

    // After didClose: a late debounced change must be dropped (no after-close).
    await didClose(session!, uri);
    lspSendMock.mockClear();
    await didChange(session!, uri, 4, "v4");
    expect(sentMethods(lspSendMock.mock.calls)).not.toContain(
      "textDocument/didChange",
    );
  });

  it("a stop during the startup handshake neither starts the server nor leaks listeners", async () => {
    const offMessage = vi.fn();
    let releaseMessage: () => void = () => {};
    onLspMessageMock.mockReset().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseMessage = resolve;
      });
      return offMessage;
    });

    const pending = ensureServer("julia", "/w", null);
    // The session is cached and the ready IIFE is parked awaiting onLspMessage —
    // stop it now, while `unlistens` is still empty.
    await stopServer("julia");
    // Allow listener registration to complete; the self-clean path must run.
    releaseMessage();
    const session = await pending;
    await session?.ready;

    expect(lspStartMock).not.toHaveBeenCalled();
    // The listener registered after the stop must have been torn down.
    expect(offMessage).toHaveBeenCalledTimes(1);
  });
});
