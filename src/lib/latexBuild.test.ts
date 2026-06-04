import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const writeFileMock = vi.fn();
const deleteFileIfExistsMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock("./ipc", () => ({
  deleteFileIfExists: (...args: unknown[]) => deleteFileIfExistsMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

import {
  expectedLatexPdfPath,
  missingBuildToolMessage,
  runLatexBuild,
} from "./latexBuild";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialOutputData, useOutputStore } from "../state/outputStore";
import { initialSettingsData, useSettingsStore } from "../state/settingsStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

type EventHandler = (event: { payload: unknown }) => void;

describe("runLatexBuild", () => {
  const handlers = new Map<string, EventHandler>();

  beforeEach(() => {
    handlers.clear();
    invokeMock.mockReset().mockResolvedValue(undefined);
    writeFileMock.mockReset().mockResolvedValue(undefined);
    deleteFileIfExistsMock.mockReset().mockResolvedValue(false);
    listenMock.mockReset().mockImplementation(
      async (eventName: string, handler: EventHandler) => {
        handlers.set(eventName, handler);
        return vi.fn();
      },
    );
    useEditorStore.setState(initialEditorData, false);
    useLayoutStore.setState(initialLayoutData, false);
    useOutputStore.setState(initialOutputData, false);
    useSettingsStore.setState(initialSettingsData, false);
    useTreeStore.setState(initialTreeData, false);
    useWorkspaceStore.setState(initialWorkspaceData, false);
  });

  it("compiles the active tex file and opens the output PDF when requested", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild({ openOnSuccess: true });

    expect(invokeMock).toHaveBeenCalledWith(
      "run_build",
      expect.objectContaining({
        command: 'latexmk -pdf "main.tex"',
        cwd: "/w",
      }),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/w/main.tex",
      "\\documentclass{article}",
    );
    expect(deleteFileIfExistsMock).toHaveBeenCalledWith("/w/main.pdf");
    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/w/main.pdf");
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
  });

  it("removes stale output, compiles, refreshes explorer, and does not open the PDF by default", async () => {
    deleteFileIfExistsMock.mockResolvedValue(true);
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    expect(deleteFileIfExistsMock).toHaveBeenCalledWith("/w/main.pdf");
    expect(useOutputStore.getState().lines).toContain(
      "[latex] removed stale /w/main.pdf",
    );
    const refreshAfterRemove = useTreeStore.getState().refreshNonce;
    expect(refreshAfterRemove).toBe(1);

    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
    expect(useTreeStore.getState().refreshNonce).toBe(2);
    expect(useOutputStore.getState().lines).toContain(
      "[latex] wrote /w/main.pdf",
    );
  });

  it("uses the current tex file directory instead of assuming main.tex", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/chapters/paper.tex",
      content: "\\input{section}",
      language: "latex",
    });

    await runLatexBuild({ openOnSuccess: true });

    expect(invokeMock).toHaveBeenCalledWith(
      "run_build",
      expect.objectContaining({
        command: 'latexmk -pdf "paper.tex"',
        cwd: "/w/chapters",
      }),
    );
    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(deleteFileIfExistsMock).toHaveBeenCalledWith("/w/chapters/paper.pdf");
    expect(useWorkspaceStore.getState().pendingOpenPath).toBe(
      "/w/chapters/paper.pdf",
    );
  });

  it("aborts before running when stale output cannot be removed", async () => {
    deleteFileIfExistsMock.mockRejectedValue(new Error("permission denied"));
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    expect(invokeMock).not.toHaveBeenCalledWith(
      "run_build",
      expect.anything(),
    );
    expect(useOutputStore.getState().lines).toContain(
      "failed to remove stale PDF /w/main.pdf: Error: permission denied",
    );
  });

  it("uses tectonic when the stock latexmk command is configured and latexmk is unavailable", async () => {
    invokeMock.mockImplementation(async (command: string, args: unknown) => {
      if (command === "program_available") {
        return (args as { program: string }).program === "tectonic";
      }
      return undefined;
    });
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    expect(invokeMock).toHaveBeenCalledWith("program_available", {
      program: "latexmk",
    });
    expect(invokeMock).toHaveBeenCalledWith("program_available", {
      program: "tectonic",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "run_build",
      expect.objectContaining({
        command: 'tectonic "main.tex"',
        cwd: "/w",
      }),
    );
  });

  it("adds an actionable message when latexmk is missing", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 127 });

    expect(
      useOutputStore
        .getState()
        .lines.some((line) => line.includes("latexmk was not found")),
    ).toBe(true);
  });
});

describe("expectedLatexPdfPath", () => {
  it("prefers the active target path and falls back to command/root derivation", () => {
    expect(
      expectedLatexPdfPath("tectonic main.tex", "/w/paper.tex", null, "/w"),
    ).toBe("/w/paper.pdf");
    expect(
      expectedLatexPdfPath("latexmk -pdf main.tex", null, null, "/w"),
    ).toBe("/w/main.pdf");
    expect(expectedLatexPdfPath("echo hi", null, null, "/w")).toBeNull();
  });
});

describe("missingBuildToolMessage", () => {
  it("explains missing latexmk and generic build commands", () => {
    expect(missingBuildToolMessage('latexmk -pdf "main.tex"', 127)).toContain(
      "latexmk was not found",
    );
    expect(missingBuildToolMessage("/opt/tool/build main.tex", 127)).toContain(
      "build",
    );
    expect(missingBuildToolMessage("latexmk -pdf main.tex", 1)).toBeNull();
  });
});
