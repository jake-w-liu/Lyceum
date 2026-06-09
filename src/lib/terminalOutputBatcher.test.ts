import { describe, expect, it } from "vitest";
import { createOutputBatcher } from "./terminalOutputBatcher";

// Deterministic stand-in for requestAnimationFrame: queues callbacks and runs
// them only when the test calls runFrame(), so flush timing is fully controlled.
function fakeScheduler() {
  const frames = new Map<number, () => void>();
  let nextHandle = 1;
  const cancelled: number[] = [];
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
    runFrame: () => {
      // Run exactly one scheduled callback (the batcher only ever schedules one
      // at a time), mirroring a single animation frame.
      const [handle] = frames.keys();
      if (handle === undefined) return;
      const cb = frames.get(handle)!;
      frames.delete(handle);
      cb();
    },
    pending: () => frames.size,
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
    expect(Array.from(writes[0])).toEqual([1, 2, 3, 4, 5]);
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
  });

  it("dispose cancels a pending frame and drops buffered output", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.push(bytes(1, 2));
    b.dispose();
    expect(sched.pending()).toBe(0);
    sched.runFrame(); // no-op
    expect(writes).toHaveLength(0);
  });

  it("ignores pushes after dispose (no write, no schedule)", () => {
    const writes: Uint8Array[] = [];
    const sched = fakeScheduler();
    const b = createOutputBatcher({ write: (x) => writes.push(x), ...sched });
    b.dispose();
    b.push(bytes(1));
    expect(sched.pending()).toBe(0);
    b.flushNow();
    expect(writes).toHaveLength(0);
  });
});
