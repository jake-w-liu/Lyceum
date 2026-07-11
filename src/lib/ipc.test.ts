import { beforeEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";

const invokeMock = vi.fn();
const openMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import {
  createDirectory,
  createFile,
  getAppInfo,
  movePaths,
  pickFolder,
  quitApp,
  readDirectory,
  readFileBytes,
  renamePath,
} from "./ipc";
import { useWorkspaceStore } from "../state/workspaceStore";

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
  useWorkspaceStore.getState().closeWorkspace();
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
      version: packageMetadata.version,
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

describe("readDirectory", () => {
  it("passes the workspace root so only root-internal trash is hidden", async () => {
    useWorkspaceStore.getState().openWorkspace("/workspace");
    invokeMock
      .mockResolvedValueOnce("/workspace")
      .mockResolvedValueOnce([{ name: ".lyceum-trash" }]);

    await expect(readDirectory("/workspace/subdirectory")).resolves.toEqual([
      { name: ".lyceum-trash" },
    ]);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "authorize_workspace_root", {
      root: "/workspace",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_directory", {
      root: "/workspace",
      path: "/workspace/subdirectory",
    });
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

  it("adds the replace flag only for an explicit overwrite retry", async () => {
    invokeMock.mockResolvedValue([]);

    await movePaths("/w", ["/w/a.txt"], "/w/src", true, ["/w/src/a.txt"]);

    expect(invokeMock).toHaveBeenCalledWith("move_paths", {
      root: "/w",
      paths: ["/w/a.txt"],
      destinationDir: "/w/src",
      replaceExisting: true,
      expectedConflictPaths: ["/w/src/a.txt"],
    });
  });
});

describe("root-scoped Explorer mutations", () => {
  it("passes the workspace root for create and rename validation", async () => {
    invokeMock.mockResolvedValue(undefined);

    await createFile("/w", "/w/note.txt");
    await createDirectory("/w", "/w/folder");
    await renamePath("/w", "/w/note.txt", "/w/renamed.txt");

    expect(invokeMock).toHaveBeenNthCalledWith(2, "create_file", {
      root: "/w",
      path: "/w/note.txt",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "create_directory", {
      root: "/w",
      path: "/w/folder",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "rename_path", {
      root: "/w",
      from: "/w/note.txt",
      to: "/w/renamed.txt",
    });
  });
});
