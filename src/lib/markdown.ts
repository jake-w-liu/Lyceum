import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

// html:false escapes raw HTML for safety
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

interface SourceMappedToken extends Token {
  meta: Token["meta"] & { sourceIndex?: number };
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function lineOffset(offsets: number[], line: number, fallback: number): number {
  return offsets[line] ?? fallback;
}

function setSourceIndex(token: Token, index: number): void {
  (token as SourceMappedToken).meta = {
    ...(token.meta ?? {}),
    sourceIndex: index,
  };
}

function sourceIndexOf(token: Token): number | null {
  const value = (token as SourceMappedToken).meta?.sourceIndex;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function annotateInlineToken(
  token: Token,
  source: string,
  offsets: number[],
): void {
  if (!token.map || !token.children) return;

  const sourceStart = lineOffset(offsets, token.map[0], 0);
  const sourceEnd = lineOffset(offsets, token.map[1], source.length);
  const segment = source.slice(sourceStart, sourceEnd);
  const inlineStart = segment.indexOf(token.content);
  let cursor = inlineStart >= 0 ? inlineStart : 0;

  for (const child of token.children) {
    if (child.type !== "text" && child.type !== "code_inline") continue;
    if (child.content.length === 0) continue;

    const found = segment.indexOf(child.content, cursor);
    if (found === -1) continue;
    setSourceIndex(child, sourceStart + found);
    cursor = found + child.content.length;
  }
}

function annotateBlockToken(token: Token): void {
  if (!token.map) return;
  if (token.nesting !== 1 && token.type !== "fence" && token.type !== "code_block") {
    return;
  }
  token.attrSet("data-source-line", String(token.map[0] + 1));
  token.attrSet("data-source-end-line", String(token.map[1]));
}

function annotateTokens(tokens: Token[], source: string): void {
  const offsets = lineOffsets(source);
  for (const token of tokens) {
    annotateBlockToken(token);
    if (token.type === "inline") annotateInlineToken(token, source, offsets);
  }
}

md.renderer.rules.text = (tokens, idx) => {
  const token = tokens[idx];
  const escaped = md.utils.escapeHtml(token.content);
  const sourceIndex = sourceIndexOf(token);
  if (sourceIndex === null) return escaped;
  return `<span data-source-index="${sourceIndex}">${escaped}</span>`;
};

md.renderer.rules.code_inline = (tokens, idx) => {
  const token = tokens[idx];
  const sourceIndex = sourceIndexOf(token);
  const sourceAttr =
    sourceIndex === null ? "" : ` data-source-index="${sourceIndex}"`;
  return `<code${sourceAttr}>${md.utils.escapeHtml(token.content)}</code>`;
};

export function renderMarkdown(text: string): string {
  const env: Record<string, unknown> = {};
  const tokens = md.parse(text, env);
  annotateTokens(tokens, text);
  return md.renderer.render(tokens, md.options, env);
}
