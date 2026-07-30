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
    const erase = "\x7f";
    return { type: "send", data: event.altKey ? `\x1b${erase}` : erase };
  }

  const mod = isMacOs ? event.metaKey : event.ctrlKey;
  if (!mod) return null;

  const key = event.key.toLowerCase();
  if (key === "c" && hasSelection) return { type: "copy" };
  // WKWebView does not reliably synthesize a DOM `paste` event for the native
  // menu accelerator. Own the chord and read through Tauri's native clipboard
  // plugin; TerminalView cancels the keydown so xterm cannot also paste it.
  if (key === "v") return { type: "paste" };
  return null;
}

/**
 * Whether the browser's own default action for this key event must be
 * suppressed even though xterm keeps handling the event.
 *
 * xterm forwards printable characters to the PTY from its `keypress` handler,
 * but only cancels the DOM event when the (deprecated, default-off)
 * `cancelEvents` option is set. With the default, WebKit still runs the default
 * action and inserts the character into xterm's hidden helper textarea. The
 * uncancelled path is exactly `A`-`Z` — the capitals produced with Shift — since
 * xterm's keydown handler returns early for those (its macOS caps-lock/IME
 * workaround) and only lowercase keys reach the branch that cancels.
 *
 * That leftover text is never cleared, and xterm's IME composition helper later
 * re-reads the textarea by offset (`value.substring(compositionStart)`) or in
 * full, so residue can be transmitted to the shell a second time. Suppressing
 * the default insertion keeps the helper textarea empty except while an IME is
 * actually composing; the character still reaches the PTY because xterm sends it
 * itself, independently of `defaultPrevented`.
 */
export function suppressesNativeTextInsertion(event: Pick<KeyLike, "type">): boolean {
  return event.type === "keypress";
}

function isBackspace(event: KeyLike): boolean {
  return (
    event.key === "Backspace" ||
    event.code === "Backspace" ||
    event.keyCode === 8 ||
    event.which === 8
  );
}
