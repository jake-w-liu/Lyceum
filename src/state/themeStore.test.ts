// Tests for theme state, cycling, and Monaco/DOM mapping.
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThemeAttribute,
  initialThemeData,
  monacoThemeFor,
  useThemeStore,
} from "./themeStore";

beforeEach(() => {
  useThemeStore.setState(initialThemeData, false);
});

describe("themeStore", () => {
  it("setTheme changes theme", () => {
    useThemeStore.getState().setTheme("light");
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("cycleTheme goes dark->light->hc->dark", () => {
    expect(useThemeStore.getState().theme).toBe("dark");
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("light");
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("hc");
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("monacoThemeFor maps all three correctly", () => {
    expect(monacoThemeFor("dark")).toBe("vs-dark");
    expect(monacoThemeFor("light")).toBe("vs");
    expect(monacoThemeFor("hc")).toBe("hc-black");
  });

  it("applyThemeAttribute sets the data-theme attribute", () => {
    applyThemeAttribute("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
