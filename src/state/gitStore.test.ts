import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeFolderDecorations,
  computeFolders,
  gitScopeForEntry,
  gitStatusForEntry,
  initialGitData,
  parentOf,
  useGitStore,
  type GitData,
} from "./gitStore";
import type { GitFileStatus, GitStatus } from "../lib/ipc";
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

  it("walks through Windows drive roots and then stops", () => {
    expect(parentOf("C:\\file.txt")).toBe("C:\\");
    expect(parentOf("C:\\")).toBe("");
    expect(parentOf("C:/file.txt")).toBe("C:/");
    expect(parentOf("C:/")).toBe("");
  });

  it("stops traversal at a UNC share root", () => {
    expect(parentOf("\\\\server\\share\\file.txt")).toBe(
      "\\\\server\\share",
    );
    expect(parentOf("\\\\server\\share")).toBe("");
    expect(parentOf("\\\\server\\share\\")).toBe("");
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

  it("rolls UNC changes up to the share root without inventing a server folder", () => {
    const folders = computeFolders({
      "\\\\server\\share\\src\\file.ts": "modified",
    });
    expect(folders).toEqual({
      "\\\\server\\share\\src": "modified",
      "\\\\server\\share": "modified",
    });
    expect(folders["\\\\server"]).toBeUndefined();
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

  it("does not roll ignored-only files up to ancestor directories", () => {
    const files: Record<string, GitFileStatus> = { "/repo/build/out.js": "ignored" };
    const folders = computeFolders(files);
    expect(folders["/repo/build"]).toBeUndefined();
    expect(folders["/repo"]).toBeUndefined();
  });

  it("lets untracked and modified statuses win over ignored files", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/build/cache.tmp": "ignored",
      "/repo/build/new.ts": "untracked",
      "/repo/src/cache.tmp": "ignored",
      "/repo/src/changed.ts": "modified",
    };
    const folders = computeFolders(files);
    expect(folders["/repo/build"]).toBe("untracked");
    expect(folders["/repo/src"]).toBe("modified");
  });

  it("rolls nested repository scope up to ancestor folders", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/pkg/src/a.ts": "modified",
    };
    const folders = computeFolderDecorations(files, {
      "/repo/pkg/src/a.ts": "nested",
    });

    expect(folders.statuses["/repo/pkg"]).toBe("modified");
    expect(folders.scopes["/repo/pkg"]).toBe("nested");
    expect(folders.scopes["/repo"]).toBe("nested");
  });

  it("lets workspace scope win when a folder contains workspace and nested changes", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/main.ts": "modified",
      "/repo/pkg/src/a.ts": "modified",
    };
    const folders = computeFolderDecorations(files, {
      "/repo/main.ts": "workspace",
      "/repo/pkg/src/a.ts": "nested",
    });

    expect(folders.scopes["/repo/pkg"]).toBe("nested");
    expect(folders.scopes["/repo"]).toBe("workspace");
  });

  it("does not roll nested repository ignored files up with nested scope", () => {
    const files: Record<string, GitFileStatus> = {
      "/repo/pkg/dist/out.js": "ignored",
    };
    const folders = computeFolderDecorations(files, {
      "/repo/pkg/dist/out.js": "nested",
    });

    expect(folders.statuses["/repo/pkg/dist"]).toBeUndefined();
    expect(folders.scopes["/repo/pkg/dist"]).toBeUndefined();
    expect(folders.scopes["/repo/pkg"]).toBeUndefined();
  });

  it("decorates ignored directories and their visible children from the direct ignored folder", () => {
    const data: GitData = {
      ...initialGitData,
      files: {
        "/repo/pkg/dist": "ignored",
      },
      fileScopes: {
        "/repo/pkg/dist": "nested",
      },
    };

    expect(gitStatusForEntry(data, "/repo/pkg", true)).toBeNull();
    expect(gitStatusForEntry(data, "/repo/pkg/dist", true)).toBe("ignored");
    expect(gitScopeForEntry(data, "/repo/pkg/dist", true)).toBe("nested");
    expect(gitStatusForEntry(data, "/repo/pkg/dist/out.js", false)).toBe(
      "ignored",
    );
    expect(gitScopeForEntry(data, "/repo/pkg/dist/out.js", false)).toBe(
      "nested",
    );
  });

  it("lets nested folder changes beat a direct ignored folder decoration", () => {
    const data: GitData = {
      ...initialGitData,
      files: {
        "/repo/pkg": "ignored",
        "/repo/pkg/src/a.ts": "modified",
      },
      fileScopes: {
        "/repo/pkg": "workspace",
        "/repo/pkg/src/a.ts": "nested",
      },
      folders: {
        "/repo/pkg/src": "modified",
        "/repo/pkg": "modified",
        "/repo": "modified",
      },
      folderScopes: {
        "/repo/pkg/src": "nested",
        "/repo/pkg": "nested",
        "/repo": "nested",
      },
    };

    expect(gitStatusForEntry(data, "/repo/pkg", true)).toBe("modified");
    expect(gitScopeForEntry(data, "/repo/pkg", true)).toBe("nested");
  });
});

