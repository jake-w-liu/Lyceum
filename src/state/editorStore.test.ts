// Unit tests for the editor store: open/close/activate tabs, dirty tracking,
// and the pure getActiveDoc/isDirty helpers.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getActiveDoc,
  initialEditorData,
  isDirty,
  useEditorStore,
} from "./editorStore";

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
});

describe("editorStore", () => {
  it("openDoc adds a doc and makes it active with a basename", () => {
    useEditorStore.getState().openDoc({
      path: "/proj/src/main.ts",
      content: "hello",
      language: "typescript",
    });

    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(1);
    expect(state.activePath).toBe("/proj/src/main.ts");
    expect(state.docs[0].name).toBe("main.ts");
    expect(state.docs[0].savedContent).toBe("hello");
    expect(state.docs[0].kind).toBe("text");
    expect(state.docs[0].reloadVersion).toBe(0);
  });

  it("openDoc with an existing path does not duplicate, just activates", () => {
    const { openDoc } = useEditorStore.getState();
    openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    openDoc({ path: "/b.ts", content: "b", language: "typescript" });
    expect(useEditorStore.getState().activePath).toBe("/b.ts");

    openDoc({ path: "/a.ts", content: "IGNORED", language: "typescript" });
    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(2);
    expect(state.activePath).toBe("/a.ts");
    expect(state.docs[0].content).toBe("a");
  });

  it("updateContent makes the doc dirty and markSaved clears it", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });

    store.updateContent("/a.ts", "a changed");
    let doc = useEditorStore.getState().docs[0];
    expect(doc.content).toBe("a changed");
    expect(isDirty(doc)).toBe(true);

    store.markSaved("/a.ts");
    doc = useEditorStore.getState().docs[0];
    expect(doc.savedContent).toBe("a changed");
    expect(isDirty(doc)).toBe(false);
  });

  it("markSaved(path, written) keeps the doc dirty if the buffer diverged during the save", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "A", language: "typescript" });

    // Simulate: a save wrote snapshot "A", then the user typed "AB" before the
    // async write resolved. markSaved must record what was WRITTEN ("A"), so the
    // newer edit stays dirty and is not silently treated as saved.
    store.updateContent("/a.ts", "AB");
    store.markSaved("/a.ts", "A");

    const doc = useEditorStore.getState().docs[0];
    expect(doc.savedContent).toBe("A");
    expect(doc.content).toBe("AB");
    expect(isDirty(doc)).toBe(true);
  });

  it("replaceCleanContentFromDisk updates clean text docs and bumps reloadVersion", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/w/notes.txt", content: "old", language: "plaintext" });

    store.replaceCleanContentFromDisk("/w/notes.txt", "# new");

    const doc = useEditorStore.getState().docs[0];
    expect(doc.content).toBe("# new");
    expect(doc.savedContent).toBe("# new");
    expect(doc.language).toBe("plaintext");
    expect(doc.reloadVersion).toBe(1);
    expect(isDirty(doc)).toBe(false);
  });

  it("replaceCleanContentFromDisk does not overwrite dirty text docs", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/w/a.ts", content: "local", language: "typescript" });
    store.updateContent("/w/a.ts", "unsaved");

    store.replaceCleanContentFromDisk("/w/a.ts", "external");

    const doc = useEditorStore.getState().docs[0];
    expect(doc.content).toBe("unsaved");
    expect(doc.savedContent).toBe("local");
    expect(doc.reloadVersion).toBe(0);
    expect(isDirty(doc)).toBe(true);
  });

  it("opens viewer tabs without dirty tracking or text mutation", () => {
    const store = useEditorStore.getState();
    store.openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });

    store.updateContent("/w/paper.pdf", "accidental text");
    let doc = useEditorStore.getState().docs[0];
    expect(doc.kind).toBe("pdf");
    expect(doc.content).toBe("");
    expect(isDirty(doc)).toBe(false);

    store.markSaved("/w/paper.pdf");
    doc = useEditorStore.getState().docs[0];
    expect(doc.savedContent).toBe("");
    expect(isDirty(doc)).toBe(false);

    store.bumpReloadVersion("/w/paper.pdf");
    doc = useEditorStore.getState().docs[0];
    expect(doc.reloadVersion).toBe(1);
  });

  it("closeDoc reassigns, nulls, or keeps activePath appropriately", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    store.openDoc({ path: "/b.ts", content: "b", language: "typescript" });
    store.openDoc({ path: "/c.ts", content: "c", language: "typescript" });

    // Active is /c.ts (last opened). Closing it falls back to the previous doc.
    store.closeDoc("/c.ts");
    expect(useEditorStore.getState().activePath).toBe("/b.ts");

    // Closing a non-active doc keeps the active one.
    store.closeDoc("/a.ts");
    expect(useEditorStore.getState().activePath).toBe("/b.ts");
    expect(useEditorStore.getState().docs).toHaveLength(1);

    // Closing the last doc sets activePath to null.
    store.closeDoc("/b.ts");
    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(0);
    expect(state.activePath).toBeNull();
  });

  it("getActiveDoc returns the active doc or null", () => {
    expect(getActiveDoc(useEditorStore.getState())).toBeNull();

    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    store.openDoc({ path: "/b.ts", content: "b", language: "typescript" });

    const active = getActiveDoc(useEditorStore.getState());
    expect(active?.path).toBe("/b.ts");

    useEditorStore.setState({ activePath: null });
    expect(getActiveDoc(useEditorStore.getState())).toBeNull();
  });

  it("moveDocPaths rewrites moved files and descendants while preserving content", () => {
    const store = useEditorStore.getState();
    store.openDoc({
      path: "/w/src/main.ts",
      content: "main",
      language: "typescript",
    });
    store.openDoc({
      path: "/w/README.md",
      content: "readme",
      language: "markdown",
    });

    store.moveDocPaths([
      { from: "/w/src", to: "/w/archive/src" },
      { from: "/w/README.md", to: "/w/docs/README.md" },
    ]);

    const state = useEditorStore.getState();
    expect(state.docs.map((doc) => doc.path)).toEqual([
      "/w/archive/src/main.ts",
      "/w/docs/README.md",
    ]);
    expect(state.docs.map((doc) => doc.name)).toEqual(["main.ts", "README.md"]);
    expect(state.docs[0].content).toBe("main");
    expect(state.activePath).toBe("/w/docs/README.md");
  });

  it("moveDocPaths recomputes text language when the extension changes", () => {
    const store = useEditorStore.getState();
    store.openDoc({
      path: "/w/notes.txt",
      content: "# Notes",
      language: "plaintext",
    });

    store.moveDocPaths([{ from: "/w/notes.txt", to: "/w/notes.md" }]);

    const doc = useEditorStore.getState().docs[0];
    expect(doc.path).toBe("/w/notes.md");
    expect(doc.language).toBe("markdown");
    expect(doc.content).toBe("# Notes");
  });
});
