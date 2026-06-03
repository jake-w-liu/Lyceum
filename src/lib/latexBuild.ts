// LaTeX build orchestration (M11): run the configured `latexBuildCommand` in the
// workspace root, stream output to the Output panel, and on success open the
// produced PDF in the preview panel. Tauri-bound (smoke-tested); the output-path
// derivation it relies on (lib/latex.ts) is unit-tested.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../state/settingsStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useOutputStore } from "../state/outputStore";
import { useLayoutStore } from "../state/layoutStore";
import { usePreviewStore } from "../state/previewStore";
import { getActiveDoc, useEditorStore } from "../state/editorStore";
import { deriveOutputPdf } from "./latex";

let buildSeq = 0;

export async function runLatexBuild(): Promise<void> {
  // Refuse a second run while one is in progress (shared Output panel).
  if (useOutputStore.getState().running) return;
  const command = useSettingsStore.getState().settings.latexBuildCommand;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const out = useOutputStore.getState();
  useLayoutStore.getState().showBottomTab("output");
  out.clear();

  if (!rootPath) {
    out.append("Open a folder before building LaTeX.");
    return;
  }
  if (!command.trim()) {
    out.append("No latexBuildCommand configured (see settings).");
    return;
  }

  const id = `build-${(buildSeq += 1)}`;
  const activeTex = getActiveDoc(useEditorStore.getState())?.path ?? null;
  out.setRunning(true);
  out.append(`$ ${command}   (cwd: ${rootPath})`);

  const offData = await listen<{ stream: string; line: string }>(
    `build:output:${id}`,
    (event) =>
      useOutputStore
        .getState()
        .append(
          event.payload.stream === "stderr"
            ? `[stderr] ${event.payload.line}`
            : event.payload.line,
        ),
  );
  const offExit = await listen<number>(`build:exit:${id}`, (event) => {
    const store = useOutputStore.getState();
    store.append(`[build exited with code ${event.payload}]`);
    store.setRunning(false);
    offData();
    offExit();
    if (event.payload === 0) {
      const pdf = deriveOutputPdf(command, activeTex);
      if (pdf) {
        usePreviewStore.getState().openPdf(`${rootPath}/${pdf}`);
        useLayoutStore.getState().setPdfPanelVisible(true);
      }
    }
  });

  try {
    await invoke("run_build", { id, command, cwd: rootPath });
  } catch (e) {
    const store = useOutputStore.getState();
    store.append(`failed to run build: ${String(e)}`);
    store.setRunning(false);
    offData();
    offExit();
  }
}
