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
  createFile,
  movePathsToTrash,
  readDirectory,
  redoTrashBatch,
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
