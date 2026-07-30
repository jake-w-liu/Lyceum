import { describe, expect, it } from "vitest";
import {
  suppressesNativeTextInsertion,
  terminalKeyOverride,
} from "./terminalKeys";

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

  it("owns paste on the platform modifier so native clipboard input is reliable", () => {
    expect(terminalKeyOverride(ev({ key: "v", metaKey: true }), true, false)).toEqual({
      type: "paste",
    });
    expect(terminalKeyOverride(ev({ key: "v", ctrlKey: true }), false, false)).toEqual({
      type: "paste",
    });
  });

  it("does not treat Ctrl+V as paste on macOS", () => {
    expect(terminalKeyOverride(ev({ key: "v", ctrlKey: true }), true, false)).toBeNull();
  });

  it("ignores non-keydown events so keypress/keyup never re-send a key", () => {
    expect(
      terminalKeyOverride(ev({ type: "keypress", key: "Backspace" }), true, false),
    ).toBeNull();
    expect(
      terminalKeyOverride(ev({ type: "keyup", key: "c", metaKey: true }), true, true),
    ).toBeNull();
  });
});

describe("suppressesNativeTextInsertion", () => {
  it("suppresses the default insertion on keypress", () => {
    // Shift+letter is the one printable path xterm leaves uncancelled, so its
    // characters would otherwise pile up in xterm's hidden textarea and can be
    // re-sent by the IME composition helper.
    expect(suppressesNativeTextInsertion(ev({ type: "keypress", key: "A" }))).toBe(
      true,
    );
  });

  it("leaves keydown and keyup alone", () => {
    // keydown must keep its default so app-level chords and xterm's own
    // cancelling logic behave exactly as before.
    expect(suppressesNativeTextInsertion(ev({ type: "keydown", key: "A" }))).toBe(
      false,
    );
    expect(suppressesNativeTextInsertion(ev({ type: "keyup", key: "A" }))).toBe(
      false,
    );
  });
});
