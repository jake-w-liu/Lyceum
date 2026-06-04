// Small terminal key overrides that need to bypass xterm's browser-dependent
// KeyboardEvent -> byte mapping.

export type TerminalKeyOverride =
  | { type: "send"; data: string }
  | { type: "copy" }
  | { type: "paste" };

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
    const erase = "\b";
    return { type: "send", data: event.altKey ? `\x1b${erase}` : erase };
  }

  const mod = isMacOs ? event.metaKey : event.ctrlKey;
  if (!mod) return null;

  const key = event.key.toLowerCase();
  if (key === "c" && hasSelection) return { type: "copy" };
  if (key === "v") return { type: "paste" };
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
