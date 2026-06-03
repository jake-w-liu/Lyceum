import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownView } from "./MarkdownView";
import { initialEditorData, useEditorStore } from "../state/editorStore";

describe("MarkdownView", () => {
  beforeEach(() => {
    useEditorStore.setState(initialEditorData, false);
  });

  it("renders the document content as HTML", () => {
    useEditorStore.getState().openDoc({
      path: "/w/a.md",
      content: "# Title\n\nhello",
      language: "markdown",
    });
    const { container } = render(<MarkdownView path="/w/a.md" />);

    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.textContent).toContain("hello");
  });

  it("renders a placeholder when the doc is not open", () => {
    const { container } = render(<MarkdownView path="/w/missing.md" />);

    expect(container.textContent).toContain(
      "Open the Markdown file to preview it.",
    );
  });
});
