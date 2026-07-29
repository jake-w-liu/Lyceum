import { describe, expect, it } from "vitest";
import { createOutputBatcher } from "./terminalOutputBatcher";

// Deterministic stand-in for requestAnimationFrame + setTimeout: queues
// callbacks and runs them only when the test asks, so flush timing is fully
// controlled. Frames and timers are tracked separately so a test can simulate a
// document that is not being rendered (frames never run, timers still do).
function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let nextHandle = 1;
  const cancelled: number[] = [];
  const cancelledTimers: number[] = [];
  return {
    requestFrame: (cb: () => void) => {
      const handle = nextHandle++;
      frames.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle: number) => {
      cancelled.push(handle);
      frames.delete(handle);
    },
    requestTimer: (cb: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { cb, ms });
      return handle;
    },
    cancelTimer: (handle: number) => {
      cancelledTimers.push(handle);
      timers.delete(handle);
    },
    runFrame: () => {
      // Run exactly one scheduled callback (the batcher only ever schedules one
      // at a time), mirroring a single animation frame.
      const [handle] = frames.keys();
      if (handle === undefined) return;
      const cb = frames.get(handle)!;
      frames.delete(handle);
      cb();
    },
    runTimer: () => {
      const [handle] = timers.keys();
      if (handle === undefined) return;
      const entry = timers.get(handle)!;
      timers.delete(handle);
      entry.cb();
    },
    timerDelay: () => {
      const [entry] = timers.values();
      return entry?.ms;
    },
    pending: () => frames.size,
    pendingTimers: () => timers.size,
    cancelledCount: () => cancelled.length,
  };
}

const bytes = (...vals: number[]) => Uint8Array.from(vals);
const concat = (writes: Uint8Array[]) => {
  const total = writes.reduce((n, w) => n + w.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const w of writes) {
    out.set(w, off);
    off += w.length;
  }
  return out;
};

