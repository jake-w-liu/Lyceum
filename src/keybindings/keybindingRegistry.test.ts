// Tests for the keybinding matcher and when-clause evaluator.

import { describe, expect, it } from "vitest";
import { evaluateWhen, matchKeybinding } from "./keybindingRegistry";

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

describe("matchKeybinding mod resolution", () => {
  it("mac metaKey+b => workbench.toggleSidebar", () => {
    const e = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    expect(matchKeybinding(e, {}, true)).toBe("workbench.toggleSidebar");
  });

  it("mac ctrlKey+b => null", () => {
    const e = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
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
});
