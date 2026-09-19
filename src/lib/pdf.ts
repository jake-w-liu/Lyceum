// Pure zoom/page helpers for the PDF preview.

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function zoomIn(z: number): number {
  return clampZoom(z * 1.25);
}

export function zoomOut(z: number): number {
  return clampZoom(z / 1.25);
}

export function zoomFromWheel(z: number, deltaY: number): number {
  if (deltaY === 0) return clampZoom(z);
  return clampZoom(z * Math.exp(-deltaY / 500));
}

export function clampPage(page: number, total: number): number {
  if (total < 1) return 1;
  return Math.min(total, Math.max(1, Math.round(page)));
}

/**
 * Cap on a page canvas's total pixels (like pdf.js's `maxCanvasPixels`).
 * Beyond this, huge pages at high zoom on HiDPI displays cost hundreds of MB
 * of RGBA and can exceed WebKit's canvas size limits (rendering blank).
 */
export const MAX_CANVAS_PIXELS = 1 << 25; // 2^25 ≈ 33.5M pixels

/**
 * Reduce `outputScale` (the devicePixelRatio multiplier) just enough that a
 * `width × height` CSS-pixel canvas stays within `maxPixels` total pixels.
 * The canvas is then stretched to its CSS size, trading sharpness at extreme
 * zoom for bounded memory and a canvas the platform can actually paint.
 */
/**
 * Largest single canvas side (in device pixels) WebKit will reliably paint.
 * The area cap alone allows a very elongated page (small area, huge one side)
 * to exceed this, so a per-side cap is applied as well.
 */
export const MAX_CANVAS_SIDE = 16384;

export function capOutputScale(
  width: number,
  height: number,
  outputScale: number,
  maxPixels = MAX_CANVAS_PIXELS,
  maxSide = MAX_CANVAS_SIDE,
): number {
  const area = width * height;
  if (area <= 0) return outputScale;
  const areaScale =
    area * outputScale * outputScale <= maxPixels
      ? outputScale
      : Math.sqrt(maxPixels / area);
  const longest = Math.max(width, height);
  const sideScale = longest > 0 ? maxSide / longest : areaScale;
  return Math.min(areaScale, sideScale);
}
