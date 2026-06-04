// Bridges native menu clicks to the command registry (M-menu): the Rust
// `on_menu_event` handler emits a `menu` event whose payload is a command id;
// run it. Degrades to a no-op outside Tauri (listen rejects).

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commandRegistry } from "../commands/commandRegistry";

export function useMenuCommands(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    listen<string>("menu", (event) => {
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
