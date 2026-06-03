// Theme state, ordering/labels, and Monaco/DOM theme mapping.
import { create } from "zustand";

export type ThemeId = "dark" | "light" | "hc"; // "dark" IS the VS Code-like default dark theme

export const THEME_ORDER: ThemeId[] = ["dark", "light", "hc"];

export const THEME_LABELS: Record<ThemeId, string> = {
  dark: "Dark (VS Code)",
  light: "Light",
  hc: "High Contrast",
};

export interface ThemeData {
  theme: ThemeId;
}

export const initialThemeData: ThemeData = { theme: "dark" };

export interface ThemeActions {
  setTheme: (t: ThemeId) => void;
  cycleTheme: () => void;
}

export type ThemeState = ThemeData & ThemeActions;

export function monacoThemeFor(t: ThemeId): string {
  switch (t) {
    case "dark":
      return "vs-dark";
    case "light":
      return "vs";
    case "hc":
      return "hc-black";
  }
}

export function applyThemeAttribute(t: ThemeId): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
  }
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  ...initialThemeData,
  setTheme: (t: ThemeId) => set({ theme: t }),
  cycleTheme: () => {
    const current = get().theme;
    const index = THEME_ORDER.indexOf(current);
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
    set({ theme: next });
  },
}));
