// Persisted user settings: types, defaults, validation, and store (M10).
import { create } from "zustand";
import { STOCK_LATEX_BUILD_COMMAND } from "../lib/latex";

export type ThemeId = "dark" | "light" | "hc";
export type WordWrap = "off" | "on";
export type TerminalCwdBehavior = "workspaceRoot" | "currentFileDir";

export interface Settings {
  version: number;
  theme: ThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
  tabSize: number;
  wordWrap: WordWrap;
  shellPath: string;
  terminalCwdBehavior: TerminalCwdBehavior;
  juliaPath: string;
  latexBuildCommand: string;
  restoreWorkspaceOnStartup: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  /** Window zoom in VS Code-style steps (each step ≈ 20%); 0 = 100%. */
  zoomLevel: number;
}

// Window zoom level bounds (each step is a 1.2× factor; see lib/zoom).
export const ZOOM_LEVEL_MIN = -5;
export const ZOOM_LEVEL_MAX = 10;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "dark",
  fontFamily: "",
  fontSize: 13,
  lineHeight: 0,
  ligatures: false,
  tabSize: 2,
  wordWrap: "off",
  shellPath: "",
  terminalCwdBehavior: "workspaceRoot",
  juliaPath: "",
  latexBuildCommand: STOCK_LATEX_BUILD_COMMAND,
  restoreWorkspaceOnStartup: true,
  minimap: false,
  lineNumbers: true,
  zoomLevel: 0,
};

const THEMES: ThemeId[] = ["dark", "light", "hc"];
const WORD_WRAPS: WordWrap[] = ["off", "on"];
const TERMINAL_CWD_BEHAVIORS: TerminalCwdBehavior[] = [
  "workspaceRoot",
  "currentFileDir",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLineHeight(value: number, fontSize: number): number {
  if (value <= 0) return 0;
  if (value < 8) return Math.round(fontSize * value);
  return clamp(value, 8, 80);
}

// Validate `partial` against DEFAULT_SETTINGS, ignoring unknown keys/wrong types.
export function mergeSettings(partial: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (partial === null || typeof partial !== "object") {
    return out;
  }
  const p = partial as Record<string, unknown>;

  if (typeof p.theme === "string" && THEMES.includes(p.theme as ThemeId)) {
    out.theme = p.theme as ThemeId;
  }
  if (typeof p.fontFamily === "string") {
    out.fontFamily = p.fontFamily;
  }
  if (typeof p.fontSize === "number") {
    out.fontSize = p.fontSize;
  }
  if (typeof p.lineHeight === "number") {
    out.lineHeight = p.lineHeight;
  }
  if (typeof p.ligatures === "boolean") {
    out.ligatures = p.ligatures;
  }
  if (typeof p.tabSize === "number") {
    out.tabSize = p.tabSize;
  }
  if (
    typeof p.wordWrap === "string" &&
    WORD_WRAPS.includes(p.wordWrap as WordWrap)
  ) {
    out.wordWrap = p.wordWrap as WordWrap;
  }
  if (typeof p.shellPath === "string") {
    out.shellPath = p.shellPath;
  }
  if (
    typeof p.terminalCwdBehavior === "string" &&
    TERMINAL_CWD_BEHAVIORS.includes(p.terminalCwdBehavior as TerminalCwdBehavior)
  ) {
    out.terminalCwdBehavior = p.terminalCwdBehavior as TerminalCwdBehavior;
  }
  if (typeof p.juliaPath === "string") {
    out.juliaPath = p.juliaPath;
  }
  if (typeof p.latexBuildCommand === "string") {
    out.latexBuildCommand = p.latexBuildCommand;
  }
  if (typeof p.restoreWorkspaceOnStartup === "boolean") {
    out.restoreWorkspaceOnStartup = p.restoreWorkspaceOnStartup;
  }
  if (typeof p.minimap === "boolean") {
    out.minimap = p.minimap;
  }
  if (typeof p.lineNumbers === "boolean") {
    out.lineNumbers = p.lineNumbers;
  }
  if (typeof p.zoomLevel === "number") {
    out.zoomLevel = p.zoomLevel;
  }

  out.fontSize = clamp(out.fontSize, 8, 40);
  out.tabSize = clamp(out.tabSize, 1, 8);
  out.lineHeight = normalizeLineHeight(out.lineHeight, out.fontSize);
  out.zoomLevel = clamp(Math.round(out.zoomLevel), ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX);
  out.version = DEFAULT_SETTINGS.version;
  return out;
}

export interface SettingsData {
  settings: Settings;
}

export interface SettingsActions {
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  replaceAll: (settings: Settings) => void;
}

export type SettingsState = SettingsData & SettingsActions;

export const initialSettingsData: SettingsData = { settings: DEFAULT_SETTINGS };

export const useSettingsStore = create<SettingsState>()((set) => ({
  ...initialSettingsData,
  setSetting: (key, value) =>
    set((state) => ({ settings: { ...state.settings, [key]: value } })),
  replaceAll: (settings: Settings) => set({ settings }),
}));
