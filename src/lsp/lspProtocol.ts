// Pure LSP protocol helpers (M9): URI<->path conversion and initialize params.
// Kept separate from the (Tauri-bound) client so they can be unit-tested.

export function pathToUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}

export function uriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    // Malformed percent-encoding from a server URI: fall back to the raw form
    // rather than throwing out of the diagnostics dispatch.
    return withoutScheme;
  }
}

/** Last path segment, for the workspace-folder display label. Handles both `/`
 *  and `\` separators, trailing separators, and a Windows `\\?\` extended-length
 *  prefix — canonical Windows roots are backslash-delimited, so a plain
 *  `split("/")` would return the whole path as the name. */
export function leafName(rootPath: string): string {
  const normalized = rootPath.replace(/^\\\\\?\\/, "");
  const segments = normalized.split(/[/\\]+/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? rootPath;
}

export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  capabilities: Record<string, unknown>;
  workspaceFolders: { uri: string; name: string }[] | null;
}

export function buildInitializeParams(rootPath: string | null): InitializeParams {
  return {
    processId: null,
    rootUri: rootPath ? pathToUri(rootPath) : null,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        hover: {},
        completion: {},
        definition: {},
        references: {},
        publishDiagnostics: {},
        documentSymbol: {},
        rename: {},
        formatting: {},
      },
    },
    workspaceFolders: rootPath
      ? [{ uri: pathToUri(rootPath), name: leafName(rootPath) }]
      : null,
  };
}
