import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  appendOutputBuffered,
  bufferedOutputLineCount,
  flushOutputBuffer,
  initialOutputData,
  resetOutputBuffer,
  useOutputStore,
} from "./outputStore";

const get = () => useOutputStore.getState();

beforeEach(() => {
  resetOutputBuffer();
  useOutputStore.setState(initialOutputData, false);
});

describe("outputStore", () => {
  it("appends and clears lines", () => {
    get().append("a");
    get().append("b");
    expect(get().lines).toEqual(["a", "b"]);
    get().clear();
    expect(get().lines).toEqual([]);
  });

  it("clear() drops buffered-but-unflushed streamed lines", () => {
    // Buffer streamed output (as a live run would), then clear before the
    // animation-frame flush runs. The buffered lines must NOT reappear.
    appendOutputBuffered("streamed-1");
    appendOutputBuffered("streamed-2");
    get().clear();
    flushOutputBuffer(); // simulate the pending frame firing after clear
    expect(get().lines).toEqual([]);
  });

  it("tracks running state", () => {
    get().setRunning(true);
    expect(get().running).toBe(true);
    get().setRunning(false);
    expect(get().running).toBe(false);
  });

  it("caps the buffer at MAX_OUTPUT_LINES, keeping the most recent lines", () => {
    // Seed the near-cap history in one production batch, then exercise the
    // single-line append at the boundary. Repeating thousands of immutable
    // Zustand updates here only tests allocator speed and can time out when the
    // suite shares a busy CI host; both actions use the same capping helper.
    get().appendMany(
      Array.from(
        { length: MAX_OUTPUT_LINES + 249 },
        (_, i) => `line ${i}`,
      ),
    );
    get().append(`line ${MAX_OUTPUT_LINES + 249}`);
    const lines = get().lines;
    expect(lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(lines[lines.length - 1]).toBe(`line ${MAX_OUTPUT_LINES + 249}`);
    expect(lines[0]).toBe("line 250"); // oldest 250 dropped
  });

  it("caps streamed output before a suspended animation frame resumes", () => {
    for (let i = 0; i < MAX_OUTPUT_LINES * 3; i += 1) {
      appendOutputBuffered(`stream ${i}`);
    }

    expect(bufferedOutputLineCount()).toBe(MAX_OUTPUT_LINES);
    flushOutputBuffer();

    expect(get().lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(get().lines[0]).toBe(`stream ${MAX_OUTPUT_LINES * 2}`);
    expect(get().lines[get().lines.length - 1]).toBe(
      `stream ${MAX_OUTPUT_LINES * 3 - 1}`,
    );
  });

  it("caps retained output by text size, keeping the newest tail", () => {
    const chunk = "x".repeat(Math.floor(MAX_OUTPUT_CHARS / 3));
    for (let i = 0; i < 5; i += 1) get().append(`${i}${chunk}`);

    const lines = get().lines;
    expect(lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(
      MAX_OUTPUT_CHARS,
    );
    expect(lines[lines.length - 1]?.startsWith("4")).toBe(true);
    expect(lines.some((line) => line.startsWith("0"))).toBe(false);
  });

  it("caps buffered output by text size while animation frames are suspended", () => {
    const chunk = "y".repeat(Math.floor(MAX_OUTPUT_CHARS / 2));
    appendOutputBuffered(`old${chunk}`);
    appendOutputBuffered(`middle${chunk}`);
    appendOutputBuffered(`new${chunk}`);
    flushOutputBuffer();

    const lines = get().lines;
    expect(lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(
      MAX_OUTPUT_CHARS,
    );
    expect(lines[lines.length - 1]?.startsWith("new")).toBe(true);
    expect(lines.some((line) => line.startsWith("old"))).toBe(false);
  });

  it("truncates one oversized line without splitting a surrogate pair", () => {
    get().append(`old${"z".repeat(MAX_OUTPUT_CHARS)}😀`);
    const [line] = get().lines;

    expect(line.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(line.endsWith("😀")).toBe(true);
    expect(line.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });
});
