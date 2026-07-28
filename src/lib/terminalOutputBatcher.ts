// Coalesces PTY output before it reaches xterm.
//
// The backend emits one event per batched read (≤ 32 KiB). Writing each one to
// xterm separately is fine while streaming live, but after the screen unlocks
// (or any burst where the webview was throttled) a large backlog of chunks
// arrives at once — writing them one-by-one makes xterm parse and reflow
// thousands of times and stalls the UI. This batcher buffers chunks and flushes
// them merged, once per animation frame, capped per flush so even a huge backlog
// is written across several frames instead of freezing one.
//
// Animation frames alone are not enough: per the HTML spec a document that is
// not rendered (window minimised, occluded, or on another macOS Space) never
// runs its animation-frame callbacks, while backend events keep being delivered.
// A frame-only batcher therefore buffers *everything* produced while the window
// is away and dumps it in one go on return. Every flush is also armed with a
// slower timer that only ever wins when frames are genuinely not running, which
// keeps the backlog bounded and removes the stall on restore.
//
// Scheduling is injected (requestFrame/cancelFrame/requestTimer/cancelTimer) so
// the logic is unit-tested with a deterministic fake scheduler; TerminalView
// wires real requestAnimationFrame/setTimeout.

export interface OutputBatcherOptions {
  /** Write merged bytes to the sink (xterm). */
  write: (bytes: Uint8Array) => void;
  /** Schedule a flush; returns a handle. Real impl: requestAnimationFrame. */
  requestFrame: (cb: () => void) => number;
  /** Cancel a scheduled flush. Real impl: cancelAnimationFrame. */
  cancelFrame: (handle: number) => void;
  /** Schedule the no-frames fallback flush. Real impl: setTimeout. */
  requestTimer: (cb: () => void, ms: number) => number;
  /** Cancel the fallback flush. Real impl: clearTimeout. */
  cancelTimer: (handle: number) => void;
  /** Max bytes written per frame flush (default 256 KiB). Keeps each frame short. */
  maxFlushBytes?: number;
  /**
   * How long to wait for an animation frame before flushing from the timer
   * instead (default 250 ms). Comfortably longer than a frame, so while the
   * window is on screen the frame always wins and the fallback never fires.
   */
  idleFlushDelayMs?: number;
}

export interface OutputBatcher {
  /** Enqueue a chunk; schedules a flush on the next frame. */
  push: (bytes: Uint8Array) => void;
  /**
   * Synchronously write everything buffered. Use before an out-of-band write
   * (e.g. an "[exited]" notice) so it lands after all preceding output, in order.
   */
  flushNow: () => void;
  /** Cancel any pending flush and drop the buffer; no writes happen after this. */
  dispose: () => void;
}

const DEFAULT_MAX_FLUSH_BYTES = 256 * 1024;
const DEFAULT_IDLE_FLUSH_DELAY_MS = 250;

function merge(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]; // common live case: no copy
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function createOutputBatcher(opts: OutputBatcherOptions): OutputBatcher {
  const maxFlushBytes = opts.maxFlushBytes ?? DEFAULT_MAX_FLUSH_BYTES;
  const idleFlushDelayMs = opts.idleFlushDelayMs ?? DEFAULT_IDLE_FLUSH_DELAY_MS;
  const pending: Uint8Array[] = [];
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;
  let disposed = false;

  // Take as many leading chunks as fit under the byte cap (always at least one,
  // so an oversized single chunk still makes progress).
  function takeBatch(limit: number): Uint8Array[] {
    let total = 0;
    let count = 0;
    for (const chunk of pending) {
      if (count > 0 && total + chunk.length > limit) break;
      total += chunk.length;
      count += 1;
    }
    return pending.splice(0, count);
  }

  function clearScheduled(): void {
    if (frameHandle !== null) {
      opts.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (timerHandle !== null) {
      opts.cancelTimer(timerHandle);
      timerHandle = null;
    }
  }

  function schedule(): void {
    if (disposed) return;
    // Both are armed together and whichever fires first cancels the other, so a
    // flush happens exactly once per scheduling round.
    if (frameHandle === null) frameHandle = opts.requestFrame(onFrame);
    if (timerHandle === null) {
      timerHandle = opts.requestTimer(onTimer, idleFlushDelayMs);
    }
  }

  function flush(limit: number): void {
    if (disposed || pending.length === 0) return;
    opts.write(merge(takeBatch(limit)));
    // Hit the cap with more queued — finish on the next flush so this one stays short.
    if (pending.length > 0) schedule();
  }

  function onFrame(): void {
    frameHandle = null;
    clearScheduled();
    flush(maxFlushBytes);
  }

  function onTimer(): void {
    timerHandle = null;
    clearScheduled();
    // Reaching here means no animation frame ran for idleFlushDelayMs, i.e. the
    // document is not being rendered. There is no frame budget to protect, so
    // drain the whole backlog rather than letting it grow until the window is
    // restored (which is what made the terminal stall for seconds on return).
    flush(Number.POSITIVE_INFINITY);
  }

  return {
    push(bytes) {
      if (disposed || bytes.length === 0) return;
      pending.push(bytes);
      schedule();
    },
    flushNow() {
      clearScheduled();
      if (disposed || pending.length === 0) return;
      opts.write(merge(pending.splice(0)));
    },
    dispose() {
      disposed = true;
      clearScheduled();
      pending.length = 0;
    },
  };
}
