// Built-in command registrations (M4). Importing this module registers every
// workbench action as a command (id -> run). Keybindings and the command
// palette dispatch these ids; they never call behavior directly.

import { commandRegistry } from "./commandRegistry";
import { useLayoutStore } from "../state/layoutStore";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pickFolder, quitApp } from "../lib/ipc";
import {
  closeActiveTab,
  focusAdjacentTab,
  saveActiveDoc,
  saveAllDocs,
} from "../hooks/useEditorKeybindings";
import { hasDirtyWorkspaceDocs } from "../hooks/useWorkspaceLifecycle";
import { THEME_LABELS, THEME_ORDER, useThemeStore } from "../state/themeStore";
import { useTerminalStore } from "../state/terminalStore";
import {
  askDiscard,
  flushPendingEdits,
  getActiveDoc,
  useEditorStore,
} from "../state/editorStore";
import { usePreviewStore } from "../state/previewStore";
import { newWindow } from "../lib/ipc";
import { runActiveCode } from "../lib/codeRun";
import { runLatexBuild } from "../lib/latexBuild";
import { stopActiveRun } from "../lib/run";
import {
  flushSettingsPersistence,
  saveSettings,
  settingsFilePath,
} from "../lib/settingsPersistence";
import { runEditorAction } from "../lib/editorBridge";
import { useTreeStore } from "../state/treeStore";
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  useSettingsStore,
} from "../state/settingsStore";
import { writePty } from "../lib/terminal";
import { isInlinePreviewPath, isTexSourcePath, relativePath } from "../lib/fileTypes";

let registered = false;

const STARTUP_COMMAND_SAFE_RE = /^[A-Za-z0-9_./:@%+=,-]+$/;

function isPowerShellShell(shellPath: string): boolean {
  const normalized = shellPath.replace(/\\/g, "/").trim().toLowerCase();
  return (
    normalized.endsWith("/powershell.exe") ||
    normalized.endsWith("/pwsh.exe") ||
    normalized.endsWith("/pwsh") ||
    normalized.endsWith("/powershell")
  );
}

function looksLikeWindowsProgramPath(program: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(program) || program.includes("\\");
}

function quoteStartupCommand(program: string, shellPath: string): string {
  if (STARTUP_COMMAND_SAFE_RE.test(program)) return program;
  if (!shellPath && looksLikeWindowsProgramPath(program)) {
    return `& '${program.replace(/'/g, "''")}'`;
  }
  if (isPowerShellShell(shellPath)) {
    return `& '${program.replace(/'/g, "''")}'`;
  }
  return `"${program.replace(/(["$`])/g, "\\$1")}"`;
}

