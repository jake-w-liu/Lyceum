// Bridges native menu clicks to the command registry (M-menu): the Rust
// `on_menu_event` handler emits a `menu` event whose payload is a command id;
// run it. Degrades to a no-op outside Tauri (listen rejects).

import { useEffect } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { listenScoped } from "../lib/windowEvents";
import { commandRegistry } from "../commands/commandRegistry";

export function useMenuCommands(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    // Window-scoped: the backend emits "menu" to the focused window only, but a
    // target-Any listener would receive every window's menu events (an
    // unfocused clean window would e.g. execute "quit" and skip the focused
    // window's unsaved-changes prompt).
    listenScoped<string>("menu", (event) => {
      void commandRegistry.execute(event.payload);
    })
      .then((fn) => {
        // If the effect was already cleaned up before listen() resolved, unlisten
        // immediately — otherwise the listener leaks and re-fires every command.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not running inside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
