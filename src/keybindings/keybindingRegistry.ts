// Keybinding matcher mapping keyboard events to command ids for the workbench keymap.

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
}

export type KeyContext = Record<string, boolean>;

// The active workbench keymap (editor-internal chords like find/comment/move-line are handled by Monaco itself and are intentionally NOT here):
export const DEFAULT_KEYMAP: Keybinding[] = [
  { key: "mod+p", command: "quickOpen.show" },
  { key: "mod+shift+p", command: "commandPalette.show" },
  { key: "mod+n", command: "explorer.newFile" },
  { key: "mod+shift+n", command: "explorer.newFolder" },
  { key: "mod+b", command: "workbench.toggleSidebar" },
  { key: "ctrl+backquote", command: "terminal.toggle" },
  { key: "ctrl+shift+backquote", command: "terminal.new" },
  { key: "mod+j", command: "workbench.toggleBottomPanel" },
  { key: "mod+s", command: "file.save" },
  { key: "mod+alt+s", command: "file.saveAll" },
  { key: "mod+shift+e", command: "explorer.revealActiveFile" },
  { key: "mod+w", command: "editor.closeTab" },
  // Ctrl on EVERY platform (VS Code convention): on macOS Cmd+Tab is the OS
  // app switcher and never reaches the WebView, so mod+tab would be dead.
  { key: "ctrl+tab", command: "editor.nextTab" },
  { key: "ctrl+shift+tab", command: "editor.previousTab" },
  { key: "mod+shift+v", command: "preview.open" },
  { key: "mod+shift+f", command: "workbench.searchWorkspace" },
  { key: "mod+enter", command: "editor.run" },
  // Editor font zoom (VS Code-style). Both with and without Shift on the Equal
  // key so Cmd+= and Cmd++ both enlarge; Cmd+- shrinks; Cmd+0 resets.
  { key: "mod+equal", command: "view.zoomIn" },
  { key: "mod+shift+equal", command: "view.zoomIn" },
  { key: "mod+minus", command: "view.zoomOut" },
  { key: "mod+shift+minus", command: "view.zoomOut" },
  { key: "mod+digit0", command: "view.resetZoom" },
  { key: "escape", command: "workbench.dismiss", when: "paletteOpen || quickOpenOpen || modalOpen" },
];

const MODIFIER_TOKENS = new Set(["mod", "cmd", "ctrl", "alt", "shift", "meta"]);

export function evaluateWhen(expr: string | undefined, ctx: KeyContext): boolean {
  if (expr === undefined) return true;
  const trimmed = expr.trim();
  if (trimmed === "") return true;
  const parser = new WhenParser(tokenizeWhen(trimmed), ctx);
  return parser.parse();
}

type WhenToken =
  | { type: "ident"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "and" | "or" | "not" | "eq" | "lparen" | "rparen" | "invalid" };

function tokenizeWhen(expr: string): WhenToken[] {
  const tokens: WhenToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (expr.startsWith("&&", i)) {
      tokens.push({ type: "and" });
      i += 2;
    } else if (expr.startsWith("||", i)) {
      tokens.push({ type: "or" });
      i += 2;
    } else if (expr.startsWith("==", i)) {
      tokens.push({ type: "eq" });
      i += 2;
    } else if (ch === "!") {
      tokens.push({ type: "not" });
      i += 1;
    } else if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
    } else if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < expr.length && /[A-Za-z0-9_.-]/.test(expr[end])) end += 1;
      const value = expr.slice(i, end);
      if (value === "true" || value === "false") {
        tokens.push({ type: "bool", value: value === "true" });
      } else {
        tokens.push({ type: "ident", value });
      }
      i = end;
    } else {
      tokens.push({ type: "invalid" });
      i += 1;
    }
  }
  return tokens;
}

class WhenParser {
  private pos = 0;

  constructor(
    private readonly tokens: WhenToken[],
    private readonly ctx: KeyContext,
  ) {}

  parse(): boolean {
    const result = this.parseOr();
    return result !== null && this.pos === this.tokens.length ? result : false;
  }

  private parseOr(): boolean | null {
    let value = this.parseAnd();
    if (value === null) return null;
    while (this.match("or")) {
      const right = this.parseAnd();
      if (right === null) return null;
      value = value || right;
    }
    return value;
  }

  private parseAnd(): boolean | null {
    let value = this.parseEquality();
    if (value === null) return null;
    while (this.match("and")) {
      const right = this.parseEquality();
      if (right === null) return null;
      value = value && right;
    }
    return value;
  }

  private parseEquality(): boolean | null {
    let value = this.parseUnary();
    if (value === null) return null;
    while (this.match("eq")) {
      const right = this.parseUnary();
      if (right === null) return null;
      value = value === right;
    }
    return value;
  }

