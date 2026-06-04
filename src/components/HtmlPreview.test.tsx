import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { buildHtmlPreviewDocument, HtmlPreview } from "./HtmlPreview";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

describe("HtmlPreview", () => {
  beforeEach(() => {
    useEditorStore.setState(initialEditorData, false);
    useWorkspaceStore.setState(initialWorkspaceData, false);
  });

  it("renders open HTML content in an isolated script sandbox", () => {
    const content =
      "<!doctype html><html><body><h1>Hello</h1><script>window.evil = true</script></body></html>";
    useWorkspaceStore.getState().openWorkspace("/w");
    useEditorStore.getState().openDoc({
      path: "/w/index.html",
      content,
      language: "html",
    });

    render(<HtmlPreview path="/w/index.html" />);

    const frame = screen.getByTitle("index.html preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("<base href=\"file:///w/\">");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hello</h1>");
  });

  it("renders a placeholder when the doc is not open", () => {
    render(<HtmlPreview path="/w/missing.html" />);

    expect(screen.getByText("Open the HTML file to preview it.")).toBeInTheDocument();
  });

  it("rewrites root-relative asset URLs against the workspace root", () => {
    const doc = buildHtmlPreviewDocument(
      '<link href="/style.css"><script src="/src/main.js"></script>',
      "/workspace/pages/index.html",
      "/workspace",
    );

    expect(doc).toContain('href="file:///workspace/style.css"');
    expect(doc).toContain('src="file:///workspace/src/main.js"');
    expect(doc).toContain('<base href="file:///workspace/pages/">');
  });
});
