import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Explorer } from "./Explorer";
import { ContextMenu } from "./ContextMenu";
import type { DirEntry } from "../lib/ipc";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialGitData, useGitStore } from "../state/gitStore";
import {
  initialContextMenuData,
  useContextMenuStore,
} from "../state/contextMenuStore";

const webviewMocks = vi.hoisted(() => {
  const onDragDropEvent = vi.fn(async () => vi.fn());
  const scaleFactor = vi.fn(async () => 1);
  return {
    getCurrentWebview: vi.fn(() => ({
      onDragDropEvent,
    })),
    onDragDropEvent,
    getCurrentWindow: vi.fn(() => ({
      scaleFactor,
    })),
    scaleFactor,
  };
});

// Native confirm/alert dialogs (Tauri plugin). `ask` defaults to confirming.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: webviewMocks.getCurrentWebview,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: webviewMocks.getCurrentWindow,
}));

vi.mock("../lib/ipc", () => ({
  readDirectory: vi.fn(),
  createFile: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  copyPaths: vi.fn(async () => []),
  movePaths: vi.fn(async () => []),
  movePathsToTrash: vi.fn(async () => ({
    id: "batch-1",
    items: [
      {
        originalPath: "/ws/README.md",
        trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
        isDir: false,
      },
    ],
  })),
  restoreTrashBatch: vi.fn(async () => {}),
  redoTrashBatch: vi.fn(async () => {}),
  gitStatus: vi.fn(async () => ({ isRepo: false, files: {} })),
  nativeWindowContentInset: vi.fn(async () => ({ x: 0, y: 0 })),
}));
import {
  createDirectory,
  createFile,
  movePathsToTrash,
  copyPaths,
  movePaths,
  nativeWindowContentInset,
  readDirectory,
  redoTrashBatch,
  gitStatus,
  renamePath,
  restoreTrashBatch,
} from "../lib/ipc";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

const ROOT = "/ws";
const dir = (name: string, parent = ROOT): DirEntry => ({
  name,
  path: `${parent}/${name}`,
  isDir: true,
});
const file = (name: string, parent = ROOT): DirEntry => ({
  name,
  path: `${parent}/${name}`,
  isDir: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createDataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
    getData: vi.fn((type: string) => data.get(type) ?? ""),
  };
}

type NativeDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

type NativeDropHandler = (event: { payload: NativeDropPayload }) => void;

function mockElementFromPoint(element: Element | null) {
  const original = document.elementFromPoint;
  const elementFromPoint = vi.fn(() => element);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: elementFromPoint,
  });
  return {
    elementFromPoint,
    restore: () => {
      if (original) {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: original,
        });
      } else {
        delete (document as unknown as { elementFromPoint?: unknown })
          .elementFromPoint;
      }
    },
  };
}

