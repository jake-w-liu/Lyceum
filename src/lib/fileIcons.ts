// Maps a file name to an Icon glyph for the Explorer tree. Extension-based and
// presentational only — unknown types fall back to the generic "file" glyph.

import {
  extensionForPath,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
} from "./fileTypes";
import type { IconName } from "../components/Icon";

// Source/code-ish extensions that get the code-file glyph.
const CODE_EXTENSIONS = new Set([
  "jl", "py", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "go", "c", "h", "cpp", "hpp", "cc", "java", "rb",
  "sh", "bash", "zsh", "lua", "r", "tex", "bib",
  "json", "jsonc", "toml", "yaml", "yml", "css", "scss", "html", "htm", "xml",
]);

/** The Icon name to show for a file (not a directory) in the tree. */
export function fileIconFor(name: string): IconName {
  if (isImagePath(name)) return "image";
  if (isPdfPath(name)) return "pdf";
  if (isMarkdownPath(name)) return "markdown";
  if (CODE_EXTENSIONS.has(extensionForPath(name))) return "file-code";
  return "file";
}
