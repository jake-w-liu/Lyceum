// Active keymap (M10): the default keymap plus any user overrides loaded from
// keybindings.json. User entries are appended after the defaults so they win
// (the matcher takes the last matching binding). The command keybinding hook
// reads `keymap` from here instead of using DEFAULT_KEYMAP directly.

import { create } from "zustand";
import { DEFAULT_KEYMAP, type Keybinding } from "../keybindings/keybindingRegistry";

export interface KeymapData {
  keymap: Keybinding[];
}

export interface KeymapActions {
  setUserKeybindings: (user: Keybinding[]) => void;
  resetKeymap: () => void;
}

export type KeymapState = KeymapData & KeymapActions;

export const initialKeymapData: KeymapData = { keymap: DEFAULT_KEYMAP };

export const useKeymapStore = create<KeymapState>()((set) => ({
  ...initialKeymapData,
  setUserKeybindings: (user) => set({ keymap: [...DEFAULT_KEYMAP, ...user] }),
  resetKeymap: () => set({ keymap: DEFAULT_KEYMAP }),
}));

function isKeybinding(b: unknown): b is Keybinding {
  return (
    !!b &&
    typeof b === "object" &&
    typeof (b as Keybinding).key === "string" &&
    typeof (b as Keybinding).command === "string" &&
    // `when` is optional but MUST be a string when present — a non-string value
    // from the hand-edited keybindings.json would otherwise reach evaluateWhen
    // and throw `.trim is not a function` out of the global keydown handler.
    ((b as Keybinding).when === undefined ||
      typeof (b as Keybinding).when === "string")
  );
}

/**
 * Extract valid `{ key, command, when? }` entries from a parsed keybindings file,
 * which may be a versioned object `{ version, keybindings: [...] }` or a bare array.
 */
export function parseUserKeybindings(raw: unknown): Keybinding[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { keybindings?: unknown }).keybindings)
      ? (raw as { keybindings: unknown[] }).keybindings
      : [];
  return arr.filter(isKeybinding);
}
