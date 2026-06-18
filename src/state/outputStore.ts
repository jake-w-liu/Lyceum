// Output panel state: captured lines from runs and builds shown in the
// bottom panel's Output tab.

import { create } from "zustand";

export interface OutputData {
  lines: string[];
  running: boolean;
  /** Backend run id of the in-flight run/build, for cancellation. */
  runId: string | null;
}

export interface OutputActions {
  append: (line: string) => void;
  /** Append a batch of lines in a single update (one array copy, one render). */
  appendMany: (lines: string[]) => void;
  clear: () => void;
  setRunning: (running: boolean) => void;
  setRunId: (runId: string | null) => void;
}

export type OutputState = OutputData & OutputActions;

export const initialOutputData: OutputData = {
  lines: [],
  running: false,
  runId: null,
};

// Cap the retained output so a very chatty/long run can't grow the buffer (and
// the rendered <pre>) without bound; we keep the most recent lines.
export const MAX_OUTPUT_LINES = 5000;

export const useOutputStore = create<OutputState>()((set) => ({
  ...initialOutputData,
  append: (line) =>
    set((s) => ({ lines: capLines([...s.lines, line]) })),
  appendMany: (incoming) =>
    set((s) =>
      incoming.length === 0
        ? {}
        : { lines: capLines([...s.lines, ...incoming]) },
    ),
  clear: () => {
    // Also drop buffered-but-not-yet-flushed streamed lines, otherwise a Clear
    // during an active run is undone on the next animation frame when the
    // pending buffer flushes the pre-clear output back into the store.
    resetOutputBuffer();
    set({ lines: [] });
  },
  setRunning: (running) => set({ running }),
  setRunId: (runId) => set({ runId }),
}));

function capLines(lines: string[]): string[] {
  return lines.length > MAX_OUTPUT_LINES
    ? lines.slice(lines.length - MAX_OUTPUT_LINES)
    : lines;
}

// Coalesce a burst of streamed output lines into one store update per animation
// frame, so a chatty run does O(frames) array copies/renders instead of O(lines)
// (which was quadratic with the full-buffer re-join in OutputView).
let outputBuffer: string[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const flush = () => {
    flushScheduled = false;
    flushOutputBuffer();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** Buffer a streamed output line for batched flushing (see scheduleFlush). */
export function appendOutputBuffered(line: string): void {
  outputBuffer.push(line);
  scheduleFlush();
}

/** Drop any buffered, not-yet-flushed streamed lines. Called by the store's
 *  `clear()` so a Clear during a live run truly discards in-flight output. A
 *  pending flush still fires but finds the buffer empty (a no-op). */
export function resetOutputBuffer(): void {
  outputBuffer = [];
}

/** Flush any buffered output lines immediately (call before a discrete message
 *  like "[exited]" so ordering is preserved). */
export function flushOutputBuffer(): void {
  if (outputBuffer.length === 0) return;
  const batch = outputBuffer;
  outputBuffer = [];
  useOutputStore.getState().appendMany(batch);
}
