import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const writeFileMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock("./ipc", () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

import {
  expectedLatexPdfPath,
  missingBuildToolMessage,
  runLatexBuild,
} from "./latexBuild";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import {
  flushOutputBuffer,
  initialOutputData,
  useOutputStore,
} from "../state/outputStore";
import { initialSettingsData, useSettingsStore } from "../state/settingsStore";
import { initialTreeData, useTreeStore } from "../state/treeStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

type EventHandler = (event: { payload: unknown }) => void;

describe("runLatexBuild", () => {
  const handlers = new Map<string, EventHandler>();
  const plan = (overrides: Partial<Record<string, unknown>> = {}) => ({
    command: 'latexmk -pdf "main.tex"',
    cwd: "/w",
    pdfPath: "/w/main.pdf",
    removedStalePdf: false,
    tool: "latexmk",
    source: "path",
    ...overrides,
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    handlers.clear();
    invokeMock.mockReset().mockResolvedValue(plan());
    writeFileMock.mockReset().mockResolvedValue(undefined);
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
      "run_latex_build",
      expect.objectContaining({
        texPath: "/w/main.tex",
        configuredCommand: "latexmk -pdf main.tex",
      }),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/w/main.tex",
      "\\documentclass{article}",
    );
    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/w/main.pdf");
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
  });

  it("removes stale output, compiles, refreshes explorer, and does not open the PDF by default", async () => {
    invokeMock.mockResolvedValue(plan({ removedStalePdf: true }));
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    const outputKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:output:"),
    );
    expect(outputKey).toBeDefined();
    handlers.get(outputKey!)!({
      payload: { stream: "stdout", line: "[latex] removed stale /w/main.pdf" },
    });
    // Streamed output is batched (rAF); flush so we can assert it synchronously.
    flushOutputBuffer();
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
    invokeMock.mockResolvedValue(
      plan({
        command: 'latexmk -pdf "paper.tex"',
        cwd: "/w/chapters",
        pdfPath: "/w/chapters/paper.pdf",
      }),
    );
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/chapters/paper.tex",
      content: "\\input{section}",
      language: "latex",
    });

    await runLatexBuild({ openOnSuccess: true });

    expect(invokeMock).toHaveBeenCalledWith(
      "run_latex_build",
      expect.objectContaining({
        texPath: "/w/chapters/paper.tex",
        configuredCommand: "latexmk -pdf main.tex",
      }),
    );
    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useWorkspaceStore.getState().pendingOpenPath).toBe(
      "/w/chapters/paper.pdf",
    );
  });

  it("uses the backend-reported PDF path as the success source of truth", async () => {
    invokeMock.mockResolvedValue(
      plan({
        pdfPath: "/w/build-output/main.pdf",
      }),
    );
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild({ openOnSuccess: true });

    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );
    expect(exitKey).toBeDefined();

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useOutputStore.getState().lines).toContain(
      "[latex] wrote /w/build-output/main.pdf",
    );
    expect(useWorkspaceStore.getState().pendingOpenPath).toBe(
      "/w/build-output/main.pdf",
    );
  });

  it("waits for the backend build plan before handling a fast exit event", async () => {
    const backendPlan = plan({
      command: 'latexmk -pdf "paper.tex"',
      pdfPath: "/w/backend-paper.pdf",
    });
    const pendingPlan = deferred<typeof backendPlan>();
    invokeMock.mockReturnValue(pendingPlan.promise);
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    const buildPromise = runLatexBuild({ openOnSuccess: true });
    await waitFor(() =>
      expect(
        Array.from(handlers.keys()).some((key) =>
          key.startsWith("build:exit:"),
        ),
      ).toBe(true),
    );
    const exitKey = Array.from(handlers.keys()).find((key) =>
      key.startsWith("build:exit:"),
    );

    handlers.get(exitKey!)!({ payload: 0 });

    expect(useOutputStore.getState().running).toBe(true);
    expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();

    pendingPlan.resolve(backendPlan);
    await buildPromise;

    expect(useOutputStore.getState().lines).toContain(
      "[latex] wrote /w/backend-paper.pdf",
    );
    expect(useWorkspaceStore.getState().pendingOpenPath).toBe(
      "/w/backend-paper.pdf",
    );
  });

  it("claims the run before the async save so a double-click starts one build", async () => {
    const pendingWrite = deferred<void>();
    writeFileMock.mockReturnValue(pendingWrite.promise);
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    // Second call arrives while the first is still awaiting the file save.
    const first = runLatexBuild();
    const second = runLatexBuild();
    pendingWrite.resolve(undefined);
    await Promise.all([first, second]);

    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "run_latex_build"),
    ).toHaveLength(1);
  });

  it("releases the run claim when the pre-build save fails", async () => {
    writeFileMock.mockRejectedValue(new Error("disk full"));
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    expect(useOutputStore.getState().running).toBe(false);
    expect(useOutputStore.getState().runId).toBeNull();
    expect(
      useOutputStore
        .getState()
        .lines.some((line) => line.includes("failed to save main.tex")),
    ).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("surfaces Rust builder preflight errors", async () => {
    invokeMock.mockRejectedValue(new Error("No LaTeX compiler was found"));
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/main.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await runLatexBuild();

    expect(invokeMock).toHaveBeenCalledWith(
      "run_latex_build",
      expect.objectContaining({ texPath: "/w/main.tex" }),
    );
    expect(useOutputStore.getState().lines).toContain(
      "No LaTeX compiler was found",
    );
    expect(useOutputStore.getState().running).toBe(false);
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
