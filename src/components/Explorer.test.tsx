import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
}));
import {
  createFile,
  deletePath,
  readDirectory,
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
  vi.mocked(deletePath).mockClear();
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

  it("deletes an entry after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Explorer rootPath={ROOT} onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    await userEvent.click(
      screen.getByRole("button", { name: "Delete README.md" }),
    );
    expect(deletePath).toHaveBeenCalledWith("/ws/README.md");
    confirmSpy.mockRestore();
  });
});
