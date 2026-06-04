// LaTeX build orchestration (M11): save the active `.tex` buffer, ask the Rust
// builder to compile it, stream output to the Output panel, and on success open
// the produced PDF as an editor tab.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../state/settingsStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useOutputStore } from "../state/outputStore";
import { useLayoutStore } from "../state/layoutStore";
import { getActiveDoc, isTextDoc, useEditorStore } from "../state/editorStore";
import { useTreeStore } from "../state/treeStore";
import { writeFile } from "./ipc";
import { isTexSourcePath } from "./fileTypes";
import {
  deriveOutputPdf,
  pdfPathForTexPath,
} from "./latex";

let buildSeq = 0;

export interface LatexBuildOptions {
  targetPath?: string | null;
  openOnSuccess?: boolean;
}

interface LatexBuildPlan {
  command: string;
  cwd: string;
  pdfPath: string;
  removedStalePdf: boolean;
  tool: string;
  source: string;
}

export async function runLatexBuild(
  options: LatexBuildOptions = {},
): Promise<void> {
  // Refuse a second run while one is in progress (shared Output panel).
  if (useOutputStore.getState().running) return;
  const configuredCommand =
    useSettingsStore.getState().settings.latexBuildCommand;
  const editor = useEditorStore.getState();
  const activeDoc = getActiveDoc(editor);
  const targetPath =
    options.targetPath ??
    (activeDoc && isTextDoc(activeDoc) && isTexSourcePath(activeDoc.path)
      ? activeDoc.path
      : null);
  const targetDoc = targetPath
    ? editor.docs.find((doc) => doc.path === targetPath && isTextDoc(doc))
    : null;
  const openOnSuccess = options.openOnSuccess === true;
  const out = useOutputStore.getState();
  useLayoutStore.getState().showBottomTab("output");
  out.clear();

  if (!targetPath || !isTexSourcePath(targetPath)) {
    out.append("Open a .tex file before building LaTeX.");
    return;
  }
  if (!configuredCommand.trim()) {
    out.append("No latexBuildCommand configured (see settings).");
    return;
  }
  if (targetDoc) {
    try {
      await writeFile(targetDoc.path, targetDoc.content);
      useEditorStore.getState().markSaved(targetDoc.path);
    } catch (e) {
      out.append(`failed to save ${targetDoc.name}: ${String(e)}`);
      return;
    }
  }

  const id = `build-${(buildSeq += 1)}`;
  let pdfPathForSuccess = pdfPathForTexPath(targetPath);
  let commandForMessages = configuredCommand;
  out.setRunning(true);
  out.setRunId(id);

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
    const missingToolMessage = missingBuildToolMessage(
      commandForMessages,
      event.payload,
    );
    if (missingToolMessage) store.append(missingToolMessage);
    store.setRunning(false);
    store.setRunId(null);
    offData();
    offExit();
    if (event.payload === 0) {
      useTreeStore.getState().refresh();
      store.append(`[latex] wrote ${pdfPathForSuccess}`);
      if (openOnSuccess) {
        useEditorStore.getState().closeDoc(pdfPathForSuccess);
        useWorkspaceStore.getState().requestOpenFile(pdfPathForSuccess);
        useLayoutStore.getState().setPdfPanelVisible(false);
      }
    }
  });

  try {
    const plan = await invoke<LatexBuildPlan>("run_latex_build", {
      id,
      texPath: targetPath,
      configuredCommand,
    });
    commandForMessages = plan.command;
    if (plan.pdfPath.trim()) {
      pdfPathForSuccess = plan.pdfPath;
    }
    if (plan.removedStalePdf) {
      useTreeStore.getState().refresh();
    }
  } catch (e) {
    const store = useOutputStore.getState();
    store.append(cleanInvokeError(e));
    store.setRunning(false);
    store.setRunId(null);
    offData();
    offExit();
  }
}

export function expectedLatexPdfPath(
  command: string,
  targetPath: string | null,
  activeTexPath: string | null,
  rootPath: string | null,
): string | null {
  if (targetPath) return pdfPathForTexPath(targetPath);
  const pdf = deriveOutputPdf(command, activeTexPath);
  return pdf && rootPath ? `${rootPath}/${pdf}` : null;
}

export function missingBuildToolMessage(
  command: string,
  exitCode: number,
): string | null {
  if (exitCode !== 127) return null;
  const tool = firstCommandToken(command);
  if (!tool) return null;
  if (tool === "latexmk") {
    return [
      'latexmk was not found. Install a TeX distribution that includes latexmk (for example MacTeX or BasicTeX),',
      "or set latexBuildCommand in settings to an installed LaTeX compiler path.",
    ].join(" ");
  }
  return `Build command was not found: ${tool}. Install it or set latexBuildCommand to an absolute path.`;
}

function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  if (!raw) return null;
  return raw.split(/[\\/]/).pop() ?? raw;
}

function cleanInvokeError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}
