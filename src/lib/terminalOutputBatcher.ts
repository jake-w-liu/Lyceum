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
// is away. Every flush is also armed with a slower timer. Timers can themselves
// be suspended by the WebView, so both timer and frame flushes retain the byte
// cap: whichever callback resumes first can never hand xterm one giant parse
// unit and freeze the foregrounded window.
//
// Scheduling is injected (requestFrame/cancelFrame/requestTimer/cancelTimer) so
// the logic is unit-tested with a deterministic fake scheduler; TerminalView
// wires real requestAnimationFrame/setTimeout.

export interface OutputBatcherOptions {
  /** Write merged bytes to xterm and call `onParsed` after xterm parses them. */
  write: (bytes: Uint8Array, onParsed: () => void) => void;
  /** Schedule a flush; returns a handle. Real impl: requestAnimationFrame. */
  requestFrame: (cb: () => void) => number;
  /** Cancel a scheduled flush. Real impl: cancelAnimationFrame. */
  cancelFrame: (handle: number) => void;
  /** Schedule the no-frames fallback flush. Real impl: setTimeout. */
  requestTimer: (cb: () => void, ms: number) => number;
  /** Cancel the fallback flush. Real impl: clearTimeout. */
  cancelTimer: (handle: number) => void;
  /** Max bytes written per frame flush (default 64 KiB). Keeps each frame short. */
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
  push: (bytes: Uint8Array, onConsumed?: () => void) => void;
  /**
   * Synchronously write everything buffered. Use before an out-of-band write
   * (e.g. an "[exited]" notice) so it lands after all preceding output, in order.
   */
  flushNow: () => void;
  /** Cancel any pending flush and drop the buffer; no writes happen after this. */
  dispose: () => void;
}

const DEFAULT_MAX_FLUSH_BYTES = 64 * 1024;
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

interface PendingChunk {
  bytes: Uint8Array;
  onConsumed?: () => void;
}

export function createOutputBatcher(opts: OutputBatcherOptions): OutputBatcher {
  const idleFlushDelayMs = opts.idleFlushDelayMs ?? DEFAULT_IDLE_FLUSH_DELAY_MS;
  const pending: PendingChunk[] = [];
  let pendingHead = 0;
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;
  let disposed = false;

  const configuredMaxFlushBytes =
    opts.maxFlushBytes ?? DEFAULT_MAX_FLUSH_BYTES;
  const maxFlushBytes =
    Number.isFinite(configuredMaxFlushBytes) && configuredMaxFlushBytes > 0
      ? Math.max(1, Math.floor(configuredMaxFlushBytes))
      : DEFAULT_MAX_FLUSH_BYTES;
  function takeBatch(limit: number): {
    chunks: Uint8Array[];
    callbacks: Array<() => void>;
  } {
    // Source chunks normally top out at 32 KiB, but split an oversized chunk as
    // well so the sink-facing cap is a real invariant rather than a best effort.
    let total = 0;
    const batch: Uint8Array[] = [];
    const callbacks: Array<() => void> = [];
    while (pendingHead < pending.length && total < limit) {
      const chunk = pending[pendingHead];
      const remaining = limit - total;
      if (chunk.bytes.length <= remaining) {
        batch.push(chunk.bytes);
        total += chunk.bytes.length;
        if (chunk.onConsumed) callbacks.push(chunk.onConsumed);
        pendingHead += 1;
      } else {
        batch.push(chunk.bytes.subarray(0, remaining));
        pending[pendingHead] = {
          bytes: chunk.bytes.subarray(remaining),
          onConsumed: chunk.onConsumed,
        };
        total += remaining;
      }
    }
    // Avoid Array.shift's O(n) copy on every source chunk. Compact only after a
    // substantial prefix was consumed, and reset completely when the queue drains.
    if (pendingHead === pending.length) {
      pending.length = 0;
      pendingHead = 0;
    } else if (pendingHead >= 256 && pendingHead * 2 >= pending.length) {
      pending.splice(0, pendingHead);
      pendingHead = 0;
    }
    return { chunks: batch, callbacks };
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
    if (disposed || pendingHead >= pending.length) return;
    const batch = takeBatch(limit);
    opts.write(merge(batch.chunks), () => {
      for (const callback of batch.callbacks) callback();
    });
    // Hit the cap with more queued — finish on the next flush so this one stays short.
    if (pendingHead < pending.length) schedule();
  }

  function onFrame(): void {
    frameHandle = null;
    clearScheduled();
    flush(maxFlushBytes);
  }

  function onTimer(): void {
    timerHandle = null;
    clearScheduled();
    // The timer may have fired off-screen, or it may itself be an overdue callback
    // running only after the WebView resumed. Keep the same cap in both cases.
    flush(maxFlushBytes);
  }

  return {
    push(bytes, onConsumed) {
      if (disposed || bytes.length === 0) return;
      pending.push({ bytes, onConsumed });
      schedule();
    },
    flushNow() {
      clearScheduled();
      if (disposed || pendingHead >= pending.length) return;
      // Queue every byte synchronously (for ordering) but never as an oversized
      // xterm parse unit. xterm can then yield between these bounded writes.
      while (pendingHead < pending.length) {
        const batch = takeBatch(maxFlushBytes);
        opts.write(merge(batch.chunks), () => {
          for (const callback of batch.callbacks) callback();
        });
      }
    },
    dispose() {
      disposed = true;
      clearScheduled();
      pending.length = 0;
      pendingHead = 0;
    },
  };
}
