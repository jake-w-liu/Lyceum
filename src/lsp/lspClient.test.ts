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

import { ensureServer, stopServer } from "./lspClient";
import { initialLspStatusData, useLspStatusStore } from "../state/lspStatusStore";

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
});
