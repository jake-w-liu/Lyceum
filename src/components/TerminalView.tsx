// A single xterm.js terminal bound to a backend PTY session (M5).
//
// Lifecycle: on mount, create the xterm instance + PTY, stream output in and
// keystrokes out, and keep the PTY sized to the view. On unmount, dispose the
// terminal and close the PTY. Not unit-tested (xterm needs real layout/canvas);
// covered by the terminal store/IPC tests and the `tauri dev` smoke test.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  closePty,
  createPty,
  onPtyData,
  onPtyExit,
  resizePty,
  writePty,
} from "../lib/terminal";
import { useSettingsStore } from "../state/settingsStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { getActiveDoc, useEditorStore } from "../state/editorStore";
import { resolveTerminalCwd } from "../lib/terminalCwd";
import { isMac } from "../hooks/useLayoutKeybindings";

export interface TerminalViewProps {
  id: string;
  cwd: string | null;
  active: boolean;
  startupCommand?: string;
}

export function TerminalView({
  id,
  cwd,
  active,
  startupCommand,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      theme: { background: "#1e1e1e", foreground: "#cccccc" },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // host not laid out yet; ResizeObserver will fit shortly.
    }

    // Clipboard: copy the selection (Cmd/Ctrl+C with a selection), paste
    // (Cmd/Ctrl+V). Ctrl+C with no selection still reaches the PTY (interrupt).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (key === "v") {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) void writePty(id, text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    const dataDisp = term.onData((data) => void writePty(id, data));

    let disposed = false;
    const unlistens: UnlistenLike[] = [];
    const settings = useSettingsStore.getState().settings;
    const resolvedCwd =
      resolveTerminalCwd(
        settings.terminalCwdBehavior,
        useWorkspaceStore.getState().rootPath,
        getActiveDoc(useEditorStore.getState())?.path ?? null,
      ) ?? cwd;

    void (async () => {
      try {
        // Register listeners BEFORE creating the PTY: the Rust reader thread
        // starts emitting output immediately, so attaching after createPty
        // would drop the initial shell prompt/banner.
        const offData = await onPtyData(id, (bytes) => term.write(bytes));
        const offExit = await onPtyExit(id, () =>
          term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
        );
        if (disposed) {
          offData();
          offExit();
          return;
        }
        unlistens.push(offData, offExit);
        await createPty(id, {
          shell: settings.shellPath || null,
          cwd: resolvedCwd,
          cols: term.cols,
          rows: term.rows,
        });
        if (startupCommand) void writePty(id, startupCommand);
      } catch (e) {
        term.write(`\r\nfailed to start terminal: ${String(e)}\r\n`);
      }
    })();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        void resizePty(id, term.cols, term.rows);
      } catch {
        // ignore transient layout errors
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      dataDisp.dispose();
      unlistens.forEach((off) => off());
      void closePty(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd]);

  // Re-fit and focus when this terminal becomes the active tab.
  useEffect(() => {
    if (!active) return;
    try {
      fitRef.current?.fit();
    } catch {
      // ignore
    }
    termRef.current?.focus();
  }, [active]);

  return <div className="terminal-view" ref={hostRef} />;
}

type UnlistenLike = () => void;
