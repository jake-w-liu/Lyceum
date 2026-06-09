import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ writeFile: vi.fn(async () => {}) }));
import { writeFile } from "../lib/ipc";
import {
  getActiveDoc,
  initialEditorData,
  isDirty,
  useEditorStore,
} from "../state/editorStore";
import {
  closeActiveTab,
  focusAdjacentTab,
  saveActiveDoc,
  saveAllDocs,
} from "./useEditorKeybindings";

const get = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
  vi.mocked(writeFile).mockClear();
});

describe("saveActiveDoc", () => {
  it("writes the active doc and clears its dirty state", async () => {
    get().openDoc({ path: "/w/a.ts", content: "x", language: "typescript" });
    get().updateContent("/w/a.ts", "changed");
    expect(isDirty(getActiveDoc(get())!)).toBe(true);

    await saveActiveDoc();

    expect(writeFile).toHaveBeenCalledWith("/w/a.ts", "changed");
    expect(isDirty(getActiveDoc(get())!)).toBe(false);
  });

  it("is a no-op when nothing is open", async () => {
    await saveActiveDoc();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not save viewer tabs", async () => {
    get().openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });

    await saveActiveDoc();

    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("saveAllDocs", () => {
  it("writes every dirty text doc and clears their dirty state", async () => {
    get().openDoc({ path: "/w/a.ts", content: "a", language: "typescript" });
    get().openDoc({ path: "/w/b.ts", content: "b", language: "typescript" });
    get().openDoc({ path: "/w/clean.ts", content: "c", language: "typescript" });
    get().updateContent("/w/a.ts", "a!");
    get().updateContent("/w/b.ts", "b!");

    await saveAllDocs();

    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledWith("/w/a.ts", "a!");
    expect(writeFile).toHaveBeenCalledWith("/w/b.ts", "b!");
    expect(get().docs.filter((d) => isDirty(d))).toHaveLength(0);
  });

  it("is a no-op when no docs are dirty", async () => {
    get().openDoc({ path: "/w/a.ts", content: "a", language: "typescript" });
    await saveAllDocs();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("ignores viewer (pdf/image) tabs", async () => {
    get().openDoc({ path: "/w/p.pdf", content: "", language: "pdf", kind: "pdf" });
    await saveAllDocs();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("focusAdjacentTab", () => {
  it("cycles forward and backward with wraparound", () => {
    get().openDoc({ path: "/a", content: "", language: "plaintext" });
    get().openDoc({ path: "/b", content: "", language: "plaintext" });
    get().setActive("/a");

    focusAdjacentTab(1);
    expect(get().activePath).toBe("/b");
    focusAdjacentTab(1);
    expect(get().activePath).toBe("/a"); // wraps
    focusAdjacentTab(-1);
    expect(get().activePath).toBe("/b"); // wraps back
  });
});

describe("closeActiveTab", () => {
  it("closes the active tab", () => {
    get().openDoc({ path: "/a", content: "", language: "plaintext" });
    closeActiveTab();
    expect(get().docs).toHaveLength(0);
  });
});
