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

export function clampPage(page: number, total: number): number {
  if (total < 1) return 1;
  return Math.min(total, Math.max(1, Math.round(page)));
}
