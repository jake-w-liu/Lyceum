import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { initialLayoutData, useLayoutStore } from "./state/layoutStore";
import { initialPreviewData, usePreviewStore } from "./state/previewStore";
import { initialEditorData, useEditorStore } from "./state/editorStore";
import { initialTreeData, useTreeStore } from "./state/treeStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "./state/workspaceStore";
import { readDirectory } from "./lib/ipc";

// StatusBar fetches platform info over IPC; mock it so tests are deterministic
// and don't depend on a Tauri runtime.
vi.mock("./lib/ipc", () => ({
  getAppInfo: vi.fn(async () => ({
    name: "lyceum",
    version: "0.0.0",
    os: "testos",
    arch: "testarch",
  })),
  readDirectory: vi.fn(),
  readFile: vi.fn(async () => {
    throw new Error("no test file");
  }),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  unwatchWorkspace: vi.fn(async () => {}),
  watchWorkspace: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

// The terminal mounts xterm (needs canvas/layout); stub it in the shell test.
vi.mock("./components/TerminalPanel", () => ({ TerminalPanel: () => null }));

const ROOT = "/ws";

const reset = () => {
  useLayoutStore.setState(initialLayoutData, false);
  usePreviewStore.setState(initialPreviewData, false);
  useEditorStore.setState(initialEditorData, false);
  useTreeStore.setState(initialTreeData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
  vi.mocked(readDirectory).mockReset();
  vi.mocked(readDirectory).mockImplementation(async (path: string) =>
    path === ROOT
      ? [{ name: "icon.png", path: `${ROOT}/icon.png`, isDir: false }]
      : [],
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:icon"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
};

describe("App shell", () => {
  beforeEach(reset);

  it("renders the core workbench regions", async () => {
    render(<App />);
    expect(screen.getByLabelText("Activity Bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Status Bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
    // Flush StatusBar's async effect to avoid act() warnings.
    await screen.findByTestId("status-platform");
  });

  it("toggles the sidebar with the primary modifier + B", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.queryByLabelText("Sidebar")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.getByLabelText("Sidebar")).toBeInTheDocument();
  });

  it("opens the bottom panel with the primary modifier + J", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.queryByLabelText("Panel")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(document, { key: "j", ctrlKey: true });
      await vi.dynamicImportSettled();
    });
    expect(screen.getByLabelText("Panel")).toBeInTheDocument();
  });

  it("does not open a side preview panel with modifier + Shift + V and no previewable tab", async () => {
    render(<App />);
    await screen.findByTestId("status-platform");
    expect(screen.queryByLabelText("Preview")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "V", ctrlKey: true, shiftKey: true });
    expect(screen.queryByLabelText("Preview")).not.toBeInTheDocument();
  });

  it("opens an image viewer tab when a PNG is clicked in Explorer", async () => {
    useWorkspaceStore.getState().openWorkspace(ROOT);
    render(<App />);
    await screen.findByTestId("status-platform");

    await userEvent.click(await screen.findByText("icon.png"));

    expect(await screen.findByRole("tab", { name: "icon.png" }))
      .toHaveAttribute("aria-selected", "true");
    expect(useEditorStore.getState().docs).toMatchObject([
      { path: `${ROOT}/icon.png`, kind: "image" },
    ]);
    expect(usePreviewStore.getState().imagePath).toBeNull();
    expect(screen.queryByLabelText("Preview")).not.toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "icon.png" }))
      .toHaveAttribute("src", "blob:icon");
  });
});
