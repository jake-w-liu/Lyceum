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
import { useKeymapStore } from "../state/keymapStore";

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return document.activeElement instanceof Element
    ? document.activeElement
    : null;
}

function isTextInput(element: Element | null): boolean {
  if (!element) return false;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  const editable = element.closest<HTMLElement>("[contenteditable]");
  return editable?.isContentEditable === true;
}

/** Snapshot the `when`-clause context from the actual keyboard owner and stores. */
function buildContext(target: EventTarget | null): KeyContext {
  const activeModal = useUiStore.getState().activeModal;
  const element = eventTargetElement(target);
  return {
    paletteOpen: activeModal === "palette",
    quickOpenOpen: activeModal === "quickOpen",
    modalOpen: activeModal !== null,
    editorFocus:
      activeModal === null &&
      element !== null &&
      element.closest(".monaco-host") !== null,
    terminalFocus:
      activeModal === null &&
      element !== null &&
      element.closest(".terminal-view") !== null,
    textInputFocus: isTextInput(element),
    findWidgetVisible:
      activeModal === null &&
      document.querySelector(".monaco-host .find-widget.visible") !== null,
  };
}

export function useCommandKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctx = buildContext(e.target);
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
    // Workbench shortcuts must be observed before focused widgets (including
    // Monaco contributions such as completion/rename inputs) can stop bubbling.
    // Capture still preserves the keymap's modal/when guards above, so commands
    // are neither duplicated nor allowed through while a modal owns the keys.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
