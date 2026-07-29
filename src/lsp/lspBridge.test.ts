import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
let messageHandler: ((event: { payload: string }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../lib/windowEvents", () => ({
  listenScoped: vi.fn(
    async (_event: string, handler: (event: { payload: string }) => void) => {
      messageHandler = handler;
      return () => {};
    },
  ),
}));

import { lspSend, onLspMessage } from "./lspBridge";

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  messageHandler = null;
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lspBridge output flow control", () => {
  it("acknowledges a message after delivering it to JSON-RPC", async () => {
    const callback = vi.fn();
    await onLspMessage("lsp-typescript-1", callback);

    messageHandler?.({ payload: '{"jsonrpc":"2.0"}' });

    expect(callback).toHaveBeenCalledWith('{"jsonrpc":"2.0"}');
    expect(invokeMock).toHaveBeenCalledWith("lsp_ack_output", {
      id: "lsp-typescript-1",
      count: 1,
    });
  });

  it("still acknowledges malformed input when the consumer throws", async () => {
    await onLspMessage("lsp-rust-2", () => {
      throw new Error("bad JSON");
    });

    expect(() => messageHandler?.({ payload: "{" })).toThrow("bad JSON");
    expect(invokeMock).toHaveBeenCalledWith("lsp_ack_output", {
      id: "lsp-rust-2",
      count: 1,
    });
  });
});

describe("lspSend", () => {
  it("stops a server whose bounded input queue is full", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "lsp_send"
        ? Promise.reject("lsp server input queue full")
        : Promise.resolve(),
    );

    await lspSend("server-1", "{}");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "lsp_send", {
      id: "server-1",
      message: "{}",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "lsp_stop", {
      id: "server-1",
    });
  });

  it("does not stop a server for an ordinary late-send rejection", async () => {
    invokeMock.mockRejectedValue("no such lsp server");

    await lspSend("server-2", "{}");

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
