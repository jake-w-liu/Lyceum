import { describe, expect, it } from "vitest";
import { terminalKeyOverride } from "./terminalKeys";

const ev = (init: Partial<KeyboardEvent>) =>
  ({
    type: "keydown",
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

describe("terminalKeyOverride", () => {
  it("sends DEL for plain Backspace before xterm can mis-map it", () => {
    expect(terminalKeyOverride(ev({ key: "Backspace" }), true, false)).toEqual({
      type: "send",
      data: "\x7f",
    });
  });

  it("recognizes WebView Backspace variants", () => {
    expect(terminalKeyOverride(ev({ code: "Backspace" }), true, false)).toEqual({
      type: "send",
      data: "\x7f",
    });
    expect(
      terminalKeyOverride(ev({ keyCode: 8 } as Partial<KeyboardEvent>), true, false),
    ).toEqual({ type: "send", data: "\x7f" });
  });

  it("prefixes Alt+Backspace with ESC", () => {
    expect(
      terminalKeyOverride(ev({ key: "Backspace", altKey: true }), false, false),
    ).toEqual({ type: "send", data: "\x1b\x7f" });
  });

  it("copies the selection on the platform modifier", () => {
    expect(terminalKeyOverride(ev({ key: "c", metaKey: true }), true, true)).toEqual({
      type: "copy",
    });
  });

  it("does not override paste (xterm pastes natively, avoiding double-paste)", () => {
    expect(terminalKeyOverride(ev({ key: "v", metaKey: true }), true, false)).toBeNull();
    expect(terminalKeyOverride(ev({ key: "v", ctrlKey: true }), false, false)).toBeNull();
  });
});
