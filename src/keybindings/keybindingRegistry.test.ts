// Tests for the keybinding matcher and when-clause evaluator.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYMAP,
  evaluateWhen,
  formatChord,
  matchKeybinding,
} from "./keybindingRegistry";

describe("formatChord", () => {
  it("uses symbol glyphs on macOS", () => {
    expect(formatChord("mod+shift+p", true)).toBe("⇧⌘P");
    expect(formatChord("mod+s", true)).toBe("⌘S");
    expect(formatChord("mod+alt+s", true)).toBe("⌥⌘S");
    expect(formatChord("ctrl+backquote", true)).toBe("⌃`");
  });

  it("uses words joined by + on other platforms", () => {
    expect(formatChord("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatChord("mod+s", false)).toBe("Ctrl+S");
    expect(formatChord("mod+equal", false)).toBe("Ctrl+=");
  });
});

describe("matchKeybinding (isMacOs=false, ctx={})", () => {
  const ctx = {};

  it("ctrl+b => workbench.toggleSidebar", () => {
    const e = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
    expect(matchKeybinding(e, ctx, false)).toBe("workbench.toggleSidebar");
  });

  it("ctrl+shift+p => commandPalette.show", () => {
    const e = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, shiftKey: true });
    expect(matchKeybinding(e, ctx, false)).toBe("commandPalette.show");
  });

  it("ctrl+p => quickOpen.show", () => {
    const e = new KeyboardEvent("keydown", { key: "p", ctrlKey: true });
    expect(matchKeybinding(e, ctx, false)).toBe("quickOpen.show");
  });

  it("ctrl+backquote => terminal.toggle", () => {
    const e = new KeyboardEvent("keydown", { code: "Backquote", ctrlKey: true });
    expect(matchKeybinding(e, ctx, false)).toBe("terminal.toggle");
  });

  it("ctrl+enter => editor.run", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true });
    expect(matchKeybinding(e, ctx, false)).toBe("editor.run");
  });

  it("plain b (no ctrl) => null", () => {
    const e = new KeyboardEvent("keydown", { key: "b" });
    expect(matchKeybinding(e, ctx, false)).toBeNull();
  });
});

describe("matchKeybinding tab cycling (Ctrl on every platform)", () => {
  it("ctrl+tab => editor.nextTab on macOS", () => {
    const e = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("editor.nextTab");
  });

  it("ctrl+shift+tab => editor.previousTab on macOS", () => {
    const e = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(matchKeybinding(e, {}, true)).toBe("editor.previousTab");
  });

  it("ctrl+tab => editor.nextTab on other platforms", () => {
    const e = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true });
    expect(matchKeybinding(e, {}, false)).toBe("editor.nextTab");
  });

  it("meta+tab on macOS matches nothing (Cmd+Tab is the OS app switcher)", () => {
    const e = new KeyboardEvent("keydown", { key: "Tab", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBeNull();
  });

  it("renders the palette hint as ⌃Tab / Ctrl+Tab", () => {
    expect(formatChord("ctrl+tab", true)).toBe("⌃Tab");
    expect(formatChord("ctrl+shift+tab", true)).toBe("⌃⇧Tab");
    expect(formatChord("ctrl+tab", false)).toBe("Ctrl+Tab");
  });
});

describe("matchKeybinding Option/Alt letter remap (macOS)", () => {
  it("⌥⌘S matches file.saveAll even when Option remaps e.key", () => {
    // macOS reports the Option-remapped glyph for e.key (Option+S => "ß") while
    // e.code stays the physical "KeyS". The binding must still match.
    const e = new KeyboardEvent("keydown", {
      key: "ß",
      code: "KeyS",
      metaKey: true,
      altKey: true,
    });
    expect(matchKeybinding(e, {}, true)).toBe("file.saveAll");
  });

  it("does not use the physical code for a non-Alt letter binding", () => {
    // mod+s (no Alt): a layout that produces a different e.key must not match via
    // the physical code path. Here e.key is "x" but e.code is "KeyS".
    const e = new KeyboardEvent("keydown", {
      key: "x",
      code: "KeyS",
      metaKey: true,
    });
    expect(matchKeybinding(e, {}, true)).toBeNull();
  });
});

