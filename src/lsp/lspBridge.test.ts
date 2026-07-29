import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../lib/windowEvents", () => ({
  listenScoped: vi.fn(),
}));

import { lspSend } from "./lspBridge";

beforeEach(() => {
  invokeMock.mockReset();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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