describe("gitStore", () => {
  it("ignores stale git status responses after the workspace changes", async () => {
    let resolveOld!: (value: GitStatus) => void;
    let resolveNew!: (value: GitStatus) => void;
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

    resolveNew({
      isRepo: true,
      rootRepo: "/new",
      repoRoots: ["/new"],
      files: { "/new/a.ts": "modified" },
      fileRepos: { "/new/a.ts": "/new" },
    });
    await newRefresh;
    expect(useGitStore.getState().files).toEqual({
      "/new/a.ts": "modified",
    });
    expect(useGitStore.getState().fileScopes).toEqual({
      "/new/a.ts": "workspace",
    });

    resolveOld({ isRepo: true, files: { "/old/stale.ts": "deleted" } });
    await oldRefresh;

    expect(useGitStore.getState().files).toEqual({
      "/new/a.ts": "modified",
    });
  });

  it("ignores out-of-order responses within the SAME root (staleness guard)", async () => {
    let resolveFirst!: (value: GitStatus) => void;
    let resolveSecond!: (value: GitStatus) => void;
    gitStatusMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    useWorkspaceStore.getState().openWorkspace("/repo");
    const first = useGitStore.getState().refresh();
    const second = useGitStore.getState().refresh();

    // The NEWER request resolves first; the older one must not clobber it.
    resolveSecond({ isRepo: true, files: { "/repo/new.ts": "modified" } });
    await second;
    resolveFirst({ isRepo: true, files: { "/repo/stale.ts": "deleted" } });
    await first;

    expect(useGitStore.getState().files).toEqual({
      "/repo/new.ts": "modified",
    });
  });

  it("marks files owned by nested repositories with nested scope", async () => {
    gitStatusMock.mockResolvedValue({
      isRepo: true,
      rootRepo: "/repo",
      repoRoots: ["/repo", "/repo/pkg"],
      files: {
        "/repo/main.ts": "modified",
        "/repo/pkg/src/a.ts": "modified",
      },
      fileRepos: {
        "/repo/main.ts": "/repo",
        "/repo/pkg/src/a.ts": "/repo/pkg",
      },
    });

    useWorkspaceStore.getState().openWorkspace("/repo");
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().fileScopes).toEqual({
      "/repo/main.ts": "workspace",
      "/repo/pkg/src/a.ts": "nested",
    });
    expect(useGitStore.getState().folderScopes["/repo/pkg"]).toBe("nested");
    expect(useGitStore.getState().folderScopes["/repo"]).toBe("workspace");
  });

  it("keeps ignored files and marks their nested repository scope", async () => {
    gitStatusMock.mockResolvedValue({
      isRepo: true,
      rootRepo: "/repo",
      repoRoots: ["/repo", "/repo/pkg"],
      files: {
        "/repo/pkg/dist/out.js": "ignored",
      },
      fileRepos: {
        "/repo/pkg/dist/out.js": "/repo/pkg",
      },
    });

    useWorkspaceStore.getState().openWorkspace("/repo");
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().files).toEqual({
      "/repo/pkg/dist/out.js": "ignored",
    });
    expect(useGitStore.getState().fileScopes).toEqual({
      "/repo/pkg/dist/out.js": "nested",
    });
    expect(useGitStore.getState().folders["/repo/pkg/dist"]).toBeUndefined();
    expect(useGitStore.getState().folderScopes["/repo/pkg/dist"]).toBeUndefined();
  });
});
