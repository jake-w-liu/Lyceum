import MarkdownIt from "markdown-it";

// html:false escapes raw HTML for safety
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function renderMarkdown(text: string): string {
  return md.render(text);
}
