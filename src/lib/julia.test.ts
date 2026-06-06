import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { missingJuliaMessage, runActiveJulia, runInvocation } from "./julia";
import type { EditorDoc } from "../state/editorStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialOutputData, useOutputStore } from "../state/outputStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

const doc = (path: string): EditorDoc => ({
  path,
  name: path.split("/").pop() ?? path,
  content: "println(1)",
  savedContent: "println(1)",
  language: "julia",
  kind: "text",
  reloadVersion: 0,
});

describe("runInvocation", () => {
  it("returns null when no document is active", () => {
    expect(runInvocation(null, "")).toBeNull();
  });
  it("runs the selection as code when it is non-empty", () => {
    expect(runInvocation(doc("/w/a.jl"), "1 + 1")).toEqual({ code: "1 + 1" });
  });
  it("runs the whole file when the selection is empty/whitespace", () => {
    expect(runInvocation(doc("/w/a.jl"), "   ")).toEqual({ file: "/w/a.jl" });
  });

  it("does not run viewer tabs", () => {
    expect(
      runInvocation(
        { ...doc("/w/paper.pdf"), language: "pdf", kind: "pdf" },
        "1 + 1",
      ),
    ).toBeNull();
  });
});

describe("runActiveJulia", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    writeFileMock.mockReset().mockResolvedValue(undefined);
    useEditorStore.setState(initialEditorData, false);
    useOutputStore.setState(initialOutputData, false);
    useLayoutStore.setState(initialLayoutData, false);
    useWorkspaceStore.setState(initialWorkspaceData, false);
  });

  it("refuses non-.jl files without spawning", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/notes.txt",
      content: "hi",
      language: "plaintext",
    });
    await runActiveJulia();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(
      useOutputStore.getState().lines.some((l) => l.includes("Julia-only")),
    ).toBe(true);
    expect(useLayoutStore.getState().activeBottomTab).toBe("output");
  });

  it("saves and runs the whole file when there is no selection", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "println(1)", language: "julia" });
    await runActiveJulia();
    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock).toHaveBeenCalledWith("/w/a.jl", "println(1)");
    expect(invokeMock).toHaveBeenCalledWith(
      "run_julia",
      expect.objectContaining({ file: "/w/a.jl", code: null, cwd: "/w" }),
    );
  });

  it("runs the selection as code without saving the file", async () => {
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "x", language: "julia" });
    useEditorStore.getState().setSelection("2 + 2");
    await runActiveJulia();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      "run_julia",
      expect.objectContaining({ code: "2 + 2", file: null }),
    );
  });

  it("refuses to start a second run while one is in progress", async () => {
    useOutputStore.setState({ lines: [], running: true }, false);
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "x", language: "julia" });
    await runActiveJulia();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("reports an actionable message when Julia cannot be started", async () => {
    invokeMock.mockRejectedValueOnce(
      "failed to start julia: No such file or directory (os error 2)",
    );
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "x", language: "julia" });

    await runActiveJulia();

    expect(
      useOutputStore
        .getState()
        .lines.some((line) => line.includes("set juliaPath")),
    ).toBe(true);
  });
});

describe("missingJuliaMessage", () => {
  it("recognizes missing executable errors", () => {
    expect(missingJuliaMessage("No such file or directory")).toContain(
      "Julia was not found",
    );
    expect(missingJuliaMessage("permission denied")).toBeNull();
  });
});
