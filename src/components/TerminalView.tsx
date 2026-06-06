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
import { terminalKeyOverride } from "../lib/terminalKeys";
import { isMac } from "../hooks/useLayoutKeybindings";

export interface TerminalViewProps {
  id: string;
  cwd: string | null;
  active: boolean;
  startupCommand?: string;
}

// Monotonic per-mount token. Each mount talks to a backend PTY under a unique id
// so a previous mount's cleanup (closePty) can never tear down the PTY belonging
// to a fresh remount that reused the same React-level terminal id.
let terminalMountSeq = 0;

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

    // Unique backend PTY id for this mount (see terminalMountSeq). Uses `_` as
    // the separator because the id is interpolated into Tauri event names
    // (`terminal:data:<ptyId>`), which only allow alphanumerics, `-/:_`.
    const ptyId = `${id}_${(terminalMountSeq += 1)}`;
    let disposed = false;
    // Buffer keystrokes typed before the PTY exists, then flush on ready — so
    // the first characters a user types into a brand-new terminal aren't dropped
    // (and don't reject with "no such terminal").
    let ready = false;
    const pending: string[] = [];
    const sendInput = (data: string) => {
      if (ready) void writePty(ptyId, data);
      else pending.push(data);
    };

    // Clipboard: copy the selection (Cmd/Ctrl+C with a selection), paste
    // (Cmd/Ctrl+V). Ctrl+C with no selection still reaches the PTY (interrupt).
    // Backspace is sent explicitly because some WebView/browser key events can
    // be mis-mapped before xterm turns them into terminal bytes.
    term.attachCustomKeyEventHandler((e) => {
      const override = terminalKeyOverride(e, isMac(), term.hasSelection());
      if (!override) return true;
      switch (override.type) {
        case "send":
          sendInput(override.data);
          break;
        case "copy":
          navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          break;
        case "paste":
          navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text) sendInput(text);
            })
            .catch(() => {});
          break;
      }
      return false;
    });

    const dataDisp = term.onData(sendInput);

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
        const offData = await onPtyData(ptyId, (bytes) => term.write(bytes));
        const offExit = await onPtyExit(ptyId, () =>
          term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
        );
        if (disposed) {
          offData();
          offExit();
          return;
        }
        unlistens.push(offData, offExit);
        await createPty(ptyId, {
          shell: settings.shellPath || null,
          cwd: resolvedCwd,
          cols: term.cols,
          rows: term.rows,
        });
        // The view may have unmounted while the PTY was being created; close the
        // just-created PTY instead of leaking the shell process.
        if (disposed) {
          void closePty(ptyId);
          return;
        }
        // Flush any keystrokes buffered before the PTY existed.
        ready = true;
        for (const chunk of pending) void writePty(ptyId, chunk);
        pending.length = 0;
        if (startupCommand) void writePty(ptyId, startupCommand);
      } catch (e) {
        term.write(`\r\nfailed to start terminal: ${String(e)}\r\n`);
      }
    })();

    // Only round-trip a resize to the PTY when the character grid actually
    // changes — a drag-resize fires the observer many times per second but a few
    // px usually keeps the same cols/rows, so the ioctl/IPC would be redundant.
    let lastCols = term.cols;
    let lastRows = term.rows;
    const observer = new ResizeObserver(() => {
      // Skip while hidden (display:none on this host or an ancestor panel/tab →
      // 0 size). Fitting here would collapse the grid to xterm's 2x1 minimum and
      // resize the PTY to match, squeezing all output. The observer fires again
      // with real dimensions when the panel/tab becomes visible.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          void resizePty(ptyId, term.cols, term.rows);
        }
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
      void closePty(ptyId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd]);

  // Re-fit and focus when this terminal becomes the active tab. Guard against a
  // hidden host (0 size) so we never fit to the collapsed 2x1 minimum.
  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
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
