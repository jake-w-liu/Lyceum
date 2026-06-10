// Window-scoped event listener. Backend session events (terminal/julia/lsp/
// build/fs-watch) are emitted via emit_to(<window label>), but a plain
// `listen()` registers with target Any and would also receive other windows'
// identically-named events (per-window id counters collide across windows).
// Scoping the listener to the current webview window restores isolation.
import {
  listen,
  type EventCallback,
  type EventName,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export function listenScoped<T>(
  event: EventName,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  try {
    return getCurrentWebviewWindow().listen<T>(event, handler);
  } catch {
    // Outside Tauri (tests, plain browser) there is no current window.
    return listen<T>(event, handler);
  }
}
