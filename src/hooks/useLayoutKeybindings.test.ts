import { describe, expect, it } from "vitest";
import { matchLayoutCommand } from "./useLayoutKeybindings";

// In jsdom navigator.platform is not "Mac", so isMac() === false and the
// primary modifier under test is Ctrl. That matches Windows/Linux behavior.
const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("matchLayoutCommand", () => {
  it("returns null without the primary modifier", () => {
    expect(matchLayoutCommand(ev({ key: "b" }))).toBeNull();
  });

  it("maps Ctrl+B to toggleSidebar", () => {
    expect(matchLayoutCommand(ev({ key: "b", ctrlKey: true }))).toBe(
      "toggleSidebar",
    );
  });

  it("maps Ctrl+J to toggleBottomPanel", () => {
    expect(matchLayoutCommand(ev({ key: "j", ctrlKey: true }))).toBe(
      "toggleBottomPanel",
    );
  });

  it("maps Ctrl+` to toggleTerminal", () => {
    expect(
      matchLayoutCommand(ev({ code: "Backquote", key: "`", ctrlKey: true })),
    ).toBe("toggleTerminal");
  });

  it("maps Ctrl+Shift+` to newTerminal", () => {
    expect(
      matchLayoutCommand(
        ev({ code: "Backquote", key: "~", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("newTerminal");
  });

  it("maps Ctrl+Shift+V to togglePreview", () => {
    expect(
      matchLayoutCommand(ev({ key: "V", ctrlKey: true, shiftKey: true })),
    ).toBe("togglePreview");
  });

  it("ignores combos that include Alt", () => {
    expect(
      matchLayoutCommand(ev({ key: "b", ctrlKey: true, altKey: true })),
    ).toBeNull();
  });

  it("ignores unrelated keys", () => {
    expect(matchLayoutCommand(ev({ key: "k", ctrlKey: true }))).toBeNull();
  });
});
