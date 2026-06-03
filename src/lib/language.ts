// Map a file path to a Monaco language id based on its extension. The lookup is
// case-insensitive and operates on the extension after the last "." in the
// final path segment; paths without an extension fall back to "plaintext".

import { baseName } from "../state/workspaceStore";

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jl: "julia",
  py: "python",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  html: "html",
  htm: "html",
  css: "css",
  toml: "toml",
  tex: "latex",
  latex: "latex",
  sty: "latex",
  cls: "latex",
};

/** Monaco language id for a file path (defaults to "plaintext"). */
export function languageForPath(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return "plaintext";
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? "plaintext";
}