beforeEach(() => {
  useTreeStore.setState(initialTreeData, false);
  useEditorStore.setState(initialEditorData, false);
  useGitStore.setState(initialGitData, false);
  useContextMenuStore.setState(initialContextMenuData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
  webviewMocks.onDragDropEvent.mockReset();
  webviewMocks.onDragDropEvent.mockResolvedValue(vi.fn());
  webviewMocks.scaleFactor.mockReset();
  webviewMocks.scaleFactor.mockResolvedValue(1);
  webviewMocks.getCurrentWindow.mockReset();
  webviewMocks.getCurrentWindow.mockReturnValue({
    scaleFactor: webviewMocks.scaleFactor,
  });
  webviewMocks.getCurrentWebview.mockReset();
  webviewMocks.getCurrentWebview.mockReturnValue({
    onDragDropEvent: webviewMocks.onDragDropEvent,
  });
  vi.mocked(readDirectory).mockReset();
  vi.mocked(nativeWindowContentInset).mockReset();
  vi.mocked(nativeWindowContentInset).mockResolvedValue({ x: 0, y: 0 });
  vi.mocked(readDirectory).mockImplementation(async (p: string) => {
    if (p === ROOT) return [dir("src"), file("README.md")];
    if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
    return [];
  });
  vi.mocked(createFile).mockClear();
  vi.mocked(createDirectory).mockClear();
  vi.mocked(renamePath).mockClear();
  vi.mocked(copyPaths).mockReset();
  vi.mocked(copyPaths).mockResolvedValue([]);
  vi.mocked(movePaths).mockReset();
  vi.mocked(movePaths).mockResolvedValue([]);
  vi.mocked(movePathsToTrash).mockReset();
  vi.mocked(movePathsToTrash).mockResolvedValue({
    id: "batch-1",
    items: [
      {
        originalPath: "/ws/README.md",
        trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
        isDir: false,
      },
    ],
  });
  vi.mocked(restoreTrashBatch).mockClear();
  vi.mocked(redoTrashBatch).mockClear();
  vi.mocked(gitStatus).mockReset();
  vi.mocked(gitStatus).mockResolvedValue({ isRepo: false, files: {} });
  vi.mocked(ask).mockClear();
  vi.mocked(ask).mockResolvedValue(true);
  vi.mocked(message).mockClear();
});

describe("Explorer", () => {
  it("renders the root entries", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("marks nested-repo git decorations with a distinct scope class", async () => {
    useWorkspaceStore.getState().openWorkspace(ROOT);
    vi.mocked(gitStatus).mockResolvedValue({
      isRepo: true,
      rootRepo: ROOT,
      repoRoots: [ROOT, "/ws/src"],
      files: { "/ws/src/main.tsx": "modified" },
      fileRepos: { "/ws/src/main.tsx": "/ws/src" },
    });

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    const srcLabel = await screen.findByText("src");
    await waitFor(() =>
      expect(srcLabel).toHaveClass("git-modified", "git-scope-nested"),
    );
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
        "title",
        "src — Nested repo Modified",
      ),
    );
  });

  it("renders ignored git entries as muted rows without badges", async () => {
    useWorkspaceStore.getState().openWorkspace(ROOT);
    vi.mocked(gitStatus).mockResolvedValue({
      isRepo: true,
      rootRepo: ROOT,
      repoRoots: [ROOT],
      files: {
        "/ws/README.md": "ignored",
        "/ws/src": "ignored",
      },
      fileRepos: {
        "/ws/README.md": ROOT,
        "/ws/src": ROOT,
      },
    });

    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    const readmeLabel = await screen.findByText("README.md");
    const srcLabel = await screen.findByText("src");

    await waitFor(() => expect(readmeLabel).toHaveClass("git-ignored"));
    expect(readmeLabel.closest(".tree-row")).toHaveClass("git-ignored");
    expect(srcLabel).toHaveClass("git-ignored");
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute(
      "title",
      "README.md — Ignored",
    );
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }));
    const childLabel = await screen.findByText("main.tsx");
    expect(childLabel).toHaveClass("git-ignored");
    expect(container.querySelector(".git-badge")).toBeNull();
  });

  it("does not mute parent folders that only contain ignored entries", async () => {
    useWorkspaceStore.getState().openWorkspace(ROOT);
    vi.mocked(gitStatus).mockResolvedValue({
      isRepo: true,
      rootRepo: ROOT,
      repoRoots: [ROOT],
      files: {
        "/ws/src/main.tsx": "ignored",
      },
      fileRepos: {
        "/ws/src/main.tsx": ROOT,
      },
    });

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    const srcLabel = await screen.findByText("src");

    await waitFor(() => expect(srcLabel).not.toHaveClass("git-ignored"));
    expect(srcLabel.closest(".tree-row")).not.toHaveClass("git-ignored");

    await userEvent.click(screen.getByRole("treeitem", { name: "src" }));
    const childLabel = await screen.findByText("main.tsx");
    await waitFor(() => expect(childLabel).toHaveClass("git-ignored"));
  });

  it("lazily loads children when a directory is expanded", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("main.tsx")).toBeInTheDocument();
    expect(readDirectory).toHaveBeenCalledWith("/ws/src");
  });

  it("ignores stale directory reads that resolve after a refresh", async () => {
    const firstRootRead = deferred<DirEntry[]>();
    const secondRootRead = deferred<DirEntry[]>();
    vi.mocked(readDirectory).mockReset();
    vi.mocked(readDirectory)
      .mockImplementationOnce(async () => firstRootRead.promise)
      .mockImplementationOnce(async () => secondRootRead.promise);

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await waitFor(() => expect(readDirectory).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Refresh Explorer" }));
    await waitFor(() => expect(readDirectory).toHaveBeenCalledTimes(2));

    secondRootRead.resolve([file("fresh.txt")]);
    expect(await screen.findByText("fresh.txt")).toBeInTheDocument();
    firstRootRead.resolve([file("stale.txt")]);

    await waitFor(() => {
      expect(screen.queryByText("stale.txt")).not.toBeInTheDocument();
      expect(screen.getByText("fresh.txt")).toBeInTheDocument();
    });
  });

  it("keeps current rows visible while a refresh is loading", async () => {
    const refreshed = deferred<DirEntry[]>();
    vi.mocked(readDirectory).mockReset();
    vi.mocked(readDirectory)
      .mockResolvedValueOnce([file("old.txt")])
      .mockImplementationOnce(async () => refreshed.promise);

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    expect(await screen.findByText("old.txt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh Explorer" }));

    expect(screen.getByText("old.txt")).toBeInTheDocument();

    refreshed.resolve([file("new.txt")]);
    expect(await screen.findByText("new.txt")).toBeInTheDocument();
    expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
  });

  it("calls onOpenFile when a file is clicked", async () => {
    const onOpenFile = vi.fn();
    render(<Explorer rootPath={ROOT} onOpenFile={onOpenFile} />);
    await userEvent.click(await screen.findByText("README.md"));
    expect(onOpenFile).toHaveBeenCalledWith("/ws/README.md");
  });

  it("opens inline rename when F2 is pressed on a file row", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    const label = await screen.findByText("README.md");
    fireEvent.keyDown(label.closest("button") as HTMLButtonElement, {
      key: "F2",
    });
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
  });

  it("opens inline rename on a slow second click of a selected file", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    const label = await screen.findByText("README.md");
    await userEvent.click(label); // first click: select + open
    await userEvent.click(label); // second click on the selected file: rename
    expect(await screen.findByLabelText("New name")).toBeInTheDocument();
  });

  it("double-click opens the file and does not start a rename", async () => {
    const onOpenFile = vi.fn();
    render(<Explorer rootPath={ROOT} onOpenFile={onOpenFile} />);
    await userEvent.dblClick(await screen.findByText("README.md"));
    // Wait past the slow-click rename delay to prove it was cancelled.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByLabelText("New name")).not.toBeInTheDocument();
    expect(onOpenFile).toHaveBeenCalledWith("/ws/README.md");
  });

  it("creates a new file via the toolbar", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");
    await userEvent.type(input, "notes.txt{Enter}");
    expect(createFile).toHaveBeenCalledWith("/ws", "/ws/notes.txt");
  });

  it("creates a new file inside the selected folder", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");

    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");
    await userEvent.type(input, "child.ts{Enter}");

    expect(createFile).toHaveBeenCalledWith("/ws", "/ws/src/child.ts");
  });

  it("creates a new folder beside the selected file", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await userEvent.click(await screen.findByText("main.tsx"));

    await userEvent.click(screen.getByRole("button", { name: "New Folder" }));
    const input = screen.getByLabelText("New folder name");
    await userEvent.type(input, "components{Enter}");

    expect(createDirectory).toHaveBeenCalledWith(
      "/ws",
      "/ws/src/components",
    );
  });

  it("creates a new file in the selected directory even after Collapse All hides it", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await userEvent.click(await screen.findByText("main.tsx"));
    // Collapse All hides main.tsx but keeps it selected (resolved-selection design).
    await userEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(screen.queryByText("main.tsx")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");
    await userEvent.type(input, "child.ts{Enter}");

    // Must target src (the hidden selection's dir), NOT the workspace root.
    expect(createFile).toHaveBeenCalledWith("/ws", "/ws/src/child.ts");
  });

  it("mounts the create input for a DEEPLY nested target after Collapse All", async () => {
    // Two levels deep: an intervening ancestor (src) is collapsed. startCreate must
    // expand the whole chain (root/src/components), or components' node — and the
    // inline create input — never render, silently no-opping the create.
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [dir("components", "/ws/src")];
      if (p === "/ws/src/components")
        return [file("Button.tsx", "/ws/src/components")];
      return [];
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await userEvent.click(await screen.findByText("components"));
    await userEvent.click(await screen.findByText("Button.tsx"));
    await userEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    // The input must MOUNT — it wouldn't if an intervening ancestor stayed collapsed.
    const input = await screen.findByLabelText("New file name");
    await userEvent.type(input, "child.ts{Enter}");

    expect(createFile).toHaveBeenCalledWith(
      "/ws",
      "/ws/src/components/child.ts",
    );
  });

  it("rejects create names that would escape the workspace", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");

    await userEvent.type(input, "../outside.txt{Enter}");

    expect(createFile).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining("not a path"),
    );
  });

  it("rejects rename names that contain path separators", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    await userEvent.click(screen.getByRole("button", { name: "Rename README.md" }));
    const input = screen.getByLabelText("New name");

    await userEvent.clear(input);
    await userEvent.type(input, "nested/README.md{Enter}");

    expect(renamePath).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining("not a path"),
    );
  });

  it("updates open editor tabs when a file is renamed", async () => {
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    await userEvent.click(screen.getByRole("button", { name: "Rename README.md" }));
    const input = screen.getByLabelText("New name");

    await userEvent.clear(input);
    await userEvent.type(input, "NOTES.md{Enter}");

    expect(renamePath).toHaveBeenCalledWith(
      "/ws",
      "/ws/README.md",
      "/ws/NOTES.md",
    );
    expect(useEditorStore.getState().docs[0].path).toBe("/ws/NOTES.md");
    expect(useEditorStore.getState().activePath).toBe("/ws/NOTES.md");
  });

  it("does not steal focus from an inline input opened during a refresh", async () => {
    const refreshed = deferred<DirEntry[]>();
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    // The rename triggers a refresh; keep the refreshed root read pending so
    // an inline create input can open while the focus restore is in flight.
    vi.mocked(readDirectory).mockImplementation(async (p: string) =>
      p === ROOT ? refreshed.promise : [],
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Rename README.md" }),
    );
    const renameInput = screen.getByLabelText("New name");
    await userEvent.clear(renameInput);
    await userEvent.type(renameInput, "NOTES.md{Enter}");

    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const createInput = screen.getByLabelText("New file name");
    await waitFor(() => expect(createInput).toHaveFocus());

    refreshed.resolve([dir("src"), file("NOTES.md")]);
    expect(await screen.findByText("NOTES.md")).toBeInTheDocument();
    // The resolving focus restore must not blur (commit/cancel) the input.
    expect(createInput).toHaveFocus();
  });

  it("moves a dragged file into a folder", async () => {
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/README.md", to: "/ws/src/README.md", isDir: false },
    ]);
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const readmeRow = screen.getByText("README.md").closest(".tree-row")!;
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(readmeRow, { dataTransfer });
    fireEvent.dragOver(srcRow, { dataTransfer });
    fireEvent.drop(srcRow, { dataTransfer });

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/README.md"], "/ws/src"),
    );
    expect(useEditorStore.getState().docs[0].path).toBe("/ws/src/README.md");
  });

  it("offers Replace for a structured drop conflict and removes the old destination tab", async () => {
    vi.mocked(movePaths)
      .mockRejectedValueOnce(
        'destination conflict: already exists: ["/ws/src/README.md"]',
      )
      .mockResolvedValueOnce([
        {
          from: "/ws/README.md",
          to: "/ws/src/README.md",
          isDir: false,
          replaced: true,
          replacedPath: "/ws/src/README.md",
        },
      ]);
    useEditorStore.getState().openDoc({
      path: "/ws/src/README.md",
      content: "old destination",
      language: "markdown",
    });
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "incoming source",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const readmeRow = screen.getByText("README.md").closest(".tree-row")!;
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(readmeRow, { dataTransfer });
    fireEvent.dragOver(srcRow, { dataTransfer });
    fireEvent.drop(srcRow, { dataTransfer });

    await waitFor(() => expect(movePaths).toHaveBeenCalledTimes(2));
    expect(movePaths).toHaveBeenNthCalledWith(
      1,
      ROOT,
      ["/ws/README.md"],
      "/ws/src",
    );
    expect(movePaths).toHaveBeenNthCalledWith(
      2,
      ROOT,
      ["/ws/README.md"],
      "/ws/src",
      true,
      ["/ws/src/README.md"],
    );
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("Replace them?"),
      expect.objectContaining({
        title: "Replace Existing Items",
        okLabel: "Replace",
        cancelLabel: "Cancel",
      }),
    );
    expect(useEditorStore.getState().docs).toEqual([
      expect.objectContaining({
        path: "/ws/src/README.md",
        content: "incoming source",
      }),
    ]);
  });

  it("closes an approved destination tab when its conflict disappears before retry", async () => {
    vi.mocked(movePaths)
      .mockRejectedValueOnce(
        'destination conflict: already exists: ["/ws/src/readme.md"]',
      )
      .mockResolvedValueOnce([
        {
          from: "/ws/README.md",
          to: "/ws/src/README.md",
          isDir: false,
          // Another actor removed the destination after the initial conflict.
          // The retry still succeeds, but no on-disk entry was displaced.
          replaced: false,
          replacedPath: null,
        },
      ]);
    useEditorStore.getState().openDoc({
      // A case-insensitive filesystem can report the existing entry with a
      // different spelling from the incoming source name.
      path: "/ws/src/readme.md",
      content: "stale destination tab",
      language: "markdown",
    });
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "incoming source",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(screen.getByText("README.md").closest(".tree-row")!, {
      dataTransfer,
    });
    fireEvent.drop(screen.getByText("src").closest(".tree-row")!, {
      dataTransfer,
    });

    await waitFor(() => expect(movePaths).toHaveBeenCalledTimes(2));
    expect(useEditorStore.getState().docs).toEqual([
      expect.objectContaining({
        path: "/ws/src/README.md",
        content: "incoming source",
      }),
    ]);
  });

  it("blocks only the affected editor move when a destination tab changes during retry", async () => {
    vi.mocked(movePaths)
      .mockRejectedValueOnce(
        'destination conflict: already exists: ["/ws/src/README.md"]',
      )
      .mockImplementationOnce(async () => {
        useEditorStore
          .getState()
          .updateContent("/ws/src/README.md", "edited during retry");
        return [
          {
            from: "/ws/README.md",
            to: "/ws/src/README.md",
            isDir: false,
            replaced: false,
            replacedPath: null,
          },
        ];
      });
    vi.mocked(ask)
      .mockResolvedValueOnce(true) // Replace.
      .mockResolvedValueOnce(false); // Keep the newly edited destination tab.
    useEditorStore.getState().openDoc({
      path: "/ws/src/README.md",
      content: "old destination",
      language: "markdown",
    });
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "incoming source",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(screen.getByText("README.md").closest(".tree-row")!, {
      dataTransfer,
    });
    fireEvent.drop(screen.getByText("src").closest(".tree-row")!, {
      dataTransfer,
    });

    await waitFor(() => expect(movePaths).toHaveBeenCalledTimes(2));
    expect(useEditorStore.getState().docs).toEqual([
      expect.objectContaining({
        path: "/ws/src/README.md",
        content: "edited during retry",
      }),
      expect.objectContaining({
        path: "/ws/README.md",
        content: "incoming source",
      }),
    ]);
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining("newly edited destination tabs were kept open"),
    );
  });

  it("does not offer Replace for an unstructured move failure", async () => {
    vi.mocked(movePaths).mockRejectedValueOnce(
      "destination conflict: already exists: /ws/src/README.md",
    );
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(screen.getByText("README.md").closest(".tree-row")!, {
      dataTransfer,
    });
    fireEvent.drop(screen.getByText("src").closest(".tree-row")!, {
      dataTransfer,
    });

    await waitFor(() => expect(message).toHaveBeenCalled());
    expect(ask).not.toHaveBeenCalled();
    expect(movePaths).toHaveBeenCalledTimes(1);
  });

  it("clears a stale folder drop target when dragging over a non-droppable row", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const readmeRow = screen.getByText("README.md").closest(".tree-row")!;
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(readmeRow, { dataTransfer });
    fireEvent.dragOver(srcRow, { dataTransfer });
    expect(srcRow).toHaveClass("drop-target");

    fireEvent.dragOver(readmeRow, { dataTransfer });
    expect(srcRow).not.toHaveClass("drop-target");
    fireEvent.dragEnd(readmeRow, { dataTransfer });

    expect(movePaths).not.toHaveBeenCalled();
  });

  it("uses backend-reported move paths to remap open editor tabs", async () => {
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/README.md", to: "/canonical/src/README.md", isDir: false },
    ]);
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    const readmeRow = screen.getByText("README.md").closest(".tree-row")!;
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(readmeRow, { dataTransfer });
    fireEvent.dragOver(srcRow, { dataTransfer });
    fireEvent.drop(srcRow, { dataTransfer });

    await waitFor(() => expect(movePaths).toHaveBeenCalled());
    expect(useEditorStore.getState().docs[0].path).toBe(
      "/canonical/src/README.md",
    );
  });

  it("moves a nested file to the workspace root when dropped on empty explorer space", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
      return [];
    });
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/src/main.tsx", to: "/ws/main.tsx", isDir: false },
    ]);
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");
    const mainRow = screen.getByText("main.tsx").closest(".tree-row")!;
    const rootDropSpacer = container.querySelector(".tree-root-drop-spacer")!;
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(mainRow, { dataTransfer });
    fireEvent.dragOver(rootDropSpacer, { dataTransfer });
    fireEvent.drop(rootDropSpacer, { dataTransfer });

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/src/main.tsx"], ROOT),
    );
  });

  it("imports native file drops into a folder when hit-testing finds the visual row", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const hitTest = mockElementFromPoint(srcRow);
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    try {
      const calls = webviewMocks.onDragDropEvent.mock
        .calls as unknown as Array<[NativeDropHandler]>;
      const handler = calls[0][0];
      act(() => {
        handler({
          payload: {
            type: "drop",
            paths: ["/tmp/from-finder.txt"],
            position: { x: 240, y: 80 },
          },
        });
      });

      await waitFor(() =>
        expect(copyPaths).toHaveBeenCalledWith(
          ROOT,
          ["/tmp/from-finder.txt"],
          "/ws/src",
        ),
      );
      expect(hitTest.elementFromPoint).toHaveBeenCalledWith(120, 40);
    } finally {
      hitTest.restore();
      if (originalDpr) {
        Object.defineProperty(window, "devicePixelRatio", originalDpr);
      } else {
        delete (window as unknown as { devicePixelRatio?: unknown })
          .devicePixelRatio;
      }
      if (originalPlatform) {
        Object.defineProperty(navigator, "platform", originalPlatform);
      } else {
        delete (navigator as unknown as { platform?: unknown }).platform;
      }
    }
  });

  it("removes native chrome and page zoom from macOS drag points", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2.4,
    });
    webviewMocks.scaleFactor.mockResolvedValueOnce(2);
    vi.mocked(nativeWindowContentInset).mockResolvedValueOnce({ x: 0, y: 32 });

    try {
      render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
      await screen.findByText("src");
      await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
      const srcRow = screen.getByText("src").closest(".tree-row")!;
      const hitTest = mockElementFromPoint(srcRow);

      try {
        const calls = webviewMocks.onDragDropEvent.mock
          .calls as unknown as Array<[NativeDropHandler]>;
        act(() => {
          calls[0][0]({
            payload: {
              type: "over",
              position: { x: 131, y: 111 },
            },
          });
        });
        expect(srcRow).toHaveClass("drop-target");

        act(() => {
          calls[0][0]({
            payload: {
              type: "drop",
              paths: ["/tmp/from-finder.txt"],
              position: { x: 131, y: 111 },
            },
          });
        });
        expect(srcRow).not.toHaveClass("drop-target");

        await waitFor(() =>
          expect(copyPaths).toHaveBeenCalledWith(
            ROOT,
            ["/tmp/from-finder.txt"],
            "/ws/src",
          ),
        );
        expect(hitTest.elementFromPoint).toHaveBeenCalledWith(
          131 / 1.2,
          (111 - 32) / 1.2,
        );
      } finally {
        hitTest.restore();
      }
    } finally {
      if (originalDpr) {
        Object.defineProperty(window, "devicePixelRatio", originalDpr);
      } else {
        delete (window as unknown as { devicePixelRatio?: unknown })
          .devicePixelRatio;
      }
      if (originalPlatform) {
        Object.defineProperty(navigator, "platform", originalPlatform);
      } else {
        delete (navigator as unknown as { platform?: unknown }).platform;
      }
    }
  });

  it("tracks each macOS native target and drops there during scale refresh", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    vi.mocked(readDirectory).mockImplementation(async (path: string) => {
      if (path === ROOT) return [dir("src"), dir("docs"), file("README.md")];
      return [];
    });

    try {
      render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
      await screen.findByText("src");
      await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
      const srcRow = screen.getByText("src").closest(".tree-row")!;
      const docsRow = screen.getByText("docs").closest(".tree-row")!;
      const originalElementFromPoint = document.elementFromPoint;
      const elementFromPoint = vi.fn((_x: number, y: number) =>
        y < 100 ? srcRow : docsRow,
      );
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: elementFromPoint,
      });
      webviewMocks.scaleFactor.mockResolvedValueOnce(2);

      try {
        const handler = (webviewMocks.onDragDropEvent.mock.calls as unknown as Array<
          [NativeDropHandler]
        >)[0][0];
        act(() => {
          handler({
            payload: {
              type: "enter",
              paths: ["/tmp/from-finder.txt"],
              position: { x: 131, y: 80 },
            },
          });
          handler({
            payload: { type: "over", position: { x: 131, y: 151 } },
          });
        });
        expect(srcRow).not.toHaveClass("drop-target");
        expect(docsRow).toHaveClass("drop-target");
        expect(elementFromPoint).toHaveBeenLastCalledWith(131, 151);

        act(() => {
          handler({
            payload: {
              type: "drop",
              paths: ["/tmp/from-finder.txt"],
              position: { x: 131, y: 151 },
            },
          });
        });
        expect(docsRow).not.toHaveClass("drop-target");
        await waitFor(() =>
          expect(copyPaths).toHaveBeenCalledWith(
            ROOT,
            ["/tmp/from-finder.txt"],
            "/ws/docs",
          ),
        );
      } finally {
        if (originalElementFromPoint) {
          Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: originalElementFromPoint,
          });
        } else {
          delete (document as unknown as { elementFromPoint?: unknown })
            .elementFromPoint;
        }
      }
    } finally {
      if (originalPlatform) {
        Object.defineProperty(navigator, "platform", originalPlatform);
      } else {
        delete (navigator as unknown as { platform?: unknown }).platform;
      }
    }
  });

  it("refuses a macOS native drop when display geometry is unavailable", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    webviewMocks.scaleFactor.mockRejectedValue(new Error("unavailable"));

    try {
      render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
      await screen.findByText("src");
      await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
      const handler = (webviewMocks.onDragDropEvent.mock.calls as unknown as Array<
        [NativeDropHandler]
      >)[0][0];
      act(() => {
        handler({
          payload: {
            type: "drop",
            paths: ["/tmp/from-finder.txt"],
            position: { x: 131, y: 111 },
          },
        });
      });

      await waitFor(() =>
        expect(message).toHaveBeenCalledWith(
          "Import failed: could not determine the folder under the pointer.",
        ),
      );
      expect(copyPaths).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(navigator, "platform", originalPlatform);
      } else {
        delete (navigator as unknown as { platform?: unknown }).platform;
      }
    }
  });

  it("re-prompts when a new native-drop conflict appears before the replace retry", async () => {
    vi.mocked(copyPaths)
      .mockRejectedValueOnce(
        'destination conflict: already exists: ["/ws/src/one.txt"]',
      )
      .mockRejectedValueOnce(
        'destination conflict: already exists: ["/ws/src/one.txt","/ws/src/two.txt"]',
      )
      .mockResolvedValueOnce([
        {
          from: "/tmp/one.txt",
          to: "/ws/src/one.txt",
          isDir: false,
          replaced: true,
          replacedPath: "/ws/src/one.txt",
        },
        {
          from: "/tmp/two.txt",
          to: "/ws/src/two.txt",
          isDir: false,
          replaced: true,
          replacedPath: "/ws/src/two.txt",
        },
      ]);
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
    const hitTest = mockElementFromPoint(
      screen.getByText("src").closest(".tree-row")!,
    );

    try {
      const calls = webviewMocks.onDragDropEvent.mock
        .calls as unknown as Array<[NativeDropHandler]>;
      calls[0][0]({
        payload: {
          type: "drop",
          paths: ["/tmp/one.txt", "/tmp/two.txt"],
          position: { x: 10, y: 10 },
        },
      });

      await waitFor(() => expect(copyPaths).toHaveBeenCalledTimes(3));
      expect(copyPaths).toHaveBeenNthCalledWith(
        2,
        ROOT,
        ["/tmp/one.txt", "/tmp/two.txt"],
        "/ws/src",
        true,
        ["/ws/src/one.txt"],
      );
      expect(copyPaths).toHaveBeenNthCalledWith(
        3,
        ROOT,
        ["/tmp/one.txt", "/tmp/two.txt"],
        "/ws/src",
        true,
        ["/ws/src/one.txt", "/ws/src/two.txt"],
      );
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      hitTest.restore();
    }
  });

  it("re-approves a dirty destination edited while a later discard prompt is open", async () => {
    const conflicts = ["/ws/src/one.txt", "/ws/src/two.txt"];
    vi.mocked(copyPaths)
      .mockRejectedValueOnce(
        `destination conflict: already exists: ${JSON.stringify(conflicts)}`,
      )
      .mockResolvedValueOnce(
        conflicts.map((path, index) => ({
          from: `/tmp/${index === 0 ? "one" : "two"}.txt`,
          to: path,
          isDir: false,
          replaced: true,
          replacedPath: path,
        })),
      );
    for (const path of conflicts) {
      useEditorStore.getState().openDoc({
        path,
        content: "saved",
        language: "plaintext",
      });
      useEditorStore.getState().updateContent(path, "dirty");
    }
    let askCount = 0;
    vi.mocked(ask).mockImplementation(async () => {
      askCount += 1;
      // Replace is call 1, first discard is call 2, second discard is call 3.
      // Editing the first doc here invalidates its earlier approval.
      if (askCount === 3) {
        useEditorStore.getState().updateContent(conflicts[0], "dirty again");
      }
      return true;
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalled());
    const hitTest = mockElementFromPoint(
      screen.getByText("src").closest(".tree-row")!,
    );

    try {
      const calls = webviewMocks.onDragDropEvent.mock
        .calls as unknown as Array<[NativeDropHandler]>;
      calls[0][0]({
        payload: {
          type: "drop",
          paths: ["/tmp/one.txt", "/tmp/two.txt"],
          position: { x: 10, y: 10 },
        },
      });

      await waitFor(() => expect(copyPaths).toHaveBeenCalledTimes(2));
      expect(ask).toHaveBeenCalledTimes(4);
      expect(useEditorStore.getState().docs).toHaveLength(0);
    } finally {
      hitTest.restore();
    }
  });

  it("moves on root drop even when drag state was cleared before drop", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
      return [];
    });
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/src/main.tsx", to: "/ws/main.tsx", isDir: false },
    ]);
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");
    const mainRow = screen.getByText("main.tsx").closest(".tree-row")!;
    const rootDropSpacer = container.querySelector(".tree-root-drop-spacer")!;
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(mainRow, { dataTransfer });
    fireEvent.dragEnd(mainRow, { dataTransfer });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.drop(rootDropSpacer, { dataTransfer });

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/src/main.tsx"], ROOT),
    );
  });

  it("moves to root on drag end when the root target was highlighted", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
      return [];
    });
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/src/main.tsx", to: "/ws/main.tsx", isDir: false },
    ]);
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");
    const mainRow = screen.getByText("main.tsx").closest(".tree-row")!;
    const rootDropSpacer = container.querySelector(".tree-root-drop-spacer")!;
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(mainRow, { dataTransfer });
    fireEvent.dragOver(rootDropSpacer, { dataTransfer });
    fireEvent.dragEnd(mainRow, { dataTransfer });

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/src/main.tsx"], ROOT),
    );
  });

  it("copies a file from the explorer context menu and pastes it into a folder", async () => {
    vi.mocked(movePaths).mockResolvedValue([]);
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src"), file("README.md")];
      if (p === "/ws/src") return [];
      return [];
    });
    vi.mocked(copyPaths).mockResolvedValue([
      { from: "/ws/README.md", to: "/ws/src/README.md", isDir: false },
    ]);
    render(
      <>
        <Explorer rootPath={ROOT} onOpenFile={() => {}} />
        <ContextMenu />
      </>,
    );
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md").closest(".tree-row")!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    fireEvent.contextMenu(screen.getByText("src").closest(".tree-row")!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Paste" }));

    await waitFor(() =>
      expect(copyPaths).toHaveBeenCalledWith(ROOT, ["/ws/README.md"], "/ws/src"),
    );
    expect(movePaths).not.toHaveBeenCalled();
  });

  it("cuts a file from the explorer context menu and pastes it at the workspace root", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
      return [];
    });
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/src/main.tsx", to: "/ws/main.tsx", isDir: false },
    ]);
    const { container } = render(
      <>
        <Explorer rootPath={ROOT} onOpenFile={() => {}} />
        <ContextMenu />
      </>,
    );
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");

    fireEvent.contextMenu(screen.getByText("main.tsx").closest(".tree-row")!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Cut" }));
    fireEvent.contextMenu(container.querySelector(".tree-root-drop-spacer")!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Paste" }));

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/src/main.tsx"], ROOT),
    );
  });

  it("moves a selected batch when dragging one selected row", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src"), dir("assets"), file("README.md")];
      return [];
    });
    vi.mocked(movePaths).mockResolvedValue([
      { from: "/ws/src", to: "/ws/assets/src", isDir: true },
      { from: "/ws/README.md", to: "/ws/assets/README.md", isDir: false },
    ]);
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("assets");
    fireEvent.click(screen.getByRole("treeitem", { name: "src" }), {
      metaKey: true,
    });
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    const readmeRow = screen.getByText("README.md").closest(".tree-row")!;
    const assetsRow = screen.getByText("assets").closest(".tree-row")!;
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(readmeRow, { dataTransfer });
    fireEvent.dragOver(assetsRow, { dataTransfer });
    fireEvent.drop(assetsRow, { dataTransfer });

    await waitFor(() =>
      expect(movePaths).toHaveBeenCalledWith(ROOT, ["/ws/src", "/ws/README.md"], "/ws/assets"),
    );
  });

  it("does not move a folder into its own descendant", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [dir("src")];
      if (p === "/ws/src") return [dir("components", "/ws/src")];
      return [];
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("components");
    const srcRow = screen.getByText("src").closest(".tree-row")!;
    const componentsRow = screen.getByText("components").closest(".tree-row")!;
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(srcRow, { dataTransfer });
    fireEvent.dragOver(componentsRow, { dataTransfer });
    fireEvent.drop(componentsRow, { dataTransfer });

    expect(movePaths).not.toHaveBeenCalled();
  });

  it("does not treat dropping onto a file row as a root drop", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");
    const nestedFileRow = screen.getByText("main.tsx").closest(".tree-row")!;
    const rootFileRow = screen.getByText("README.md").closest(".tree-row")!;
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(nestedFileRow, { dataTransfer });
    fireEvent.dragOver(rootFileRow, { dataTransfer });
    fireEvent.drop(rootFileRow, { dataTransfer });

    expect(movePaths).not.toHaveBeenCalled();
  });

  it("clears Explorer selection when the empty tree space is clicked", async () => {
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("README.md"));
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.click(container.querySelector(".tree-root-drop-spacer")!);

    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(useTreeStore.getState().selectedPaths).toEqual([]);
  });

  it("supports Cmd/Ctrl-click multi-select", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");

    fireEvent.click(screen.getByRole("treeitem", { name: "src" }), {
      metaKey: true,
    });
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });

    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("supports Shift-click range selection across visible rows", async () => {
    vi.mocked(readDirectory).mockImplementation(async (p: string) => {
      if (p === ROOT) return [file("a.txt"), file("b.txt"), file("c.txt")];
      return [];
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("a.txt");

    await userEvent.click(screen.getByRole("treeitem", { name: "a.txt" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "c.txt" }), {
      shiftKey: true,
    });

    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      expect(screen.getByRole("treeitem", { name })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
  });

  it("moves selected entries to undoable trash after confirmation", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));

    await waitFor(() =>
      expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, ["/ws/README.md"]),
    );
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Trash"), {
      title: "Delete",
      kind: "warning",
    });
    expect(useTreeStore.getState().deleteUndoStack).toHaveLength(1);
  });

  it("deletes hidden-but-selected items after Collapse All (resolves the full selection)", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    // Expand src and reveal its nested child.
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");

    // Multi-select the nested file and the root file (both visible).
    await userEvent.click(screen.getByRole("treeitem", { name: "main.tsx" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });

    // Collapse All hides main.tsx but it stays selected.
    await userEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(screen.queryByText("main.tsx")).not.toBeInTheDocument();

    // Delete must act on the FULL selection, including the now-hidden main.tsx —
    // not just the visible subset (which would silently skip main.tsx).
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));
    await waitFor(() => expect(movePathsToTrash).toHaveBeenCalled());
    const [, paths] = vi.mocked(movePathsToTrash).mock.calls[0];
    expect([...(paths as string[])].sort()).toEqual([
      "/ws/README.md",
      "/ws/src/main.tsx",
    ]);
  });

  it("falls back to window.confirm when the dialog plugin rejects", async () => {
    vi.mocked(ask).mockRejectedValue(new Error("not in tauri"));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
      await screen.findByText("README.md");
      fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
        metaKey: true,
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Delete Selected" }),
      );

      await waitFor(() =>
        expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, ["/ws/README.md"]),
      );
      expect(confirmSpy).toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("does not delete when the confirmation is declined", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));

    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(movePathsToTrash).not.toHaveBeenCalled();
  });

  it("closes a clean open doc after delete without prompting to discard", async () => {
    useEditorStore.getState().openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));

    await waitFor(() =>
      expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, ["/ws/README.md"]),
    );
    await waitFor(() =>
      expect(useEditorStore.getState().docs.map((doc) => doc.path)).toEqual([]),
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Lyceum Trash"), {
      title: "Delete",
      kind: "warning",
    });
  });

  it("keeps a dirty open doc after delete when discard is declined", async () => {
    const store = useEditorStore.getState();
    store.openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    store.updateContent("/ws/README.md", "# dirty");
    vi.mocked(ask)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));

    await waitFor(() =>
      expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, ["/ws/README.md"]),
    );
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(useEditorStore.getState().docs.map((doc) => doc.path)).toEqual([
      "/ws/README.md",
    ]);
    expect(useEditorStore.getState().activePath).toBe("/ws/README.md");
    expect(ask).toHaveBeenNthCalledWith(
      2,
      "Discard unsaved changes to README.md?",
      {
        title: "Unsaved Changes",
        kind: "warning",
      },
    );
  });

  it("uses a selected batch when deleting from a selected row action", async () => {
    vi.mocked(movePathsToTrash).mockResolvedValue({
      id: "batch-2",
      items: [
        {
          originalPath: "/ws/src",
          trashedPath: "/ws/.lyceum-trash/batch-2/src",
          isDir: true,
        },
        {
          originalPath: "/ws/README.md",
          trashedPath: "/ws/.lyceum-trash/batch-2/README.md",
          isDir: false,
        },
      ],
    });
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "src" }), {
      metaKey: true,
    });
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete README.md" }));

    await waitFor(() =>
      expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, [
        "/ws/src",
        "/ws/README.md",
      ]),
    );
  });

  it("undoes and redoes delete batches from Explorer keyboard shortcuts", async () => {
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));
    await waitFor(() => expect(movePathsToTrash).toHaveBeenCalled());
    const explorer = container.querySelector(".explorer") as HTMLElement;

    fireEvent.keyDown(explorer, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(restoreTrashBatch).toHaveBeenCalledWith(ROOT, [
        {
          originalPath: "/ws/README.md",
          trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
          isDir: false,
        },
      ]),
    );

    fireEvent.keyDown(explorer, { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(redoTrashBatch).toHaveBeenCalledWith(ROOT, [
        {
          originalPath: "/ws/README.md",
          trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
          isDir: false,
        },
      ]),
    );
  });

  it("keeps a dirty open doc after redo delete when discard is declined", async () => {
    useTreeStore.setState({
      deleteRedoStack: [
        {
          id: "batch-1",
          items: [
            {
              originalPath: "/ws/README.md",
              trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
              isDir: false,
            },
          ],
        },
      ],
    });
    const store = useEditorStore.getState();
    store.openDoc({
      path: "/ws/README.md",
      content: "# readme",
      language: "markdown",
    });
    store.updateContent("/ws/README.md", "# dirty");
    vi.mocked(ask).mockResolvedValue(false);

    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");

    await userEvent.click(screen.getByRole("button", { name: "Redo Delete" }));

    await waitFor(() =>
      expect(redoTrashBatch).toHaveBeenCalledWith(ROOT, [
        {
          originalPath: "/ws/README.md",
          trashedPath: "/ws/.lyceum-trash/batch-1/README.md",
          isDir: false,
        },
      ]),
    );
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(useEditorStore.getState().docs.map((doc) => doc.path)).toEqual([
      "/ws/README.md",
    ]);
    expect(useTreeStore.getState().deleteUndoStack).toHaveLength(1);
    expect(useTreeStore.getState().deleteRedoStack).toHaveLength(0);
    expect(ask).toHaveBeenCalledWith(
      "Discard unsaved changes to README.md?",
      {
        title: "Unsaved Changes",
        kind: "warning",
      },
    );
  });

  it("navigates rows with arrow keys and opens a file with Enter", async () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <Explorer rootPath={ROOT} onOpenFile={onOpenFile} />,
    );
    await screen.findByText("README.md");
    const tree = container.querySelector(".tree") as HTMLElement;

    // Home selects the first row (src); ArrowDown moves to README.md.
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("/ws/README.md");
  });

  it("expands and collapses a directory with ArrowRight/ArrowLeft", async () => {
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    const tree = container.querySelector(".tree") as HTMLElement;

    fireEvent.keyDown(tree, { key: "Home" }); // select "src"
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(await screen.findByText("main.tsx")).toBeInTheDocument();

    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByText("main.tsx")).not.toBeInTheDocument();
  });
});
