import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const html = renderMarkdown("# Hi");
    expect(html).toContain("<h1");
    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('data-source-index="2"');
    expect(html).toContain("Hi");
  });

  it("renders bold text", () => {
    const html = renderMarkdown("**b**");
    expect(html).toContain("<strong>");
    expect(html).toContain('data-source-index="2"');
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
