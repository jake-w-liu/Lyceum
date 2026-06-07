import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeFolders, initialGitData, parentOf, useGitStore } from "./gitStore";
import type { GitFileStatus } from "../lib/ipc";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "./workspaceStore";

const gitStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", () => ({
  gitStatus: (...args: unknown[]) => gitStatusMock(...args),
}));

beforeEach(() => {
  useGitStore.setState(initialGitData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
  gitStatusMock.mockReset();
});

describe("parentOf", () => {
  it("returns the parent directory for nested unix paths", () => {
    expect(parentOf("/a/b/c.txt")).toBe("/a/b");
    expect(parentOf("/a/b")).toBe("/a");
  });

  it("walks up to the filesystem root and then stops", () => {
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/")).toBe("");
    expect(parentOf("relative")).toBe("");
  });

  it("handles Windows separators", () => {
    expect(parentOf("C:\\a\\b.txt")).toBe("C:\\a");
  });
});

describe("computeFolders", () => {
  it("rolls a modified file up to every ancestor directory", () => {
    const files: Record<string, GitFileStatus> = { "/repo/src/a.ts": "modified" };
    expect(computeFolders(files)).toEqual({
      "/repo/src": "modified",
      "/repo": "modified",
      "/": "modified",
    });
  });

  it("marks ancestors of an untracked-only file green", () => {
    const files: Record<string, GitFileStatus> = { "/repo/src/new.ts": "untracked" };
    const folders = computeFolders(files);
    expect(folders["/repo/src"]).toBe("untracked");
    expect(folders["/repo"]).toBe("untracked");
  });

  it("lets modified win over untracked when a folder contains both", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/src/changed.ts": "modified",
      "/repo/src/new.ts": "untracked",
    };
    expect(computeFolders(files)["/repo/src"]).toBe("modified");
  });

  it("treats deleted/renamed/conflict as tracked changes (orange) for folders", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/a/x": "deleted",
      "/repo/b/y": "renamed",
      "/repo/c/z": "conflict",
    };
    const folders = computeFolders(files);
    expect(folders["/repo/a"]).toBe("modified");
    expect(folders["/repo/b"]).toBe("modified");
    expect(folders["/repo/c"]).toBe("modified");
  });

  it("ignores 'ignored' entries entirely", () => {
    const files: Record<string, GitFileStatus> = { "/repo/build/out.js": "ignored" };
    expect(computeFolders(files)).toEqual({});
  });
});

describe("gitStore", () => {
  it("ignores stale git status responses after the workspace changes", async () => {
    let resolveOld!: (value: {
      isRepo: boolean;
      files: Record<string, GitFileStatus>;
    }) => void;
    let resolveNew!: (value: {
      isRepo: boolean;
      files: Record<string, GitFileStatus>;
    }) => void;
    gitStatusMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );

    useWorkspaceStore.getState().openWorkspace("/old");
    const oldRefresh = useGitStore.getState().refresh();
    useWorkspaceStore.getState().openWorkspace("/new");
    const newRefresh = useGitStore.getState().refresh();

    resolveNew({ isRepo: true, files: { "/new/a.ts": "modified" } });
    await newRefresh;
    expect(useGitStore.getState().files).toEqual({
      "/new/a.ts": "modified",
    });

    resolveOld({ isRepo: true, files: { "/old/stale.ts": "deleted" } });
    await oldRefresh;

    expect(useGitStore.getState().files).toEqual({
      "/new/a.ts": "modified",
    });
  });
});
