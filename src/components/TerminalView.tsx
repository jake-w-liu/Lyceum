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
import { useThemeStore } from "../state/themeStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { getActiveDoc, useEditorStore } from "../state/editorStore";
import { useTerminalStore } from "../state/terminalStore";
import { resolveTerminalCwd } from "../lib/terminalCwd";
import { createOutputBatcher } from "../lib/terminalOutputBatcher";
import { terminalKeyOverride } from "../lib/terminalKeys";
import { isMac } from "../hooks/useLayoutKeybindings";

export interface TerminalViewProps {
  id: string;
  cwd: string | null;
  active: boolean;
  startupCommand?: string;
}

// xterm colors derived from the active theme's CSS custom properties (read off
// the terminal host so light/high-contrast themes apply), with dark-theme
// fallbacks for environments without the variables (e.g. jsdom).
function xtermThemeFromCss(el: HTMLElement) {
  const styles = getComputedStyle(el);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const foreground = read("--fg", "#cccccc");
  return {
    background: read("--bg", "#1e1e1e"),
    foreground,
    cursor: foreground,
    selectionBackground: read("--selection", "#264f78"),
  };
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
      theme: xtermThemeFromCss(host),
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
    // Coalesce PTY output into one write per animation frame so a backlog (e.g.
    // catching up after the screen unlocks, or a verbose command) doesn't make
    // xterm parse thousands of tiny chunks and stall the UI. See terminalOutputBatcher.
    const outputBatcher = createOutputBatcher({
      write: (bytes) => term.write(bytes),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    });
    // Buffer keystrokes typed before the PTY exists, then flush on ready — so
    // the first characters a user types into a brand-new terminal aren't dropped
    // (and don't reject with "no such terminal").
    let ready = false;
    const pending: string[] = [];
    const sendInput = (data: string) => {
      if (ready) void writePty(ptyId, data);
      else pending.push(data);
    };

    // Clipboard: copy the selection (Cmd/Ctrl+C with a selection). Paste is left
    // to xterm's native `paste` event so Cmd/Ctrl+V inserts exactly once and does
    // not trip the macOS clipboard-permission prompt. Ctrl+C with no selection
    // still reaches the PTY (interrupt). Backspace is sent explicitly because
    // some WebView/browser key events can be mis-mapped before xterm turns them
    // into terminal bytes.
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
      }
      return false;
    });

    const dataDisp = term.onData(sendInput);

    // Keep the xterm colors in sync with the app theme. The `data-theme`
    // attribute is applied by a React effect after the store updates, so read
    // the new CSS variables on the next frame.
    const unsubTheme = useThemeStore.subscribe(() => {
      requestAnimationFrame(() => {
        if (!disposed) term.options.theme = xtermThemeFromCss(host);
      });
    });

    const unlistens: UnlistenLike[] = [];
    const settings = useSettingsStore.getState().settings;
    const resolvedCwd =
      resolveTerminalCwd(
        settings.terminalCwdBehavior,
        useWorkspaceStore.getState().rootPath,
        getActiveDoc(useEditorStore.getState())?.path ?? null,
      ) ?? cwd;

    void (async () => {
      // Held here until handed to `unlistens` so a failure partway through
      // registration (e.g. onPtyExit rejects after onPtyData resolved) can still
      // unlisten what was attached — otherwise that listener would leak, since
      // the cleanup function only tears down what made it into `unlistens`.
      let offData: UnlistenLike | undefined;
      let offExit: UnlistenLike | undefined;
      try {
        // Register listeners BEFORE creating the PTY: the Rust reader thread
        // starts emitting output immediately, so attaching after createPty
        // would drop the initial shell prompt/banner.
        offData = await onPtyData(ptyId, (bytes) => outputBatcher.push(bytes));
        offExit = await onPtyExit(ptyId, () => {
          // Drain buffered output first so the exit notice prints after it.
          outputBatcher.flushNow();
          term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        });
        if (disposed) {
          offData();
          offExit();
          return;
        }
        unlistens.push(offData, offExit);
        // Ownership transferred to `unlistens` (torn down on unmount); the catch
        // must not unlisten them again.
        offData = undefined;
        offExit = undefined;
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
        useTerminalStore.getState().setBackendPtyId(id, ptyId);
        // Flush any keystrokes buffered before the PTY existed.
        ready = true;
        for (const chunk of pending) void writePty(ptyId, chunk);
        pending.length = 0;
        if (startupCommand) void writePty(ptyId, startupCommand);
      } catch (e) {
        // Unlisten anything that registered but never reached `unlistens`.
        offData?.();
        offExit?.();
        useTerminalStore.getState().clearBackendPtyId(id, ptyId);
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
      unsubTheme();
      dataDisp.dispose();
      unlistens.forEach((off) => off());
      // Cancel any pending batched flush before disposing the terminal so a
      // queued animation frame can't write into a disposed xterm instance.
      outputBatcher.dispose();
      useTerminalStore.getState().clearBackendPtyId(id, ptyId);
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
