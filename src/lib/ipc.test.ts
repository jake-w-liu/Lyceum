import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const openMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import {
  getAppInfo,
  movePaths,
  pickFolder,
  quitApp,
  readFileBytes,
} from "./ipc";

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
});

describe("getAppInfo", () => {
  it("returns the backend value when available", async () => {
    const info = { name: "lyceum", version: "9.9.9", os: "x", arch: "y" };
    invokeMock.mockResolvedValue(info);
    expect(await getAppInfo()).toEqual(info);
  });
  it("falls back when invoke fails (outside Tauri)", async () => {
    invokeMock.mockRejectedValue(new Error("no tauri"));
    expect(await getAppInfo()).toEqual({
      name: "lyceum",
      version: "0.2.0",
      os: "web",
      arch: "unknown",
    });
  });
});

describe("pickFolder", () => {
  it("returns the chosen path (canonicalized by workspace authorization)", async () => {
    openMock.mockResolvedValue("/tmp/chosen");
    // pickFolder canonicalizes while authorizing the chosen workspace root so
    // the app keys off one symlink-free root without a separate broad IPC.
    invokeMock.mockResolvedValue("/private/tmp/chosen");
    expect(await pickFolder()).toBe("/private/tmp/chosen");
    expect(invokeMock).toHaveBeenCalledWith("authorize_workspace_root", {
      root: "/tmp/chosen",
    });
  });
  it("falls back to the chosen path when backend authorization is unavailable", async () => {
    openMock.mockResolvedValue("/chosen");
    // invokeMock returns undefined (reset default) → fall back to the input.
    expect(await pickFolder()).toBe("/chosen");
  });
  it("returns null on cancel, array, or error", async () => {
    openMock.mockResolvedValue(null);
    expect(await pickFolder()).toBeNull();
    openMock.mockResolvedValue(["/a", "/b"]);
    expect(await pickFolder()).toBeNull();
    openMock.mockRejectedValue(new Error("x"));
    expect(await pickFolder()).toBeNull();
  });
});

describe("readFileBytes", () => {
  it("wraps the binary ArrayBuffer payload in a Uint8Array", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 255]).buffer);
    const bytes = await readFileBytes("/f");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 255]);
  });
});

describe("quitApp", () => {
  it("invokes the backend quit command", async () => {
    invokeMock.mockResolvedValue(undefined);

    await quitApp();

    expect(invokeMock).toHaveBeenCalledWith("quit_app");
  });
});

describe("movePaths", () => {
  it("invokes the scoped Explorer move command", async () => {
    const moved = [{ from: "/w/a.txt", to: "/w/src/a.txt", isDir: false }];
    invokeMock.mockResolvedValue(moved);

    await expect(movePaths("/w", ["/w/a.txt"], "/w/src")).resolves.toEqual(
      moved,
    );

    expect(invokeMock).toHaveBeenCalledWith("move_paths", {
      root: "/w",
      paths: ["/w/a.txt"],
      destinationDir: "/w/src",
    });
  });
});
