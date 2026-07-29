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
// A line-count cap alone is not a memory bound: the backend permits a 1 MiB
// newline-less line, so 5,000 retained lines could approach 5 GiB. JavaScript
// strings use at most two bytes per UTF-16 code unit; two million code units
// therefore keep retained text near 4 MiB (plus small array/string overhead).
export const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;

export const useOutputStore = create<OutputState>()((set) => ({
  ...initialOutputData,
  append: (line) =>
    set((s) => ({ lines: appendCapped(s.lines, [line]) })),
  appendMany: (incoming) =>
    set((s) =>
      incoming.length === 0
        ? {}
        : { lines: appendCapped(s.lines, incoming) },
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

function appendCapped(existing: string[], incoming: string[]): string[] {
  const reversed: string[] = [];
  let chars = 0;
  const takeNewest = (source: string[]): boolean => {
    for (let i = source.length - 1; i >= 0; i -= 1) {
      if (
        reversed.length >= MAX_OUTPUT_LINES ||
        chars >= MAX_OUTPUT_CHARS
      ) {
        return false;
      }
      const remaining = MAX_OUTPUT_CHARS - chars;
      const original = source[i];
      const line =
        original.length > remaining
          ? unicodeSafeTail(original, remaining)
          : original;
      reversed.push(line);
      chars += line.length;
      if (line.length !== original.length) return false;
    }
    return true;
  };
  if (takeNewest(incoming)) takeNewest(existing);
  reversed.reverse();
  return reversed;
}

function unicodeSafeTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  let start = value.length - maxChars;
  // Do not begin with the low half of a surrogate pair.
  const first = value.charCodeAt(start);
  const previous = start > 0 ? value.charCodeAt(start - 1) : 0;
  if (
    first >= 0xdc00 &&
    first <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
  ) {
    start += 1;
  }
  return value.slice(start);
}

// Coalesce a burst of streamed output lines into one store update per animation
// frame, so a chatty run does O(frames) array copies/renders instead of O(lines)
// (which was quadratic with the full-buffer re-join in OutputView).
let outputBuffer: string[] = [];
let outputBufferStart = 0;
let outputBufferChars = 0;
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
  if (line.length > MAX_OUTPUT_CHARS) {
    line = unicodeSafeTail(line, MAX_OUTPUT_CHARS);
  }
  outputBuffer.push(line);
  outputBufferChars += line.length;
  while (
    outputBuffer.length - outputBufferStart > MAX_OUTPUT_LINES ||
    outputBufferChars > MAX_OUTPUT_CHARS
  ) {
    outputBufferChars -= outputBuffer[outputBufferStart].length;
    outputBufferStart += 1;
  }
  // A hidden WebView can defer animation frames indefinitely. Keep the backing
  // array bounded too, not just its logical live suffix.
  if (
    outputBufferStart >= 256 ||
    outputBufferStart * 2 >= outputBuffer.length
  ) {
    outputBuffer = outputBuffer.slice(outputBufferStart);
    outputBufferStart = 0;
  }
  scheduleFlush();
}

/** Drop any buffered, not-yet-flushed streamed lines. Called by the store's
 *  `clear()` so a Clear during a live run truly discards in-flight output. A
 *  pending flush still fires but finds the buffer empty (a no-op). */
export function resetOutputBuffer(): void {
  outputBuffer = [];
  outputBufferStart = 0;
  outputBufferChars = 0;
}

/** Number of retained streamed lines awaiting the next flush. */
export function bufferedOutputLineCount(): number {
  return outputBuffer.length - outputBufferStart;
}

/** Flush any buffered output lines immediately (call before a discrete message
 *  like "[exited]" so ordering is preserved). */
export function flushOutputBuffer(): void {
  if (outputBuffer.length === outputBufferStart) return;
  const batch = outputBuffer.slice(outputBufferStart);
  outputBuffer = [];
  outputBufferStart = 0;
  outputBufferChars = 0;
  useOutputStore.getState().appendMany(batch);
}
