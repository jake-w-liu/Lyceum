import { beforeEach, describe, expect, it } from "vitest";
import {
  initialKeymapData,
  parseUserKeybindings,
  useKeymapStore,
} from "./keymapStore";
import { DEFAULT_KEYMAP } from "../keybindings/keybindingRegistry";

beforeEach(() => useKeymapStore.setState(initialKeymapData, false));

describe("parseUserKeybindings", () => {
  it("reads the versioned-object form", () => {
    const parsed = parseUserKeybindings({
      version: 1,
      keybindings: [{ key: "mod+r", command: "editor.run" }],
    });
    expect(parsed).toEqual([{ key: "mod+r", command: "editor.run" }]);
  });
  it("reads a bare array and drops invalid entries", () => {
    const parsed = parseUserKeybindings([
      { key: "mod+k", command: "x" },
      { key: 5 },
      "nope",
      { command: "no-key" },
    ]);
    expect(parsed).toEqual([{ key: "mod+k", command: "x" }]);
  });
  it("returns [] for garbage", () => {
    expect(parseUserKeybindings(null)).toEqual([]);
    expect(parseUserKeybindings(42)).toEqual([]);
  });
  it("drops a binding whose `when` is not a string", () => {
    // A non-string `when` would otherwise reach evaluateWhen and throw
    // `.trim is not a function` out of the global keydown handler.
    const parsed = parseUserKeybindings([
      { key: "ctrl+k", command: "foo", when: 5 },
      { key: "ctrl+j", command: "bar", when: "editorFocus" },
      { key: "ctrl+l", command: "baz" },
    ]);
    expect(parsed).toEqual([
      { key: "ctrl+j", command: "bar", when: "editorFocus" },
      { key: "ctrl+l", command: "baz" },
    ]);
  });
});

describe("keymapStore", () => {
  it("appends user overrides after the defaults", () => {
    const user = [{ key: "mod+r", command: "editor.run" }];
    useKeymapStore.getState().setUserKeybindings(user);
    const keymap = useKeymapStore.getState().keymap;
    expect(keymap.length).toBe(DEFAULT_KEYMAP.length + 1);
    expect(keymap[keymap.length - 1]).toEqual(user[0]);
    useKeymapStore.getState().resetKeymap();
    expect(useKeymapStore.getState().keymap).toBe(DEFAULT_KEYMAP);
  });
});
