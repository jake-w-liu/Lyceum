// The single global keybinding handler (M4). Maps each keydown to a command id
// via the keybinding registry, then dispatches it through the command registry.
// Replaces the M1/M3 ad-hoc hooks. Editor-internal chords (find, comment,
// move-line, go-to-definition, …) are intentionally NOT in our keymap — Monaco
// handles those itself when the editor is focused.

import { useEffect } from "react";
import { isMac } from "./useLayoutKeybindings";
import {
  matchKeybinding,
  type KeyContext,
} from "../keybindings/keybindingRegistry";
import { commandRegistry } from "../commands/commandRegistry";
import { useUiStore } from "../state/uiStore";
import { useEditorStore } from "../state/editorStore";
import { useKeymapStore } from "../state/keymapStore";

/** Snapshot the `when`-clause context from the relevant stores. */
function buildContext(): KeyContext {
  const activeModal = useUiStore.getState().activeModal;
  const hasActiveDoc = useEditorStore.getState().activePath !== null;
  return {
    paletteOpen: activeModal === "palette",
    quickOpenOpen: activeModal === "quickOpen",
    modalOpen: activeModal !== null,
    editorFocus: activeModal === null && hasActiveDoc,
  };
}

export function useCommandKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const id = matchKeybinding(
        e,
        buildContext(),
        isMac(),
        useKeymapStore.getState().keymap,
      );
      if (!id) return;
      e.preventDefault();
      void commandRegistry.execute(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
