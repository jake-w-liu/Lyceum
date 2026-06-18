// Generic run-file / run-selection orchestration.
//
// `runInvocation` is pure and decides which configured profile applies to the
// active text document. `runActiveCode` saves whole-file runs, streams process
// output into the Output panel, and leaves unsupported languages explicit.

import { invoke } from "@tauri-apps/api/core";
import { listenScoped } from "./windowEvents";
import {
  flushPendingEdits,
  getActiveDoc,
  isTextDoc,
  useEditorStore,
  type EditorDoc,
} from "../state/editorStore";
import {
  appendOutputBuffered,
  flushOutputBuffer,
  useOutputStore,
} from "../state/outputStore";
import { useLayoutStore } from "../state/layoutStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useSettingsStore, type Settings } from "../state/settingsStore";
import { resolveTerminalCwd } from "./terminalCwd";
import { writeFile } from "./ipc";
import {
  buildRunProfileCommand,
  missingRuntimeMessage,
  type RunProfileCommand,
} from "./runProfiles";

export interface RunInvocation {
  file?: string;
  code?: string;
  command: RunProfileCommand;
}

/** Decide what to run: a non-empty selection runs as code, else the file. */
export function runInvocation(
  doc: EditorDoc | null,
  selection: string,
  settings: Settings,
): RunInvocation | null {
  if (!doc || !isTextDoc(doc)) return null;
  const command = buildRunProfileCommand(doc, selection, settings);
  if (!command) return null;
  return { file: command.file, code: command.code, command };
}

let runSeq = 0;

function normalizePathForCompare(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "") || normalized;
}

function isSameOrDescendant(path: string, root: string): boolean {
  const p = normalizePathForCompare(path);
  const r = normalizePathForCompare(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

function authorizedRunCwd(rootPath: string | null, docPath: string): string | null {
  if (!rootPath || !isSameOrDescendant(docPath, rootPath)) return null;
  return resolveTerminalCwd("currentFileDir", rootPath, docPath);
}

/** Run the active file or selection using the matching built-in run profile. */
export async function runActiveCode(): Promise<void> {
  // Commit any debounced editor->store write so we save/run the live buffer,
  // not a <=150ms-stale snapshot.
  flushPendingEdits();
  const state = useEditorStore.getState();
  const doc = getActiveDoc(state);
  if (!doc || !isTextDoc(doc)) return;
  // Refuse a second run while one is in progress (shared Output panel).
  if (useOutputStore.getState().running) return;

  const out = useOutputStore.getState();
  useLayoutStore.getState().showBottomTab("output");
  out.clear();

  const invocation = runInvocation(
    doc,
    state.selection,
    useSettingsStore.getState().settings,
  );
  if (!invocation) {
    out.append(
      `No built-in run profile for "${doc.name}" (${doc.language}). Use Send Selection to Terminal or configure an external terminal workflow.`,
    );
    return;
  }

  const { command } = invocation;
  const id = `run-${command.profile.id}-${(runSeq += 1)}`;
  out.setRunning(true);
  out.setRunId(id);
  out.append(command.display);

  // The run is already claimed (running=true above); from here every failure
  // path must release it, including listenScoped rejecting.
  let offData: (() => void) | null = null;
  let offExit: (() => void) | null = null;
  const releaseRun = () => {
    const store = useOutputStore.getState();
    store.setRunning(false);
    store.setRunId(null);
    offData?.();
    offExit?.();
  };

  try {
    offData = await listenScoped<{ stream: string; line: string }>(
      `run:output:${id}`,
      (event) =>
        appendOutputBuffered(
          event.payload.stream === "stderr"
            ? `[stderr] ${event.payload.line}`
            : event.payload.line,
        ),
    );
    offExit = await listenScoped<number>(`run:exit:${id}`, (event) => {
      flushOutputBuffer();
      useOutputStore
        .getState()
        .append(`[${command.profile.label} exited with code ${event.payload}]`);
      releaseRun();
    });

    const rootPath = useWorkspaceStore.getState().rootPath;
    const cwd = authorizedRunCwd(rootPath, doc.path);
    if (invocation.file) {
      await writeFile(doc.path, doc.content);
      // Record the exact bytes written so edits typed during the save keep the
      // doc dirty rather than being silently marked clean.
      useEditorStore.getState().markSaved(doc.path, doc.content);
    }
    await invoke("run_process", {
      request: {
        id,
        profileId: command.profile.id,
        program: command.program,
        fallbackPrograms: command.fallbackPrograms,
        args: command.args,
        cwd,
      },
    });
  } catch (e) {
    const store = useOutputStore.getState();
    const message = String(e);
    store.append(`failed to run ${command.profile.label}: ${message}`);
    const missingMessage = missingRuntimeMessage(command.profile, message);
    if (missingMessage) store.append(missingMessage);
    releaseRun();
  }
}
