// LaTeX build orchestration (M11): run the configured `latexBuildCommand` in the
// workspace root, stream output to the Output panel, and on success open the
// produced PDF as an editor tab. Tauri-bound (smoke-tested); the output-path
// derivation it relies on (lib/latex.ts) is unit-tested.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../state/settingsStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useOutputStore } from "../state/outputStore";
import { useLayoutStore } from "../state/layoutStore";
import { getActiveDoc, isTextDoc, useEditorStore } from "../state/editorStore";
import { useTreeStore } from "../state/treeStore";
import { deleteFileIfExists, writeFile } from "./ipc";
import { isTexSourcePath } from "./fileTypes";
import {
  buildCommandForTexPath,
  deriveOutputPdf,
  LATEX_TOOL_ORDER,
  pdfPathForTexPath,
  selectLatexBuildCommand,
  shouldAutoSelectLatexTool,
  texBuildDirectory,
} from "./latex";

let buildSeq = 0;

export interface LatexBuildOptions {
  targetPath?: string | null;
  openOnSuccess?: boolean;
}

export async function runLatexBuild(
  options: LatexBuildOptions = {},
): Promise<void> {
  // Refuse a second run while one is in progress (shared Output panel).
  if (useOutputStore.getState().running) return;
  const configuredCommand =
    useSettingsStore.getState().settings.latexBuildCommand;
  const rootPath = useWorkspaceStore.getState().rootPath;
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
  const cwd = targetPath ? texBuildDirectory(targetPath) : rootPath;
  const out = useOutputStore.getState();
  useLayoutStore.getState().showBottomTab("output");
  out.clear();

  if (targetPath && !isTexSourcePath(targetPath)) {
    out.append("Open a .tex file before building LaTeX.");
    return;
  }
  if (!targetPath && !rootPath) {
    out.append("Open a folder before building LaTeX.");
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

  const command = targetPath
    ? await resolveLatexBuildCommand(configuredCommand, targetPath)
    : configuredCommand;
  const expectedPdfPath = expectedLatexPdfPath(command, targetPath, activeDoc?.path ?? null, rootPath);
  if (expectedPdfPath) {
    try {
      const removed = await deleteFileIfExists(expectedPdfPath);
      if (removed) {
        out.append(`[latex] removed stale ${expectedPdfPath}`);
        useTreeStore.getState().refresh();
      }
    } catch (e) {
      out.append(`failed to remove stale PDF ${expectedPdfPath}: ${String(e)}`);
      return;
    }
  }
  const id = `build-${(buildSeq += 1)}`;
  const activeTex = activeDoc?.path ?? null;
  out.setRunning(true);
  out.setRunId(id);
  out.append(`$ ${command}   (cwd: ${cwd ?? ""})`);

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
    const missingToolMessage = missingBuildToolMessage(command, event.payload);
    if (missingToolMessage) store.append(missingToolMessage);
    store.setRunning(false);
    store.setRunId(null);
    offData();
    offExit();
    if (event.payload === 0) {
      const pdfPath = expectedPdfPath ?? expectedLatexPdfPath(command, targetPath, activeTex, rootPath);
      if (pdfPath) {
        useTreeStore.getState().refresh();
        store.append(`[latex] wrote ${pdfPath}`);
        if (openOnSuccess) {
          useEditorStore.getState().closeDoc(pdfPath);
          useWorkspaceStore.getState().requestOpenFile(pdfPath);
          useLayoutStore.getState().setPdfPanelVisible(false);
        }
      }
    }
  });

  try {
    await invoke("run_build", { id, command, cwd });
  } catch (e) {
    const store = useOutputStore.getState();
    store.append(`failed to run build: ${String(e)}`);
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

export async function resolveLatexBuildCommand(
  configuredCommand: string,
  texPath: string,
): Promise<string> {
  if (!shouldAutoSelectLatexTool(configuredCommand)) {
    return buildCommandForTexPath(configuredCommand, texPath);
  }
  const availableTools: string[] = [];
  for (const tool of LATEX_TOOL_ORDER) {
    if (await programAvailable(tool)) availableTools.push(tool);
  }
  return selectLatexBuildCommand(configuredCommand, texPath, availableTools);
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

async function programAvailable(program: string): Promise<boolean> {
  try {
    return await invoke<boolean>("program_available", { program });
  } catch {
    return false;
  }
}
