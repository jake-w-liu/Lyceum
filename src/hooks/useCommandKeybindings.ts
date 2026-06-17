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
      const ctx = buildContext();
      const id = matchKeybinding(
        e,
        ctx,
        isMac(),
        useKeymapStore.getState().keymap,
      );
      if (id === null) return;
      if (id === "") {
        e.preventDefault();
        return;
      }
      // While a modal (Command Palette / Quick Open) owns the keyboard, only let
      // the dismiss command through — otherwise chords like Cmd+S / Cmd+W /
      // Cmd+Enter fire editor commands while the user is typing in the modal.
      // The chord is still consumed (preventDefault) so the WebView default
      // (e.g. Cmd+P print, Cmd+S save-page) can't fire either.
      if (ctx.modalOpen && id !== "workbench.dismiss") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      void commandRegistry.execute(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
