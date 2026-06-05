// Julia run-file / run-selection orchestration (M8).
//
// `runInvocation` (pure, tested) decides what to run: the current selection if
// any, else the active file. `runActiveJulia` saves the file, streams the
// Julia process output into the Output panel, and updates run state.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getActiveDoc,
  isTextDoc,
  useEditorStore,
  type EditorDoc,
} from "../state/editorStore";
import { useOutputStore } from "../state/outputStore";
import { useLayoutStore } from "../state/layoutStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useSettingsStore } from "../state/settingsStore";
import { resolveTerminalCwd } from "./terminalCwd";
import { writeFile } from "./ipc";

export interface JuliaInvocation {
  file?: string;
  code?: string;
}

/** Decide what to run: a non-empty selection runs as code, else the file. */
export function runInvocation(
  doc: EditorDoc | null,
  selection: string,
): JuliaInvocation | null {
  if (!doc || !isTextDoc(doc)) return null;
  if (selection.trim().length > 0) return { code: selection };
  return { file: doc.path };
}

let runSeq = 0;

/** Run the active Julia file (or selection) and stream output to the panel. */
export async function runActiveJulia(): Promise<void> {
  const state = useEditorStore.getState();
  const doc = getActiveDoc(state);
  const invocation = runInvocation(doc, state.selection);
  if (!doc || !invocation) return;
  // Refuse a second run while one is in progress (shared Output panel).
  if (useOutputStore.getState().running) return;

  const out = useOutputStore.getState();
  useLayoutStore.getState().showBottomTab("output");
  out.clear();

  if (!doc.path.toLowerCase().endsWith(".jl")) {
    out.append(`Run is Julia-only for now; "${doc.name}" is not a .jl file.`);
    return;
  }

  const id = `julia-${(runSeq += 1)}`;
  out.setRunning(true);
  out.setRunId(id);
  out.append(invocation.code ? "julia -e <selection>" : `julia ${doc.name}`);

  const offData = await listen<{ stream: string; line: string }>(
    `julia:output:${id}`,
    (event) =>
      useOutputStore
        .getState()
        .append(
          event.payload.stream === "stderr"
            ? `[stderr] ${event.payload.line}`
            : event.payload.line,
        ),
  );
  const offExit = await listen<number>(`julia:exit:${id}`, (event) => {
    const store = useOutputStore.getState();
    store.append(`[julia exited with code ${event.payload}]`);
    store.setRunning(false);
    store.setRunId(null);
    offData();
    offExit();
  });

  // Run a workspace-less file from its own directory rather than null cwd.
  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = invocation.file
    ? resolveTerminalCwd("currentFileDir", rootPath, doc.path)
    : rootPath;
  try {
    if (invocation.file) {
      await writeFile(doc.path, doc.content);
      // Record the exact bytes written so edits typed during the save keep the
      // doc dirty rather than being silently marked clean (and lost).
      useEditorStore.getState().markSaved(doc.path, doc.content);
    }
    await invoke("run_julia", {
      id,
      juliaPath: useSettingsStore.getState().settings.juliaPath || null,
      file: invocation.file ?? null,
      code: invocation.code ?? null,
      cwd,
    });
  } catch (e) {
    const store = useOutputStore.getState();
    const message = String(e);
    store.append(`failed to run julia: ${message}`);
    const missingMessage = missingJuliaMessage(message);
    if (missingMessage) store.append(missingMessage);
    store.setRunning(false);
    store.setRunId(null);
    offData();
    offExit();
  }
}

export function missingJuliaMessage(errorMessage: string): string | null {
  return /No such file|os error 2|not found|failed to start/i.test(errorMessage)
    ? [
        "Julia was not found. Install Julia or Juliaup,",
        "or set juliaPath in settings to the full Julia executable path",
        "(for example /Users/jake/.juliaup/bin/julia).",
      ].join(" ")
    : null;
}
