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
