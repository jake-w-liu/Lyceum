import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({ readFile: vi.fn(async () => "file contents") }));
import { readFile } from "../lib/ipc";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";
import { useOpenFileBridge } from "./useOpenFileBridge";

function Harness() {
  useOpenFileBridge();
  return null;
}

beforeEach(() => {
  useWorkspaceStore.setState(initialWorkspaceData, false);
  useEditorStore.setState(initialEditorData, false);
  usePreviewStore.setState(initialPreviewData, false);
  useLayoutStore.setState(initialLayoutData, false);
  vi.mocked(readFile).mockClear();
});

describe("useOpenFileBridge", () => {
  it("opens the pending file in the editor and clears the intent", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/main.py");
    });

    await waitFor(() => {
      expect(useEditorStore.getState().docs).toHaveLength(1);
    });

    const doc = useEditorStore.getState().docs[0];
    expect(doc.path).toBe("/w/main.py");
    expect(doc.content).toBe("file contents");
    expect(doc.language).toBe("python");
    expect(readFile).toHaveBeenCalledWith("/w/main.py");
    expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
  });

  it("opens PDFs as viewer tabs without reading as text", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/paper.pdf");
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
    });

    expect(useEditorStore.getState().docs).toMatchObject([
      { path: "/w/paper.pdf", language: "pdf", kind: "pdf" },
    ]);
    expect(useEditorStore.getState().activePath).toBe("/w/paper.pdf");
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("records a pending reveal when the request carries a position", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/main.py", {
        line: 14,
        column: 5,
      });
    });

    await waitFor(() => {
      expect(useEditorStore.getState().docs).toHaveLength(1);
    });

    expect(useEditorStore.getState().pendingReveal).toEqual({
      path: "/w/main.py",
      line: 14,
      column: 5,
    });
    expect(useWorkspaceStore.getState().pendingOpenPosition).toBeNull();
  });

  it("re-triggers for the same path when only the position changes", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/main.py", { line: 1 });
    });
    await waitFor(() =>
      expect(useEditorStore.getState().pendingReveal?.line).toBe(1),
    );

    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/main.py", { line: 9 });
    });
    await waitFor(() =>
      expect(useEditorStore.getState().pendingReveal?.line).toBe(9),
    );
    expect(useEditorStore.getState().docs).toHaveLength(1);
  });

  it("still opens a read that was superseded mid-flight, without stealing focus", async () => {
    let resolveFirst!: (content: string) => void;
    vi.mocked(readFile)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => "second contents");

    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/first.py");
    });
    // A newer request lands while the first read is still in flight.
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/second.py");
    });
    await waitFor(() =>
      expect(
        useEditorStore.getState().docs.some((d) => d.path === "/w/second.py"),
      ).toBe(true),
    );

    // The first read resolves late: it must still open (no silent drop) but
    // must NOT steal the active tab from the newer request.
    act(() => resolveFirst("first contents"));
    await waitFor(() =>
      expect(
        useEditorStore.getState().docs.some((d) => d.path === "/w/first.py"),
      ).toBe(true),
    );

    expect(useEditorStore.getState().activePath).toBe("/w/second.py");
    expect(
      useEditorStore.getState().docs.find((d) => d.path === "/w/first.py")
        ?.content,
    ).toBe("first contents");
    expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
  });

  it("opens images as viewer tabs without reading as text", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/Figure.SVG");
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
    });

    expect(useEditorStore.getState().docs).toMatchObject([
      { path: "/w/Figure.SVG", language: "image", kind: "image" },
    ]);
    expect(useEditorStore.getState().activePath).toBe("/w/Figure.SVG");
    expect(usePreviewStore.getState().imagePath).toBeNull();
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });
});
