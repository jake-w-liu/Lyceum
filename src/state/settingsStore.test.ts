// Tests for settings defaults, validation/clamping, and store actions.
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  initialSettingsData,
  mergeSettings,
  useSettingsStore,
} from "./settingsStore";

beforeEach(() => {
  useSettingsStore.setState(initialSettingsData, false);
});

describe("mergeSettings", () => {
  it("returns defaults for an empty object", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps numbers, ignores invalid enums and unknown keys", () => {
    const result = mergeSettings({
      fontSize: 100,
      tabSize: 0,
      lineHeight: 20,
      theme: "bogus",
      junk: 1,
    });
    expect(result.fontSize).toBe(40);
    expect(result.tabSize).toBe(1);
    expect(result.lineHeight).toBe(20);
    expect(result.theme).toBe("dark");
    expect("junk" in result).toBe(false);
  });

  it("rounds and clamps zoomLevel to its bounds", () => {
    expect(mergeSettings({ zoomLevel: 99 }).zoomLevel).toBe(10);
    expect(mergeSettings({ zoomLevel: -99 }).zoomLevel).toBe(-5);
    expect(mergeSettings({ zoomLevel: 2.7 }).zoomLevel).toBe(3);
  });

  it("normalizes line-height multipliers to Monaco pixel values", () => {
    expect(mergeSettings({ fontSize: 16, lineHeight: 1.5 }).lineHeight).toBe(24);
    expect(mergeSettings({ lineHeight: -1 }).lineHeight).toBe(0);
  });

  it("overrides only the provided valid keys", () => {
    const result = mergeSettings({ theme: "light", minimap: false });
    expect(result.theme).toBe("light");
    expect(result.minimap).toBe(false);
    expect(result).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
      minimap: false,
    });
  });

  it("returns defaults for null", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settingsStore", () => {
  it("setSetting updates a single key", () => {
    useSettingsStore.getState().setSetting("fontSize", 16);
    expect(useSettingsStore.getState().settings.fontSize).toBe(16);
  });

  it("replaceAll replaces the whole settings object", () => {
    const next = { ...DEFAULT_SETTINGS, theme: "hc" as const, tabSize: 4 };
    useSettingsStore.getState().replaceAll(next);
    expect(useSettingsStore.getState().settings).toEqual(next);
  });
});
