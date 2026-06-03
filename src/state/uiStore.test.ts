// Tests for the transient UI surface store (open/close/toggle modal).

import { beforeEach, describe, expect, it } from "vitest";
import { initialUiData, useUiStore } from "./uiStore";

const reset = () => useUiStore.setState(initialUiData, false);
const get = () => useUiStore.getState();

describe("uiStore", () => {
  beforeEach(reset);

  it("starts with no active modal", () => {
    expect(get().activeModal).toBe(null);
  });

  it("opens and closes a modal", () => {
    get().openModal("palette");
    expect(get().activeModal).toBe("palette");
    get().closeModal();
    expect(get().activeModal).toBe(null);
  });

  it("toggle opens then closes the same kind", () => {
    get().toggleModal("palette");
    expect(get().activeModal).toBe("palette");
    get().toggleModal("palette");
    expect(get().activeModal).toBe(null);
  });

  it("toggle to a different kind switches", () => {
    get().toggleModal("palette");
    expect(get().activeModal).toBe("palette");
    get().toggleModal("quickOpen");
    expect(get().activeModal).toBe("quickOpen");
  });
});