  private parseUnary(): boolean | null {
    if (this.match("not")) {
      const value = this.parseUnary();
      return value === null ? null : !value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): boolean | null {
    const token = this.tokens[this.pos];
    if (!token) return null;
    if (token.type === "ident") {
      this.pos += 1;
      return this.ctx[token.value] === true;
    }
    if (token.type === "bool") {
      this.pos += 1;
      return token.value;
    }
    if (token.type === "lparen") {
      this.pos += 1;
      const value = this.parseOr();
      if (value === null || !this.match("rparen")) return null;
      return value;
    }
    return null;
  }

  private match(type: WhenToken["type"]): boolean {
    if (this.tokens[this.pos]?.type !== type) return false;
    this.pos += 1;
    return true;
  }
}

interface Chord {
  mod: boolean;
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  mainKey: string;
}

function parseChord(key: string): Chord {
  const chord: Chord = {
    mod: false,
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    mainKey: "",
  };
  const tokens = key.split("+");
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    if (MODIFIER_TOKENS.has(token)) {
      switch (token) {
        case "mod":
          chord.mod = true;
          break;
        case "cmd":
          chord.cmd = true;
          break;
        case "ctrl":
          chord.ctrl = true;
          break;
        case "alt":
          chord.alt = true;
          break;
        case "shift":
          chord.shift = true;
          break;
        case "meta":
          chord.meta = true;
          break;
      }
    } else {
      chord.mainKey = token;
    }
  }
  return chord;
}

// Human-readable label for a chord's main key (the non-modifier token).
const MAIN_KEY_LABELS: Record<string, string> = {
  backquote: "`",
  equal: "=",
  minus: "-",
  digit0: "0",
  tab: "Tab",
  enter: "Enter",
  escape: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  f12: "F12",
};

function mainKeyLabel(token: string): string {
  if (token in MAIN_KEY_LABELS) return MAIN_KEY_LABELS[token];
  return token.length === 1 ? token.toUpperCase() : token;
}

/**
 * Pretty-print a keymap chord (e.g. "mod+shift+p") for display next to a command.
 * On macOS uses the symbol glyphs (⌃⌥⇧⌘); elsewhere uses Ctrl/Alt/Shift words.
 * `mod` resolves to ⌘ on macOS and Ctrl otherwise, matching the matcher.
 */
export function formatChord(key: string, isMacOs: boolean): string {
  const chord = parseChord(key);
  const wantsCtrl = chord.ctrl || (chord.mod && !isMacOs);
  const wantsMeta = chord.cmd || chord.meta || (chord.mod && isMacOs);
  const main = mainKeyLabel(chord.mainKey);
  if (isMacOs) {
    return (
      (wantsCtrl ? "⌃" : "") +
      (chord.alt ? "⌥" : "") +
      (chord.shift ? "⇧" : "") +
      (wantsMeta ? "⌘" : "") +
      main
    );
  }
  const parts: string[] = [];
  if (wantsCtrl || wantsMeta) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(main);
  return parts.join("+");
}

function matchMainKey(token: string, e: KeyboardEvent): boolean {
  switch (token) {
    case "backquote":
      return e.code === "Backquote";
    // Match the physical key by `code` so the binding is layout-independent and
    // unaffected by Shift turning "=" into "+" or "-" into "_".
    case "equal":
      return e.code === "Equal";
    case "minus":
      return e.code === "Minus";
    case "digit0":
      return e.code === "Digit0";
    case "tab":
      return e.key === "Tab";
    case "enter":
      return e.key === "Enter";
    case "escape":
      return e.key === "Escape";
    case "f12":
      return e.key === "F12";
    case "up":
      return e.key === "ArrowUp";
    case "down":
      return e.key === "ArrowDown";
    case "left":
      return e.key === "ArrowLeft";
    case "right":
      return e.key === "ArrowRight";
    default:
      if (e.key.toLowerCase() === token) return true;
      // macOS Option/Alt remaps the produced character (Option+S => "ß"), so a
      // letter binding's e.key no longer equals the token and the shortcut (e.g.
      // ⌥⌘S Save All) silently never fires. When Alt is held, also accept the
      // physical key code (KeyS for "s"). Gated on altKey so ordinary letter
      // bindings still follow the keyboard layout via e.key (don't break Dvorak).
      if (e.altKey && /^[a-z]$/.test(token)) {
        return e.code === "Key" + token.toUpperCase();
      }
      return false;
  }
}

function matchChord(chord: Chord, e: KeyboardEvent, isMacOs: boolean): boolean {
  if (chord.shift !== e.shiftKey) {
    return false;
  }
  if (chord.alt !== e.altKey) {
    return false;
  }

  const wantsCtrl = chord.ctrl || (chord.mod && !isMacOs);
  const wantsMeta = chord.cmd || chord.meta || (chord.mod && isMacOs);
  if (e.ctrlKey !== wantsCtrl || e.metaKey !== wantsMeta) {
    return false;
  }

  return matchMainKey(chord.mainKey, e);
}

// Parsed chords cached per keymap array identity. matchKeybinding runs on every
// keydown; a chord parse depends only on the static `key` string, so re-parsing
// the whole keymap per keystroke is wasted work. Both DEFAULT_KEYMAP and the
// keymap store's `[...DEFAULT_KEYMAP, ...user]` yield a stable array reference
// per keymap version, so the cache invalidates automatically on change.
const chordCache = new WeakMap<Keybinding[], Chord[]>();

function getChords(keymap: Keybinding[]): Chord[] {
  let chords = chordCache.get(keymap);
  if (!chords) {
    chords = keymap.map((b) => parseChord(b.key));
    chordCache.set(keymap, chords);
  }
  return chords;
}

export function matchKeybinding(
  e: KeyboardEvent,
  ctx: KeyContext,
  isMacOs: boolean,
  keymap: Keybinding[] = DEFAULT_KEYMAP
): string | null {
  const chords = getChords(keymap);
  let result: string | null = null;
  for (let i = 0; i < keymap.length; i++) {
    if (matchChord(chords[i], e, isMacOs) && evaluateWhen(keymap[i].when, ctx)) {
      result = keymap[i].command;
    }
  }
  return result;
}