describe("matchKeybinding escape when-clause", () => {
  it("escape with ctx={} => null", () => {
    const e = new KeyboardEvent("keydown", { key: "Escape" });
    expect(matchKeybinding(e, {}, false)).toBeNull();
  });

  it("escape with ctx={paletteOpen:true} => workbench.dismiss", () => {
    const e = new KeyboardEvent("keydown", { key: "Escape" });
    expect(matchKeybinding(e, { paletteOpen: true }, false)).toBe("workbench.dismiss");
  });
});

describe("matchKeybinding user unbinds", () => {
  it("lets an empty command override consume a default chord", () => {
    const e = new KeyboardEvent("keydown", { key: "p", ctrlKey: true });
    expect(
      matchKeybinding(e, {}, false, [
        ...DEFAULT_KEYMAP,
        { key: "mod+p", command: "" },
      ]),
    ).toBe("");
  });
});

describe("matchKeybinding mod resolution", () => {
  it("mac metaKey+b => workbench.toggleSidebar", () => {
    const e = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("workbench.toggleSidebar");
  });

  it("mac ctrlKey+b => null", () => {
    const e = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
    expect(matchKeybinding(e, {}, true)).toBeNull();
  });

  it("mac ctrl+backquote => terminal.toggle", () => {
    const e = new KeyboardEvent("keydown", { code: "Backquote", ctrlKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("terminal.toggle");
  });

  it("mac meta+backquote => null", () => {
    const e = new KeyboardEvent("keydown", { code: "Backquote", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBeNull();
  });
});

describe("matchKeybinding editor font zoom", () => {
  it("mac meta+= (Equal, no shift) => view.zoomIn", () => {
    const e = new KeyboardEvent("keydown", { code: "Equal", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("view.zoomIn");
  });

  it("mac meta+shift+= (the + key) => view.zoomIn", () => {
    const e = new KeyboardEvent("keydown", {
      code: "Equal",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchKeybinding(e, {}, true)).toBe("view.zoomIn");
  });

  it("mac meta+- (Minus) => view.zoomOut", () => {
    const e = new KeyboardEvent("keydown", { code: "Minus", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("view.zoomOut");
  });

  it("mac meta+0 (Digit0) => view.resetZoom", () => {
    const e = new KeyboardEvent("keydown", { code: "Digit0", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("view.resetZoom");
  });

  it("win ctrl+= (Equal) => view.zoomIn", () => {
    const e = new KeyboardEvent("keydown", { code: "Equal", ctrlKey: true });
    expect(matchKeybinding(e, {}, false)).toBe("view.zoomIn");
  });

  it("plain = (no mod) => null", () => {
    const e = new KeyboardEvent("keydown", { code: "Equal" });
    expect(matchKeybinding(e, {}, true)).toBeNull();
  });
});

describe("evaluateWhen", () => {
  it("'a || b' with {b:true} => true", () => {
    expect(evaluateWhen("a || b", { b: true })).toBe(true);
  });

  it("'a' => false when absent", () => {
    expect(evaluateWhen("a", {})).toBe(false);
  });

  it("'!a' => true when absent", () => {
    expect(evaluateWhen("!a", {})).toBe(true);
  });

  it("'a && b' needs both", () => {
    expect(evaluateWhen("a && b", { a: true })).toBe(false);
    expect(evaluateWhen("a && b", { a: true, b: true })).toBe(true);
  });

  it("honors parentheses over default operator precedence", () => {
    expect(evaluateWhen("a && (b || c)", { a: true, c: true })).toBe(true);
    expect(evaluateWhen("(a || b) && c", { a: true })).toBe(false);
  });

  it("supports boolean equality", () => {
    expect(evaluateWhen("editorFocus == true", { editorFocus: true })).toBe(
      true,
    );
    expect(evaluateWhen("modalOpen == false", {})).toBe(true);
    expect(evaluateWhen("modalOpen == false", { modalOpen: true })).toBe(false);
  });

  it("returns false for malformed when expressions", () => {
    expect(evaluateWhen("a && (b ||", { a: true, b: true })).toBe(false);
    expect(evaluateWhen("a ?? b", { a: true, b: true })).toBe(false);
  });
});
