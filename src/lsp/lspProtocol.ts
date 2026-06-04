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
      ? [{ uri: pathToUri(rootPath), name: rootPath.split("/").pop() ?? rootPath }]
      : null,
  };
}
