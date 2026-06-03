import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_LINES,
  initialOutputData,
  useOutputStore,
} from "./outputStore";

const get = () => useOutputStore.getState();

beforeEach(() => useOutputStore.setState(initialOutputData, false));

describe("outputStore", () => {
  it("appends and clears lines", () => {
    get().append("a");
    get().append("b");
    expect(get().lines).toEqual(["a", "b"]);
    get().clear();
    expect(get().lines).toEqual([]);
  });

  it("tracks running state", () => {
    get().setRunning(true);
    expect(get().running).toBe(true);
    get().setRunning(false);
    expect(get().running).toBe(false);
  });

  it("caps the buffer at MAX_OUTPUT_LINES, keeping the most recent lines", () => {
    for (let i = 0; i < MAX_OUTPUT_LINES + 250; i += 1) get().append(`line ${i}`);
    const lines = get().lines;
    expect(lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(lines[lines.length - 1]).toBe(`line ${MAX_OUTPUT_LINES + 249}`);
    expect(lines[0]).toBe("line 250"); // oldest 250 dropped
  });
});
