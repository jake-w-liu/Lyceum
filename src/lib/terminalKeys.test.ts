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
  it("sends Ctrl-H for plain Backspace before xterm can mis-map it", () => {
    expect(terminalKeyOverride(ev({ key: "Backspace" }), true, false)).toEqual({
      type: "send",
      data: "\b",
    });
  });

  it("recognizes WebView Backspace variants", () => {
    expect(terminalKeyOverride(ev({ code: "Backspace" }), true, false)).toEqual({
      type: "send",
      data: "\b",
    });
    expect(
      terminalKeyOverride(ev({ keyCode: 8 } as Partial<KeyboardEvent>), true, false),
    ).toEqual({ type: "send", data: "\b" });
  });

  it("prefixes Alt+Backspace with ESC", () => {
    expect(
      terminalKeyOverride(ev({ key: "Backspace", altKey: true }), false, false),
    ).toEqual({ type: "send", data: "\x1b\b" });
  });

  it("keeps copy/paste on the platform modifier", () => {
    expect(terminalKeyOverride(ev({ key: "c", metaKey: true }), true, true)).toEqual({
      type: "copy",
    });
    expect(terminalKeyOverride(ev({ key: "v", ctrlKey: true }), false, false)).toEqual({
      type: "paste",
    });
  });
});
