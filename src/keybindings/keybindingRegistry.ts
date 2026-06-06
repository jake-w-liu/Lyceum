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
  { key: "mod+w", command: "editor.closeTab" },
  { key: "mod+tab", command: "editor.nextTab" },
  { key: "mod+shift+tab", command: "editor.previousTab" },
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
  if (expr === undefined) {
    return true;
  }
  const trimmed = expr.trim();
  if (trimmed === "") {
    return true;
  }
  const terms = trimmed.split("||");
  for (const term of terms) {
    const factors = term.split("&&");
    let termValue = true;
    for (const factor of factors) {
      const token = factor.trim();
      let negated = false;
      let id = token;
      if (id.startsWith("!")) {
        negated = true;
        id = id.slice(1).trim();
      }
      const value = ctx[id] === true;
      if ((negated ? !value : value) === false) {
        termValue = false;
        break;
      }
    }
    if (termValue) {
      return true;
    }
  }
  return false;
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
      return e.key.toLowerCase() === token;
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
