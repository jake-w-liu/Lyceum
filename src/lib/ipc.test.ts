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
  deleteFileIfExists,
  getAppInfo,
  movePaths,
  pickFolder,
  readFileBytes,
  resolveLatexTools,
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
      version: "0.1.3",
      os: "web",
      arch: "unknown",
    });
  });
});

describe("pickFolder", () => {
  it("returns the chosen path", async () => {
    openMock.mockResolvedValue("/chosen");
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

describe("deleteFileIfExists", () => {
  it("invokes the file-only delete command and returns whether a file was removed", async () => {
    invokeMock.mockResolvedValue(true);

    await expect(deleteFileIfExists("/w/main.pdf")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("delete_file_if_exists", {
      path: "/w/main.pdf",
    });
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

describe("resolveLatexTools", () => {
  it("invokes the LaTeX tool inventory command", async () => {
    const tools = [
      { tool: "tectonic", path: "/usr/local/bin/tectonic", source: "path" },
    ];
    invokeMock.mockResolvedValue(tools);

    await expect(resolveLatexTools()).resolves.toEqual(tools);

    expect(invokeMock).toHaveBeenCalledWith("resolve_latex_tools");
  });
});
