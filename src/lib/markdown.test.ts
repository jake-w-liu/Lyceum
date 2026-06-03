import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const html = renderMarkdown("# Hi");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hi");
  });

  it("renders bold text", () => {
    expect(renderMarkdown("**b**")).toContain("<strong>");
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
