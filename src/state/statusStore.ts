// Live editor cursor position for the status bar (Ln/Col). Deliberately a tiny
// isolated store: cursor moves are extremely frequent, and routing them through
// editorStore would run every editorStore selector per keypress. Here only the
// StatusBar subscribes.

import { create } from "zustand";

export interface StatusData {
  /** 1-based cursor line in the active editor. */
  line: number;
  /** 1-based cursor column in the active editor. */
  column: number;
}

export interface StatusActions {
  setCursor: (line: number, column: number) => void;
}

export type StatusState = StatusData & StatusActions;

export const initialStatusData: StatusData = {
  line: 1,
  column: 1,
};

export const useStatusStore = create<StatusState>()((set) => ({
  ...initialStatusData,

  setCursor: (line, column) =>
    set((s) => (s.line === line && s.column === column ? s : { line, column })),
}));
