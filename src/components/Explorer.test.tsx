import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Explorer } from "./Explorer";
import type { DirEntry } from "../lib/ipc";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";

vi.mock("../lib/ipc", () => ({
  readDirectory: vi.fn(),
  createFile: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  movePaths: vi.fn(async () => []),
  deletePath: vi.fn(async () => {}),
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
}));
import {
  createDirectory,
  createFile,
  movePathsToTrash,
  movePaths,
  readDirectory,
  redoTrashBatch,
  renamePath,
  restoreTrashBatch,
} from "../lib/ipc";

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

beforeEach(() => {
  useTreeStore.setState(initialTreeData, false);
  useEditorStore.setState(initialEditorData, false);
  vi.mocked(readDirectory).mockReset();
  vi.mocked(readDirectory).mockImplementation(async (p: string) => {
    if (p === ROOT) return [dir("src"), file("README.md")];
    if (p === "/ws/src") return [file("main.tsx", "/ws/src")];
    return [];
  });
  vi.mocked(createFile).mockClear();
  vi.mocked(createDirectory).mockClear();
  vi.mocked(renamePath).mockClear();
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
});

describe("Explorer", () => {
  it("renders the root entries", async () => {
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
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

  it("calls onOpenFile when a file is clicked", async () => {
    const onOpenFile = vi.fn();
    render(<Explorer rootPath={ROOT} onOpenFile={onOpenFile} />);
    await userEvent.click(await screen.findByText("README.md"));
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

  it("rejects create names that would escape the workspace", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("src");
    await userEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByLabelText("New file name");

    await userEvent.type(input, "../outside.txt{Enter}");

    expect(createFile).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a path"),
    );
    alertSpy.mockRestore();
  });

  it("rejects rename names that contain path separators", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    await userEvent.click(screen.getByRole("button", { name: "Rename README.md" }));
    const input = screen.getByLabelText("New name");

    await userEvent.clear(input);
    await userEvent.type(input, "nested/README.md{Enter}");

    expect(renamePath).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a path"),
    );
    alertSpy.mockRestore();
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));

    expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, ["/ws/README.md"]);
    expect(useTreeStore.getState().deleteUndoStack).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it("uses a selected batch when deleting from a selected row action", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
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

    expect(movePathsToTrash).toHaveBeenCalledWith(ROOT, [
      "/ws/src",
      "/ws/README.md",
    ]);
    confirmSpy.mockRestore();
  });

  it("undoes and redoes delete batches from Explorer keyboard shortcuts", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }), {
      metaKey: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete Selected" }));
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
    confirmSpy.mockRestore();
  });
});
