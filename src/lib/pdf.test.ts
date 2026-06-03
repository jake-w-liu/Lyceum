// Tests for pure zoom/page helpers.

import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampPage,
  clampZoom,
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
