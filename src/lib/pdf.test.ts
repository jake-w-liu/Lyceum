// Tests for pure zoom/page helpers.

import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  ZOOM_MAX,
  ZOOM_MIN,
  capOutputScale,
  clampPage,
  clampZoom,
  zoomFromWheel,
  zoomIn,
  zoomOut,
} from "./pdf";

describe("clampZoom", () => {
  it("clamps below the lower bound", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });

  it("clamps above the upper bound", () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
  });

  it("passes through in-range values", () => {
    expect(clampZoom(1)).toBe(1);
  });
});

describe("zoomIn", () => {
  it("caps at ZOOM_MAX", () => {
    expect(zoomIn(5)).toBe(5);
  });

  it("zooms in by 1.25x", () => {
    expect(zoomIn(1)).toBe(1.25);
  });
});

describe("zoomOut", () => {
  it("floors at ZOOM_MIN", () => {
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });

  it("zooms out by 1.25x", () => {
    expect(zoomOut(1.25)).toBe(1);
  });
});

describe("zoomFromWheel", () => {
  it("zooms in for negative wheel delta", () => {
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1);
  });

  it("zooms out for positive wheel delta", () => {
    expect(zoomFromWheel(1, 100)).toBeLessThan(1);
  });

  it("respects zoom bounds", () => {
    expect(zoomFromWheel(ZOOM_MAX, -1000)).toBe(ZOOM_MAX);
    expect(zoomFromWheel(ZOOM_MIN, 1000)).toBe(ZOOM_MIN);
  });
});

describe("capOutputScale", () => {
  it("keeps the scale when the canvas fits the pixel budget", () => {
    // 612x792 at scale 2 ≈ 1.9M pixels, far under 2^25.
    expect(capOutputScale(612, 792, 2)).toBe(2);
  });

  it("reduces the scale so total pixels stay within the cap", () => {
    // A4-ish page at zoom 5 on a 2x display: 3060x3960x4 ≈ 48.5M pixels.
    const scale = capOutputScale(3060, 3960, 2);
    expect(scale).toBeLessThan(2);
    // The canvas floors each dimension, so assert on the actual allocation.
    expect(
      Math.floor(3060 * scale) * Math.floor(3960 * scale),
    ).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it("honors a custom pixel budget", () => {
    const scale = capOutputScale(100, 100, 2, 10_000);
    expect(100 * 100 * scale * scale).toBeLessThanOrEqual(10_000);
    expect(scale).toBeCloseTo(1, 5);
  });

  it("passes degenerate sizes through unchanged", () => {
    expect(capOutputScale(0, 0, 3)).toBe(3);
  });
});

describe("clampPage", () => {
  it("clamps below to 1", () => {
    expect(clampPage(0, 10)).toBe(1);
  });

  it("clamps above to total", () => {
    expect(clampPage(99, 10)).toBe(10);
  });

  it("passes through in-range values", () => {
    expect(clampPage(3, 10)).toBe(3);
  });

  it("returns 1 when total is less than 1", () => {
    expect(clampPage(1, 0)).toBe(1);
  });
});
