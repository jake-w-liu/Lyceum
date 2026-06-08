// Small terminal key overrides that need to bypass xterm's browser-dependent
// KeyboardEvent -> byte mapping.

export type TerminalKeyOverride =
  | { type: "send"; data: string }
  | { type: "copy" };

type KeyLike = Pick<
  KeyboardEvent,
  "type" | "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & {
  keyCode?: number;
  which?: number;
};

export function terminalKeyOverride(
  event: KeyLike,
  isMacOs: boolean,
  hasSelection: boolean,
): TerminalKeyOverride | null {
  if (event.type !== "keydown") return null;

  if (isBackspace(event)) {
    const erase = "\x7f";
    return { type: "send", data: event.altKey ? `\x1b${erase}` : erase };
  }

  const mod = isMacOs ? event.metaKey : event.ctrlKey;
  if (!mod) return null;

  const key = event.key.toLowerCase();
  if (key === "c" && hasSelection) return { type: "copy" };
  // Paste is intentionally NOT overridden: xterm pastes natively from the
  // browser `paste` event (Cmd/Ctrl+V on the focused textarea). Reading the
  // clipboard ourselves here both double-pasted (our send + xterm's native
  // paste) and triggered the macOS clipboard-permission "Paste" prompt.
  return null;
}

function isBackspace(event: KeyLike): boolean {
  return (
    event.key === "Backspace" ||
    event.code === "Backspace" ||
    event.keyCode === 8 ||
    event.which === 8
  );
}
