import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "./builtinCommands";
import { commandRegistry } from "./commandRegistry";
import { DEFAULT_KEYMAP } from "../keybindings/keybindingRegistry";
import { initialTerminalData, useTerminalStore } from "../state/terminalStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialThemeData, useThemeStore } from "../state/themeStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";
import { initialSettingsData, useSettingsStore } from "../state/settingsStore";

const runLatexBuildMock = vi.hoisted(() => vi.fn());
const runActiveCodeMock = vi.hoisted(() => vi.fn());
const writePtyMock = vi.hoisted(() => vi.fn());
const persistenceMock = vi.hoisted(() => ({
  flushSettingsPersistence: vi.fn(async (): Promise<void> => undefined),
  saveSettings: vi.fn(async (): Promise<void> => undefined),
  settingsFilePath: vi.fn(async (): Promise<string> => "/config/settings.json"),
}));
const invokeMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const askMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock("../lib/latexBuild", () => ({
  runLatexBuild: (...args: unknown[]) => runLatexBuildMock(...args),
}));
vi.mock("../lib/codeRun", () => ({
  runActiveCode: (...args: unknown[]) => runActiveCodeMock(...args),
}));
vi.mock("../lib/terminal", () => ({
  writePty: (...args: unknown[]) => writePtyMock(...args),
}));
vi.mock("../lib/settingsPersistence", () => ({
  flushSettingsPersistence: () => persistenceMock.flushSettingsPersistence(),
  saveSettings: () => persistenceMock.saveSettings(),
  settingsFilePath: () => persistenceMock.settingsFilePath(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => askMock(...args),
  open: vi.fn(),
}));

beforeEach(() => {
  registerBuiltinCommands(); // idempotent; ensures the registry is populated
  useTerminalStore.setState(initialTerminalData, false);
  useLayoutStore.setState(initialLayoutData, false);
  useThemeStore.setState(initialThemeData, false);
  useEditorStore.setState(initialEditorData, false);
  usePreviewStore.setState(initialPreviewData, false);
  useSettingsStore.setState(initialSettingsData, false);
  runLatexBuildMock.mockClear();
  runActiveCodeMock.mockClear();
  writePtyMock.mockClear();
  persistenceMock.flushSettingsPersistence.mockClear();
  persistenceMock.flushSettingsPersistence.mockResolvedValue(undefined);
  persistenceMock.saveSettings.mockClear();
  persistenceMock.saveSettings.mockResolvedValue(undefined);
  persistenceMock.settingsFilePath.mockClear();
  persistenceMock.settingsFilePath.mockResolvedValue("/config/settings.json");
  invokeMock.mockClear();
  askMock.mockReset().mockResolvedValue(true);
});

describe("builtinCommands", () => {
  it("terminal.new creates a terminal and reveals the terminal panel", async () => {
    expect(useTerminalStore.getState().terminals).toHaveLength(0);
    await commandRegistry.execute("terminal.new");
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(useLayoutStore.getState().bottomPanelVisible).toBe(true);
    expect(useLayoutStore.getState().activeBottomTab).toBe("terminal");
  });

  it("workbench.toggleSidebar toggles the sidebar", async () => {
    const before = useLayoutStore.getState().sidebarVisible;
    await commandRegistry.execute("workbench.toggleSidebar");
    expect(useLayoutStore.getState().sidebarVisible).toBe(!before);
  });

  it("workbench.cycleTheme advances the active theme", async () => {
    expect(useThemeStore.getState().theme).toBe("dark");
    await commandRegistry.execute("workbench.cycleTheme");
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("preview.open toggles inline preview for HTML documents", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/index.html",
      content: "<h1>hi</h1>",
      language: "html",
    });

    await commandRegistry.execute("preview.open");

    expect(useLayoutStore.getState().editorPreview).toBe(true);
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().imagePath).toBeNull();
  });

  it("preview.open keeps PDF/image viewer tabs in the editor area", async () => {
    useLayoutStore.getState().setPdfPanelVisible(true);
    usePreviewStore.getState().openPdf("/old/side-panel.pdf");
    useEditorStore.getState().openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });

    await commandRegistry.execute("preview.open");

    expect(useEditorStore.getState().activePath).toBe("/w/paper.pdf");
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
  });

  it("preview.open builds the active LaTeX file", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await commandRegistry.execute("preview.open");

    expect(runLatexBuildMock).toHaveBeenCalledWith({
      targetPath: "/w/paper.tex",
      openOnSuccess: true,
    });
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
  });

  it("latex.build compiles the active LaTeX file without opening preview", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await commandRegistry.execute("latex.build");

    expect(runLatexBuildMock).toHaveBeenCalledWith({ openOnSuccess: false });
  });

  it("editor.run dispatches the generic code runner", async () => {
    await commandRegistry.execute("editor.run");
    expect(runActiveCodeMock).toHaveBeenCalledOnce();
  });

  it("julia.repl opens a Julia terminal profile", async () => {
    await commandRegistry.execute("julia.repl");
    expect(useTerminalStore.getState().terminals).toMatchObject([
      { title: "Julia REPL", startupCommand: "julia\r" },
    ]);
    expect(useLayoutStore.getState().activeBottomTab).toBe("terminal");
  });

  it("python.repl opens a Python terminal profile", async () => {
    await commandRegistry.execute("python.repl");
    expect(useTerminalStore.getState().terminals).toMatchObject([
      { title: "Python REPL", startupCommand: "python3\r" },
    ]);
    expect(useLayoutStore.getState().activeBottomTab).toBe("terminal");
  });

  it("node.repl opens a Node terminal profile", async () => {
    await commandRegistry.execute("node.repl");
    expect(useTerminalStore.getState().terminals).toMatchObject([
      { title: "Node REPL", startupCommand: "node\r" },
    ]);
    expect(useLayoutStore.getState().activeBottomTab).toBe("terminal");
  });

  it("python.repl uses PowerShell call syntax for a Windows path with spaces", async () => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.getState().replaceAll({
      ...current,
      shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      runtimePaths: {
        ...current.runtimePaths,
        python: "C:\\Program Files\\Python312\\python.exe",
      },
    });

    await commandRegistry.execute("python.repl");

    expect(useTerminalStore.getState().terminals).toMatchObject([
      {
        title: "Python REPL",
        startupCommand: "& 'C:\\Program Files\\Python312\\python.exe'\r",
      },
    ]);
  });

  it("python.repl keeps cmd-compatible quoting when the shell is cmd.exe", async () => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.getState().replaceAll({
      ...current,
      shellPath: "C:\\Windows\\System32\\cmd.exe",
      runtimePaths: {
        ...current.runtimePaths,
        python: "C:\\Program Files\\Python312\\python.exe",
      },
    });

    await commandRegistry.execute("python.repl");

    expect(useTerminalStore.getState().terminals).toMatchObject([
      {
        title: "Python REPL",
        startupCommand: "\"C:\\Program Files\\Python312\\python.exe\"\r",
      },
    ]);
  });

  it("terminal.runSelection writes to the live backend PTY id", async () => {
    const id = useTerminalStore.getState().createTerminal();
    useTerminalStore.getState().setBackendPtyId(id, "term-1_9");
    useEditorStore.getState().setSelection("x = 1");

    await commandRegistry.execute("terminal.runSelection");

    expect(writePtyMock).toHaveBeenCalledWith("term-1_9", "x = 1\n");
  });

  it("terminal.runSelection no-ops while the terminal PTY is not mounted", async () => {
    useTerminalStore.getState().createTerminal();
    useEditorStore.getState().setSelection("x = 1");

    await commandRegistry.execute("terminal.runSelection");

    expect(writePtyMock).not.toHaveBeenCalled();
  });

  it("preview.open is a no-op for unsupported active files", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "console.log(1)",
      language: "typescript",
    });

    await commandRegistry.execute("preview.open");

    expect(useLayoutStore.getState().editorPreview).toBe(false);
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().imagePath).toBeNull();
  });

  describe("quit", () => {
    it("flushes settings before invoking quit_app when no docs are dirty", async () => {
      await commandRegistry.execute("quit");
      expect(persistenceMock.flushSettingsPersistence).toHaveBeenCalledTimes(1);
      expect(askMock).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("quit_app");
    });

    it("awaits settings flush before invoking quit_app", async () => {
      let resolveFlush: (() => void) | undefined;
      persistenceMock.flushSettingsPersistence.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
      );

      const quit = commandRegistry.execute("quit");
      await Promise.resolve();

      expect(persistenceMock.flushSettingsPersistence).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalledWith("quit_app");

      resolveFlush?.();
      await quit;

      expect(invokeMock).toHaveBeenCalledWith("quit_app");
    });

    it("asks before quitting with dirty docs and aborts when declined", async () => {
      useEditorStore.getState().openDoc({
        path: "/w/a.ts",
        content: "a",
        language: "typescript",
      });
      useEditorStore.getState().updateContent("/w/a.ts", "dirty");
      askMock.mockResolvedValue(false);

      await commandRegistry.execute("quit");

      expect(askMock).toHaveBeenCalledWith(
        "Discard unsaved changes and quit?",
        expect.anything(),
      );
      expect(persistenceMock.flushSettingsPersistence).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("quit_app");
    });

    it("quits when discarding dirty docs is confirmed", async () => {
      useEditorStore.getState().openDoc({
        path: "/w/a.ts",
        content: "a",
        language: "typescript",
      });
      useEditorStore.getState().updateContent("/w/a.ts", "dirty");
      askMock.mockResolvedValue(true);

      await commandRegistry.execute("quit");

      expect(persistenceMock.flushSettingsPersistence).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith("quit_app");
    });
  });

  it("every default keybinding resolves to a registered command", () => {
    for (const binding of DEFAULT_KEYMAP) {
      expect(
        commandRegistry.get(binding.command),
        `keymap references an unregistered command: ${binding.command}`,
      ).toBeDefined();
    }
  });
});
