// Coalesces PTY output before it reaches xterm.
//
// The backend emits one event per read (≤ a few KB). Writing each one to xterm
// separately is fine while streaming live, but after the screen unlocks (or any
// burst where the webview was throttled) a large backlog of tiny chunks arrives
// at once — writing them one-by-one makes xterm parse and reflow thousands of
// times and stalls the UI. This batcher buffers chunks and flushes them merged,
// once per animation frame, capped per flush so even a huge backlog is written
// across several frames instead of freezing one.
//
// Scheduling is injected (requestFrame/cancelFrame) so the logic is unit-tested
// with a deterministic fake scheduler; TerminalView wires real requestAnimationFrame.

export interface OutputBatcherOptions {
  /** Write merged bytes to the sink (xterm). */
  write: (bytes: Uint8Array) => void;
  /** Schedule a flush; returns a handle. Real impl: requestAnimationFrame. */
  requestFrame: (cb: () => void) => number;
  /** Cancel a scheduled flush. Real impl: cancelAnimationFrame. */
  cancelFrame: (handle: number) => void;
  /** Max bytes written per flush (default 256 KiB). Keeps each frame short. */
  maxFlushBytes?: number;
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
  const pending: Uint8Array[] = [];
  let handle: number | null = null;
  let disposed = false;

  // Take as many leading chunks as fit under the byte cap (always at least one,
  // so an oversized single chunk still makes progress).
  function takeBatch(): Uint8Array[] {
    let total = 0;
    let count = 0;
    for (const chunk of pending) {
      if (count > 0 && total + chunk.length > maxFlushBytes) break;
      total += chunk.length;
      count += 1;
    }
    return pending.splice(0, count);
  }

  function schedule(): void {
    if (disposed) return;
    if (handle === null) handle = opts.requestFrame(flush);
  }

  function flush(): void {
    handle = null;
    if (disposed || pending.length === 0) return;
    opts.write(merge(takeBatch()));
    // Hit the cap with more queued — finish on the next frame so this one stays short.
    if (pending.length > 0) schedule();
  }

  return {
    push(bytes) {
      if (disposed || bytes.length === 0) return;
      pending.push(bytes);
      schedule();
    },
    flushNow() {
      if (handle !== null) {
        opts.cancelFrame(handle);
        handle = null;
      }
      if (disposed || pending.length === 0) return;
      opts.write(merge(pending.splice(0)));
    },
    dispose() {
      disposed = true;
      if (handle !== null) {
        opts.cancelFrame(handle);
        handle = null;
      }
      pending.length = 0;
    },
  };
}