describe("createOutputBatcher", () => {
  it("merges chunks pushed before a frame into a single write", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });

    b.push(bytes(1, 2));
    b.push(bytes(3));
    b.push(bytes(4, 5));
    expect(writes).toHaveLength(0); // nothing until the frame runs

    sched.runFrame();
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("only schedules one frame for a burst", () => {
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: () => {}, ...sched });
    b.push(bytes(1));
    b.push(bytes(2));
    b.push(bytes(3));
    expect(sched.pending()).toBe(1);
  });

  it("splits a large backlog across frames using the byte cap", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: (x) => writes.push(x),
      maxFlushBytes: 4,
      ...sched,
    });
    // 5 chunks of 2 bytes = 10 bytes; cap 4 → at most 2 chunks per frame.
    for (let i = 0; i < 5; i += 1) b.push(bytes(i, i));

    sched.runFrame();
    expect(writes).toHaveLength(1);
    expect(writes[0].length).toBe(4);
    expect(sched.pending()).toBe(1); // re-scheduled itself for the remainder

    sched.runFrame();
    sched.runFrame();
    expect(concat(writes).length).toBe(10); // everything eventually written, in order
    expect(Array.from(concat(writes))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("keeps the default xterm parse unit at 64 KiB", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(new Uint8Array(128 * 1024));

    sched.runFrame();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(64 * 1024);
    expect(sched.pending()).toBe(1);
  });

  it("always makes progress even when a single chunk exceeds the cap", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: (x) => writes.push(x),
      maxFlushBytes: 2,
      ...sched,
    });
    b.push(bytes(1, 2, 3, 4, 5)); // 5 bytes > cap of 2
    sched.runFrame();
    expect(Array.from(writes[0])).toEqual([1, 2]);
    sched.runFrame();
    sched.runFrame();
    expect(Array.from(concat(writes))).toEqual([1, 2, 3, 4, 5]);
    expect(writes.every((write) => write.length <= 2)).toBe(true);
  });

  it("flushNow writes everything immediately and cancels the pending frame", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(bytes(1));
    b.push(bytes(2));
    expect(sched.pending()).toBe(1);

    b.flushNow();
    expect(Array.from(writes[0])).toEqual([1, 2]);
    expect(sched.pending()).toBe(0); // frame was cancelled
    expect(sched.pendingTimers()).toBe(0); // and so was the fallback
    expect(sched.cancelledCount()).toBe(1);
  });

  it("flushNow before an external write preserves output order", () => {
    // Models TerminalView's exit handler: drain buffered output, then print the
    // exit notice — the notice must come last.
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(bytes(10, 11));
    b.flushNow();
    writes.push(bytes(99)); // the out-of-band "[exited]" write
    expect(Array.from(concat(writes))).toEqual([10, 11, 99]);
  });

  it("flushNow with nothing buffered does not write", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.flushNow();
    expect(writes).toHaveLength(0);
  });

  it("ignores empty chunks", () => {
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: () => {}, ...sched });
    b.push(new Uint8Array(0));
    expect(sched.pending()).toBe(0);
    expect(sched.pendingTimers()).toBe(0);
  });

  it("dispose cancels a pending frame and drops buffered output", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(bytes(1, 2));
    b.dispose();
    expect(sched.pending()).toBe(0);
    expect(sched.pendingTimers()).toBe(0);
    sched.runFrame(); // no-op
    sched.runTimer(); // no-op
    expect(writes).toHaveLength(0);
  });

  it("ignores pushes after dispose (no write, no schedule)", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.dispose();
    b.push(bytes(1));
    expect(sched.pending()).toBe(0);
    expect(sched.pendingTimers()).toBe(0);
    b.flushNow();
    expect(writes).toHaveLength(0);
  });

  // --- no-frames fallback (window minimised / occluded / on another Space) ---

  it("arms a slower fallback alongside every frame", () => {
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: () => {},
      idleFlushDelayMs: 250,
      ...sched,
    });
    b.push(bytes(1));
    expect(sched.pending()).toBe(1);
    expect(sched.pendingTimers()).toBe(1);
    expect(sched.timerDelay()).toBe(250);
  });

  it("keeps each fallback write capped when a suspended window resumes", () => {
    // The document is not being rendered, so requestAnimationFrame callbacks are
    // never invoked. The timer itself may also be suspended until the window
    // returns; it must not bypass the cap and hand xterm one giant parse unit.
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: (x) => writes.push(x),
      maxFlushBytes: 4,
      ...sched,
    });
    for (let i = 0; i < 100; i += 1) b.push(bytes(i, i));

    sched.runTimer();

    expect(writes).toHaveLength(1);
    expect(writes[0].length).toBe(4);
    expect(sched.pending()).toBe(1);
    expect(sched.pendingTimers()).toBe(1);

    while (sched.pendingTimers() > 0) sched.runTimer();
    expect(concat(writes).length).toBe(200);
    expect(writes.every((write) => write.length <= 4)).toBe(true);
  });

  it("flushNow preserves order without creating an oversized xterm write", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: (x) => writes.push(x),
      maxFlushBytes: 4,
      ...sched,
    });
    b.push(bytes(1, 2, 3));
    b.push(bytes(4, 5, 6));
    b.push(bytes(7, 8, 9, 10, 11)); // one source chunk can itself exceed the cap

    b.flushNow();

    expect(writes.every((write) => write.length <= 4)).toBe(true);
    expect(Array.from(concat(writes))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(sched.pending()).toBe(0);
    expect(sched.pendingTimers()).toBe(0);
  });

  it("acknowledges source chunks only after xterm reports them parsed", () => {
    const writes: Uint8Array[] = [];
    const parsed: Array<() => void> = [];
    const acknowledgements: number[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({
      write: (x, onParsed) => {
        writes.push(x);
        parsed.push(onParsed);
      },
      maxFlushBytes: 4,
      ...sched,
    });
    b.push(bytes(1, 2), () => acknowledgements.push(1));
    b.push(bytes(3, 4, 5), () => acknowledgements.push(2));

    sched.runFrame();
    expect(Array.from(writes[0])).toEqual([1, 2, 3, 4]);
    expect(acknowledgements).toEqual([]);
    parsed[0]();
    expect(acknowledgements).toEqual([1]);

    sched.runFrame();
    parsed[1]();
    expect(acknowledgements).toEqual([1, 2]);
  });

  it("a frame cancels the fallback so output is never written twice", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(bytes(1, 2));

    sched.runFrame();
    sched.runTimer(); // the fallback was cancelled by the frame; this is a no-op

    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0])).toEqual([1, 2]);
  });

  it("keeps flushing on later fallbacks while frames stay stopped", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });

    b.push(bytes(1));
    sched.runTimer();
    b.push(bytes(2));
    expect(sched.pendingTimers()).toBe(1); // re-armed for the next chunk
    sched.runTimer();

    expect(Array.from(concat(writes))).toEqual([1, 2]);
  });
});
