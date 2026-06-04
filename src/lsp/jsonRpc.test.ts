// Tests for the transport-agnostic JSON-RPC 2.0 client.

import { describe, expect, it, vi } from "vitest";
import { createRpcClient, type JsonRpcTransport } from "./jsonRpc";

function makeTransport(): { transport: JsonRpcTransport; sent: string[] } {
  const sent: string[] = [];
  const transport: JsonRpcTransport = {
    send: (message) => {
      sent.push(message);
    },
  };
  return { transport, sent };
}

describe("createRpcClient", () => {
  it("request sends correct JSON shape and increments id", () => {
    const { transport, sent } = makeTransport();
    const client = createRpcClient(transport);

    // Capture + swallow rejections so dispose() (below) doesn't surface them.
    client.request("initialize", { rootUri: "file:///x" }).catch(() => {});
    client.request("shutdown").catch(() => {});

    expect(JSON.parse(sent[0])).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { rootUri: "file:///x" },
    });
    expect(JSON.parse(sent[1])).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "shutdown",
    });
    client.dispose(); // clear the request-timeout timer
  });

  it("resolves a pending request when a matching response is fed", async () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    const promise = client.request<{ ok: boolean }>("ping");
    client.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects when a response carries an error", async () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    const promise = client.request("boom");
    const rejects = expect(promise).rejects.toThrow("bad request");
    client.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "bad request" },
      }),
    );

    await rejects;
  });

  it("notify sends a message with no id", () => {
    const { transport, sent } = makeTransport();
    const client = createRpcClient(transport);

    client.notify("textDocument/didOpen", { uri: "file:///a" });

    const parsed = JSON.parse(sent[0]);
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { uri: "file:///a" },
    });
    expect("id" in parsed).toBe(false);
  });

  it("dispatches notifications to registered handlers", () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    const handler = vi.fn();
    client.onNotification("textDocument/publishDiagnostics", handler);
    client.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { diagnostics: [] },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ diagnostics: [] });
  });

  it("ignores a response with an unknown id", () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    expect(() =>
      client.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 999, result: 1 }),
      ),
    ).not.toThrow();
  });

  it("ignores malformed JSON without throwing", () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    expect(() => client.handleMessage("not json {")).not.toThrow();
  });

  it("dispose rejects pending requests", async () => {
    const { transport } = makeTransport();
    const client = createRpcClient(transport);

    const promise = client.request("hang");
    const rejects = expect(promise).rejects.toThrow("client closed");
    client.dispose("client closed");

    await rejects;
  });

  it("answers server-to-client requests (id + method) so the server can't hang", () => {
    const { transport, sent } = makeTransport();
    const client = createRpcClient(transport);

    client.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "client/registerCapability",
        params: {},
      }),
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: null,
    });
  });

  it("times out a non-initialize request at 60s and initialize at the longer cap", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = makeTransport();
      const client = createRpcClient(transport);

      const hover = client.request("textDocument/hover");
      // Attach the rejection handlers BEFORE the timers fire (no unhandled rejection).
      const hoverRejects = expect(hover).rejects.toThrow(/timed out/);
      const init = client.request("initialize");
      const initRejects = expect(init).rejects.toThrow(/timed out/);
      let initDone = false;
      init.then(
        () => {
          initDone = true;
        },
        () => {
          initDone = true;
        },
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await hoverRejects;
      // initialize is NOT exempt, but gets a long grace period (cold servers):
      // still pending after the 60s mark.
      await Promise.resolve();
      expect(initDone).toBe(false);

      // ...and DOES reject once the larger cap (300s total) elapses.
      await vi.advanceTimersByTimeAsync(240_000);
      await initRejects;
      expect(initDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
