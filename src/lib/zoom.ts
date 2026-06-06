// Window zoom (VS Code-style "View: Zoom In/Out"). Uses the native webview zoom
// so the ENTIRE UI scales — explorer, tabs, terminal, editor — and Monaco's
// mouse mapping stays correct (unlike a CSS transform/zoom hack). The zoom level
// lives in settings (persisted); this module turns it into a scale factor and
// applies it to the webview, re-applying whenever the setting changes.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSettingsStore } from "../state/settingsStore";

/** VS Code uses 20% steps: factor = 1.2^level (level 0 → 100%). */
export function zoomFactor(level: number): number {
  return Math.pow(1.2, level);
}

/** Apply a zoom level to the webview. No-op outside Tauri. */
export async function applyZoom(level: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(zoomFactor(level));
  } catch {
    // not running in Tauri (tests / dev preview)
  }
}

let initialized = false;

/** Apply the persisted zoom once and keep the webview in sync with the setting. */
export function initZoom(): void {
  if (initialized) return;
  initialized = true;
  void applyZoom(useSettingsStore.getState().settings.zoomLevel);
  useSettingsStore.subscribe((s, prev) => {
    if (s.settings.zoomLevel !== prev.settings.zoomLevel) {
      void applyZoom(s.settings.zoomLevel);
    }
  });
}
