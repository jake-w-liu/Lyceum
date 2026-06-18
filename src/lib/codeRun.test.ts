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

import { runActiveCode, runInvocation } from "./codeRun";
import { missingRuntimeMessage, runProfileForPath } from "./runProfiles";
import type { EditorDoc } from "../state/editorStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialOutputData, useOutputStore } from "../state/outputStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import {
  DEFAULT_SETTINGS,
  initialSettingsData,
  useSettingsStore,
} from "../state/settingsStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

const doc = (path: string, language = "julia"): EditorDoc => ({
  path,
  name: path.split("/").pop() ?? path,
  content: "println(1)",
  savedContent: "println(1)",
  language,
  kind: "text",
  reloadVersion: 0,
});

describe("runInvocation", () => {
  it("returns null when no document is active", () => {
    expect(runInvocation(null, "", DEFAULT_SETTINGS)).toBeNull();
  });

  it("runs the selection as code when it is non-empty", () => {
    const invocation = runInvocation(doc("/w/a.jl"), "1 + 1", DEFAULT_SETTINGS);
    expect(invocation?.code).toBe("1 + 1");
    expect(invocation?.file).toBeUndefined();
    expect(invocation?.command.args).toEqual(["-e", "1 + 1"]);
  });

  it("runs the whole file when the selection is empty/whitespace", () => {
    const invocation = runInvocation(doc("/w/a.jl"), "   ", DEFAULT_SETTINGS);
    expect(invocation?.file).toBe("/w/a.jl");
    expect(invocation?.code).toBeUndefined();
    expect(invocation?.command.args).toEqual(["/w/a.jl"]);
  });

  it("does not run viewer tabs", () => {
    expect(
      runInvocation(
        { ...doc("/w/paper.pdf", "pdf"), kind: "pdf" },
        "1 + 1",
        DEFAULT_SETTINGS,
      ),
    ).toBeNull();
  });

  it("selects non-Julia run profiles", () => {
    const invocation = runInvocation(
      doc("/w/app.py", "python"),
      "print(1)",
      DEFAULT_SETTINGS,
    );
    expect(invocation?.command.profile.id).toBe("python");
    expect(invocation?.command.program).toBe("python3");
    expect(invocation?.command.fallbackPrograms).toEqual(["python", "py"]);
    expect(invocation?.command.args).toEqual(["-c", "print(1)"]);
  });
});

describe("runActiveCode", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    writeFileMock.mockReset().mockResolvedValue(undefined);
    useEditorStore.setState(initialEditorData, false);
    useOutputStore.setState(initialOutputData, false);
    useLayoutStore.setState(initialLayoutData, false);
    useWorkspaceStore.setState(initialWorkspaceData, false);
    useSettingsStore.setState(initialSettingsData, false);
  });

  it("reports unsupported files without spawning", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/notes.txt",
      content: "hi",
      language: "plaintext",
    });
    await runActiveCode();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(
      useOutputStore.getState().lines.some((l) => l.includes("No built-in run profile")),
    ).toBe(true);
    expect(useLayoutStore.getState().activeBottomTab).toBe("output");
  });

  it("saves and runs the whole Julia file when there is no selection", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "println(1)", language: "julia" });
    await runActiveCode();
    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock).toHaveBeenCalledWith("/w/a.jl", "println(1)");
    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          profileId: "julia",
          program: "julia",
          args: ["/w/a.jl"],
          cwd: "/w",
        }),
      }),
    );
  });

  it("runs Python selection as code without saving the file", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore
      .getState()
      .openDoc({ path: "/w/pkg/app.py", content: "x", language: "python" });
    useEditorStore.getState().setSelection("print(2 + 2)");
    await runActiveCode();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          profileId: "python",
          program: "python3",
          fallbackPrograms: ["python", "py"],
          args: ["-c", "print(2 + 2)"],
          cwd: "/w/pkg",
        }),
      }),
    );
  });

  it("runs without a cwd when no workspace is open", async () => {
    useEditorStore
      .getState()
      .openDoc({ path: "/tmp/app.py", content: "print(1)", language: "python" });

    await runActiveCode();

    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          profileId: "python",
          cwd: null,
        }),
      }),
    );
  });

  it("does not send an external file directory as cwd", async () => {
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore
      .getState()
      .openDoc({ path: "/other/app.py", content: "print(1)", language: "python" });

    await runActiveCode();

    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          profileId: "python",
          cwd: null,
        }),
      }),
    );
  });

  it("uses extension-specific shell interpreters", () => {
    expect(
      runInvocation(doc("/w/script.bash", "shell"), "", DEFAULT_SETTINGS)
        ?.command.program,
    ).toBe("bash");
    expect(
      runInvocation(doc("/w/script.zsh", "shell"), "", DEFAULT_SETTINGS)
        ?.command.program,
    ).toBe("zsh");
    expect(
      runInvocation(doc("/w/script.sh", "shell"), "", DEFAULT_SETTINGS)
        ?.command.program,
    ).toBe("sh");
  });

  it("uses configured runtime paths", async () => {
    useSettingsStore.getState().replaceAll({
      ...DEFAULT_SETTINGS,
      runtimePaths: { ...DEFAULT_SETTINGS.runtimePaths, python: "/opt/py/bin/python" },
    });
    useEditorStore
      .getState()
      .openDoc({ path: "/w/app.py", content: "print(1)", language: "python" });

    await runActiveCode();

    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          profileId: "python",
          program: "/opt/py/bin/python",
          fallbackPrograms: [],
        }),
      }),
    );
  });

  it("treats whitespace runtime paths as unset", async () => {
    useSettingsStore.getState().replaceAll({
      ...DEFAULT_SETTINGS,
      runtimePaths: { ...DEFAULT_SETTINGS.runtimePaths, python: "   " },
    });
    useEditorStore
      .getState()
      .openDoc({ path: "/w/app.py", content: "print(1)", language: "python" });

    await runActiveCode();

    expect(invokeMock).toHaveBeenCalledWith(
      "run_process",
      expect.objectContaining({
        request: expect.objectContaining({
          program: "python3",
          fallbackPrograms: ["python", "py"],
        }),
      }),
    );
  });

  it("refuses to start a second run while one is in progress", async () => {
    useOutputStore.setState({ lines: [], running: true }, false);
    useEditorStore
      .getState()
      .openDoc({ path: "/w/a.jl", content: "x", language: "julia" });
    await runActiveCode();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("reports an actionable message when a runtime cannot be started", async () => {
    invokeMock.mockRejectedValueOnce(
      "failed to start python3: No such file or directory (os error 2)",
    );
    useEditorStore
      .getState()
      .openDoc({ path: "/w/app.py", content: "x", language: "python" });

    await runActiveCode();

    expect(
      useOutputStore
        .getState()
        .lines.some((line) => line.includes("runtimePaths.python")),
    ).toBe(true);
  });
});

describe("run profiles", () => {
  it("recognizes missing executable errors", () => {
    const profile = runProfileForPath("/w/app.py");
    expect(profile).toBeDefined();
    expect(missingRuntimeMessage(profile!, "No such file or directory")).toContain(
      "Python runtime was not found",
    );
    expect(missingRuntimeMessage(profile!, "permission denied")).toBeNull();
  });
});
