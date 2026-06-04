// Minimal global keybindings for the M1 shell layout.
//
// NOTE: This is a deliberately small, hard-coded handler covering only the
// layout-toggle shortcuts. In M4 it will be replaced by the general command +
// keybinding registry (keybindings loaded from JSON, every action a command).
// It is kept tiny and the matcher is pure so it can be unit-tested without DOM.

import { useEffect } from "react";
import { useLayoutStore } from "../state/layoutStore";

export type LayoutCommand =
  | "toggleSidebar"
  | "toggleBottomPanel"
  | "toggleTerminal"
  | "newTerminal"
  | "togglePreview";

/** True on macOS, where the primary modifier is Cmd rather than Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac/i.test(platform) || /mac/i.test(nav.userAgent ?? "");
}

/**
 * Map a keyboard event to a layout command id, or null if it doesn't match.
 * Pure (no DOM access beyond the passed event) so it is trivially testable.
 */
export function matchLayoutCommand(e: KeyboardEvent): LayoutCommand | null {
  // Terminal shortcuts intentionally use Ctrl+Backquote on every platform,
  // including macOS. This is app-specific; other workbench shortcuts still use
  // Cmd on macOS via the primary modifier.
  if (e.code === "Backquote" && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? "newTerminal" : "toggleTerminal";
  }

  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;

  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === "v") return "togglePreview";
    return null;
  }
  if (key === "b") return "toggleSidebar";
  if (key === "j") return "toggleBottomPanel";
  return null;
}

/** Install the layout keybindings on `window` for the lifetime of the component. */
export function useLayoutKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const command = matchLayoutCommand(e);
      if (!command) return;
      e.preventDefault();
      const s = useLayoutStore.getState();
      switch (command) {
        case "toggleSidebar":
          s.toggleSidebar();
          break;
        case "toggleBottomPanel":
          s.toggleBottomPanel();
          break;
        case "toggleTerminal":
          s.toggleTerminal();
          break;
        case "newTerminal":
          // Full multi-terminal creation arrives in M5; for now focus terminal.
          s.showBottomTab("terminal");
          break;
        case "togglePreview":
          // Real Markdown/PDF preview arrives in M6/M11; toggle the panel for now.
          s.togglePdfPanel();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
