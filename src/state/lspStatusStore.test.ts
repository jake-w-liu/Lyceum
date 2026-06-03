import { beforeEach, describe, expect, it } from "vitest";
import { initialLspStatusData, useLspStatusStore } from "./lspStatusStore";

const get = () => useLspStatusStore.getState();

beforeEach(() => useLspStatusStore.setState(initialLspStatusData, false));

describe("lspStatusStore", () => {
  it("tracks status per language", () => {
    get().setStatus("julia", "starting");
    expect(get().byLanguage.julia).toBe("starting");
    get().setStatus("julia", "ready");
    expect(get().byLanguage.julia).toBe("ready");
    get().setStatus("python", "error");
    expect(get().byLanguage).toEqual({ julia: "ready", python: "error" });
  });
});