/** Idempotently register all built-in commands. */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  const layout = () => useLayoutStore.getState();
  const ui = () => useUiStore.getState();

  commandRegistry.register({
    id: "app.newWindow",
    title: "New Window",
    category: "Window",
    run: () => newWindow(),
  });
  // Quit via the native menu (the Rust menu handler emits menu id "quit").
  // Mirrors the window-close guard: confirm discarding unsaved changes first.
  commandRegistry.register({
    id: "quit",
    title: "Quit Lyceum",
    category: "Window",
    run: async () => {
      if (
        hasDirtyWorkspaceDocs() &&
        !(await askDiscard("Discard unsaved changes and quit?"))
      ) {
        return;
      }
      await flushSettingsPersistence();
      await quitApp();
    },
  });
  commandRegistry.register({
    id: "quickOpen.show",
    title: "Go to File…",
    category: "File",
    run: () => ui().openModal("quickOpen"),
  });
  commandRegistry.register({
    id: "commandPalette.show",
    title: "Show All Commands",
    category: "View",
    run: () => ui().openModal("palette"),
  });
  commandRegistry.register({
    id: "file.openFolder",
    title: "Open Folder…",
    category: "File",
    run: async () => {
      const path = await pickFolder();
      if (path) useWorkspaceStore.getState().openWorkspace(path);
    },
  });
  commandRegistry.register({
    id: "file.save",
    title: "Save",
    category: "File",
    run: () => saveActiveDoc(),
  });
  commandRegistry.register({
    id: "file.saveAll",
    title: "Save All",
    category: "File",
    run: () => saveAllDocs(),
  });
  commandRegistry.register({
    id: "file.openSettings",
    title: "Open Settings (JSON)",
    category: "File",
    run: async () => {
      await saveSettings(); // ensure the file exists before opening it
      useWorkspaceStore.getState().requestOpenFile(await settingsFilePath());
    },
  });
  commandRegistry.register({
    id: "editor.closeTab",
    title: "Close Editor",
    category: "Editor",
    run: () => closeActiveTab(),
  });
  commandRegistry.register({
    id: "editor.nextTab",
    title: "Next Editor",
    category: "Editor",
    run: () => focusAdjacentTab(1),
  });
  commandRegistry.register({
    id: "editor.previousTab",
    title: "Previous Editor",
    category: "Editor",
    run: () => focusAdjacentTab(-1),
  });
  commandRegistry.register({
    id: "editor.closeOthers",
    title: "Close Other Editors",
    category: "Editor",
    run: () => {
      const active = useEditorStore.getState().activePath;
      if (active) useEditorStore.getState().closeOtherDocs(active);
    },
  });
  commandRegistry.register({
    id: "editor.closeToRight",
    title: "Close Editors to the Right",
    category: "Editor",
    run: () => {
      const active = useEditorStore.getState().activePath;
      if (active) useEditorStore.getState().closeDocsToRight(active);
    },
  });
  commandRegistry.register({
    id: "editor.closeSaved",
    title: "Close Saved Editors",
    category: "Editor",
    run: () => useEditorStore.getState().closeSavedDocs(),
  });
  commandRegistry.register({
    id: "editor.closeAll",
    title: "Close All Editors",
    category: "Editor",
    run: () => useEditorStore.getState().closeAllDocs(),
  });
  commandRegistry.register({
    id: "workbench.toggleSidebar",
    title: "Toggle Sidebar",
    category: "View",
    run: () => layout().toggleSidebar(),
  });
  commandRegistry.register({
    id: "workbench.toggleBottomPanel",
    title: "Toggle Panel",
    category: "View",
    run: () => layout().toggleBottomPanel(),
  });
  commandRegistry.register({
    id: "terminal.toggle",
    title: "Toggle Terminal",
    category: "Terminal",
    run: () => layout().toggleTerminal(),
  });
  commandRegistry.register({
    id: "workbench.togglePanelPosition",
    title: "Toggle Panel Position (Bottom / Right)",
    category: "View",
    run: () => layout().togglePanelPosition(),
  });
  commandRegistry.register({
    id: "terminal.new",
    title: "New Terminal",
    category: "Terminal",
    run: () => {
      useTerminalStore
        .getState()
        .createTerminal(useWorkspaceStore.getState().rootPath);
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "preview.open",
    title: "Open Preview",
    category: "View",
    run: () => {
      const doc = getActiveDoc(useEditorStore.getState());
      const preview = usePreviewStore.getState();
      if (doc && isInlinePreviewPath(doc.path)) {
        // Markdown/HTML previews render in place, replacing the editor view.
        layout().toggleEditorPreview();
      } else if (doc && doc.kind === "text" && isTexSourcePath(doc.path)) {
        void runLatexBuild({ targetPath: doc.path, openOnSuccess: true });
      } else if (doc && (doc.kind === "pdf" || doc.kind === "image")) {
        // PDF/image files are already rendered directly in their editor tab.
        preview.closePreview();
        layout().setPdfPanelVisible(false);
      }
    },
  });
  commandRegistry.register({
    id: "latex.build",
    title: "Compile LaTeX",
    category: "Run",
    run: () => runLatexBuild({ openOnSuccess: false }),
  });
  commandRegistry.register({
    id: "editor.run",
    title: "Run File or Selection",
    category: "Run",
    run: () => {
      // runActiveCode saves the buffer before running; make sure the store
      // holds the latest editor content first.
      flushPendingEdits();
      return runActiveCode();
    },
  });
  commandRegistry.register({
    id: "run.stop",
    title: "Stop Running Process",
    category: "Run",
    run: () => stopActiveRun(),
  });
  commandRegistry.register({
    id: "workbench.dismiss",
    title: "Dismiss",
    category: "View",
    run: () => ui().closeModal(),
  });

  commandRegistry.register({
    id: "workbench.cycleTheme",
    title: "Cycle Color Theme",
    category: "View",
    run: () => useThemeStore.getState().cycleTheme(),
  });

  commandRegistry.register({
    id: "editor.toggleWordWrap",
    title: "Toggle Word Wrap",
    category: "View",
    run: () => {
      const { settings, setSetting } = useSettingsStore.getState();
      setSetting("wordWrap", settings.wordWrap === "off" ? "on" : "off");
    },
  });

  // --- Window zoom (Cmd/Ctrl + = / - / 0), VS Code-style: scales the WHOLE UI
  // (explorer, tabs, terminal, editor) via the native webview zoom. The level is
  // persisted in settings; lib/zoom applies it to the webview when it changes. ---
  const adjustZoom = (delta: number) => {
    const { settings, setSetting } = useSettingsStore.getState();
    const next = Math.min(
      ZOOM_LEVEL_MAX,
      Math.max(ZOOM_LEVEL_MIN, settings.zoomLevel + delta),
    );
    if (next !== settings.zoomLevel) setSetting("zoomLevel", next);
  };
  commandRegistry.register({
    id: "view.zoomIn",
    title: "Zoom In",
    category: "View",
    run: () => adjustZoom(1),
  });
  commandRegistry.register({
    id: "view.zoomOut",
    title: "Zoom Out",
    category: "View",
    run: () => adjustZoom(-1),
  });
  commandRegistry.register({
    id: "view.resetZoom",
    title: "Reset Zoom",
    category: "View",
    run: () =>
      useSettingsStore
        .getState()
        .setSetting("zoomLevel", DEFAULT_SETTINGS.zoomLevel),
  });
  for (const t of THEME_ORDER) {
    commandRegistry.register({
      id: `workbench.theme.${t}`,
      title: `Color Theme: ${THEME_LABELS[t]}`,
      category: "View",
      run: () => useThemeStore.getState().setTheme(t),
    });
  }

  // --- Editor actions (delegated to the active Monaco instance) ---
  commandRegistry.register({
    id: "editor.formatDocument",
    title: "Format Document",
    category: "Editor",
    run: () => runEditorAction("editor.action.formatDocument"),
  });
  commandRegistry.register({
    id: "editor.goToLine",
    title: "Go to Line…",
    category: "Go",
    run: () => runEditorAction("editor.action.gotoLine"),
  });
  commandRegistry.register({
    id: "editor.renameSymbol",
    title: "Rename Symbol",
    category: "Editor",
    run: () => runEditorAction("editor.action.rename"),
  });
  commandRegistry.register({
    id: "editor.goToSymbol",
    title: "Go to Symbol in Editor…",
    category: "Go",
    run: () => runEditorAction("editor.action.quickOutline"),
  });

  // --- Workspace search ---
  commandRegistry.register({
    id: "workbench.searchWorkspace",
    title: "Find in Files",
    category: "View",
    run: () => {
      layout().setSidebarVisible(true);
      layout().setActiveView("search");
    },
  });

  // --- Explorer ---
  const revealExplorer = () => {
    layout().setSidebarVisible(true);
    layout().setActiveView("explorer");
  };
  const startExplorerCreate = (kind: "file" | "folder") => {
    revealExplorer();
    // A folder must be open to create into; otherwise the Explorer shows the
    // "Open Folder" placeholder and there is nowhere to put the new entry.
    if (!useWorkspaceStore.getState().rootPath) return;
    useTreeStore.getState().requestCreate(kind);
  };
  // Copy Path / Copy Relative Path: target the Explorer's selected entry, else
  // the active editor document. Clipboard write is best-effort.
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  };
  const pathCommandTarget = (): string | null => {
    const selected = useTreeStore.getState().selectedPaths;
    if (selected.length > 0) return selected[selected.length - 1];
    return getActiveDoc(useEditorStore.getState())?.path ?? null;
  };
  commandRegistry.register({
    id: "file.copyPath",
    title: "Copy Path",
    category: "File",
    run: () => {
      const path = pathCommandTarget();
      if (path) void copyToClipboard(path);
    },
  });
  commandRegistry.register({
    id: "file.copyRelativePath",
    title: "Copy Relative Path",
    category: "File",
    run: () => {
      const path = pathCommandTarget();
      if (!path) return;
      const root = useWorkspaceStore.getState().rootPath;
      void copyToClipboard(root ? relativePath(root, path) : path);
    },
  });
  commandRegistry.register({
    id: "explorer.newFile",
    title: "New File",
    category: "File",
    run: () => startExplorerCreate("file"),
  });
  commandRegistry.register({
    id: "explorer.newFolder",
    title: "New Folder",
    category: "File",
    run: () => startExplorerCreate("folder"),
  });
  commandRegistry.register({
    id: "explorer.refresh",
    title: "Refresh Explorer",
    category: "File",
    run: () => useTreeStore.getState().refresh(),
  });
  commandRegistry.register({
    id: "explorer.collapseAll",
    title: "Collapse Folders in Explorer",
    category: "File",
    run: () => useTreeStore.getState().collapseAll(),
  });
  commandRegistry.register({
    id: "explorer.revealActiveFile",
    title: "Reveal Active File in Explorer",
    category: "File",
    run: () => {
      const doc = getActiveDoc(useEditorStore.getState());
      const root = useWorkspaceStore.getState().rootPath;
      if (doc && root && doc.path.startsWith(root)) {
        const rel = doc.path.slice(root.length).replace(/^[/\\]/, "");
        const segments = rel.split(/[/\\]/).slice(0, -1);
        // Tree node keys use the backend's native separator ("\" on Windows), so
        // rebuild ancestor keys with the separator the path already uses — a
        // hard-coded "/" would never match a "\"-keyed node, so the containing
        // folders would not expand on Windows.
        const sep = root.includes("\\") ? "\\" : "/";
        const ancestors = [root];
        let cur = root;
        for (const segment of segments) {
          cur = `${cur}${sep}${segment}`;
          ancestors.push(cur);
        }
        useTreeStore.getState().expandPaths(ancestors);
      }
      layout().setSidebarVisible(true);
      layout().setActiveView("explorer");
    },
  });

  // --- REPL profiles + send-to-terminal ---
  commandRegistry.register({
    id: "julia.repl",
    title: "New Julia REPL",
    category: "Run",
    run: () => {
      const settings = useSettingsStore.getState().settings;
      const juliaRuntimePath = settings.runtimePaths.julia || "julia";
      const root = useWorkspaceStore.getState().rootPath;
      useTerminalStore.getState().createTerminal(root, {
        title: "Julia REPL",
        startupCommand: `${quoteStartupCommand(juliaRuntimePath, settings.shellPath)}\r`,
      });
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "python.repl",
    title: "New Python REPL",
    category: "Run",
    run: () => {
      const settings = useSettingsStore.getState().settings;
      const pythonPath = settings.runtimePaths.python || "python3";
      const root = useWorkspaceStore.getState().rootPath;
      useTerminalStore.getState().createTerminal(root, {
        title: "Python REPL",
        startupCommand: `${quoteStartupCommand(pythonPath, settings.shellPath)}\r`,
      });
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "node.repl",
    title: "New Node REPL",
    category: "Run",
    run: () => {
      const settings = useSettingsStore.getState().settings;
      const nodePath = settings.runtimePaths.node || "node";
      const root = useWorkspaceStore.getState().rootPath;
      useTerminalStore.getState().createTerminal(root, {
        title: "Node REPL",
        startupCommand: `${quoteStartupCommand(nodePath, settings.shellPath)}\r`,
      });
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "terminal.runSelection",
    title: "Send Selection to Terminal",
    category: "Run",
    run: () => {
      const selection = useEditorStore.getState().selection;
      const { activeId, terminals } = useTerminalStore.getState();
      const backendPtyId =
        terminals.find((terminal) => terminal.id === activeId)?.backendPtyId ??
        null;
      if (backendPtyId && selection.trim()) {
        void writePty(
          backendPtyId,
          selection.endsWith("\n") ? selection : `${selection}\n`,
        );
      }
    },
  });
}

registerBuiltinCommands();
