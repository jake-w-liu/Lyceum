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

// Native confirm/alert dialogs (Tauri plugin). `ask` defaults to confirming.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => {}),
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
}));
import {
  createDirectory,
  createFile,
  movePathsToTrash,
  copyPaths,
  movePaths,
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

beforeEach(() => {
  useTreeStore.setState(initialTreeData, false);
  useEditorStore.setState(initialEditorData, false);
  useGitStore.setState(initialGitData, false);
  useContextMenuStore.setState(initialContextMenuData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
  vi.mocked(readDirectory).mockReset();
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
    expect(createFile).toHaveBeenCalledWith("/ws/notes.txt");
  });

  it("creates a new file inside the selected folder", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await screen.findByText("main.tsx");

    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");
    await userEvent.type(input, "child.ts{Enter}");

    expect(createFile).toHaveBeenCalledWith("/ws/src/child.ts");
  });

  it("creates a new folder beside the selected file", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await userEvent.click(await screen.findByText("src"));
    await userEvent.click(await screen.findByText("main.tsx"));

    await userEvent.click(screen.getByRole("button", { name: "New Folder" }));
    const input = screen.getByLabelText("New folder name");
    await userEvent.type(input, "components{Enter}");

    expect(createDirectory).toHaveBeenCalledWith("/ws/src/components");
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
    expect(createFile).toHaveBeenCalledWith("/ws/src/child.ts");
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

    expect(createFile).toHaveBeenCalledWith("/ws/src/components/child.ts");
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

    expect(renamePath).toHaveBeenCalledWith("/ws/README.md", "/ws/NOTES.md");
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
