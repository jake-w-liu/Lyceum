// Output panel state (M8): captured lines from runs (e.g. Julia) shown in the
// bottom panel's Output tab.

import { create } from "zustand";

export interface OutputData {
  lines: string[];
  running: boolean;
}

export interface OutputActions {
  append: (line: string) => void;
  clear: () => void;
  setRunning: (running: boolean) => void;
}

export type OutputState = OutputData & OutputActions;

export const initialOutputData: OutputData = { lines: [], running: false };

// Cap the retained output so a very chatty/long run can't grow the buffer (and
// the rendered <pre>) without bound; we keep the most recent lines.
export const MAX_OUTPUT_LINES = 5000;

export const useOutputStore = create<OutputState>()((set) => ({
  ...initialOutputData,
  append: (line) =>
    set((s) => {
      const next = [...s.lines, line];
      return {
        lines:
          next.length > MAX_OUTPUT_LINES
            ? next.slice(next.length - MAX_OUTPUT_LINES)
            : next,
      };
    }),
  clear: () => set({ lines: [] }),
  setRunning: (running) => set({ running }),
}));
