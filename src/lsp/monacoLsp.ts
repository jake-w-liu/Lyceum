// Wire LSP features into Monaco (M9): server-pushed diagnostics become markers,
// and hover / definition / references / completion providers proxy to the active
// language server via the JSON-RPC client. Registered once. Tauri/Monaco-bound
// (smoke-tested); the protocol/RPC layers underneath are unit-tested.

import type * as Monaco from "monaco-editor";
import { getSession, setDiagnosticsSink } from "./lspClient";
import { LSP_SERVERS } from "./servers";
import { uriToPath } from "./lspProtocol";

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspHover {
  contents: unknown;
}
interface LspCompletionItem {
  label: string;
  detail?: string;
  insertText?: string;
  kind?: number;
}
interface LspTextEdit {
  range: LspRange;
  newText: string;
}
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
}
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
}

let attached = false;

export function attachMonacoLsp(monaco: typeof Monaco): void {
  if (attached) return;
  attached = true;

  setDiagnosticsSink((uri, diagnostics) => {
    const target = uriToPath(uri);
    const model = monaco.editor
      .getModels()
      .find((m) => uriToPath(m.uri.toString()) === target);
    if (!model) return;
    const markers = (diagnostics as LspDiagnostic[]).map((d) => ({
      severity: severityToMonaco(monaco, d.severity),
      message: d.message,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    }));
    monaco.editor.setModelMarkers(model, "lsp", markers);
  });

  for (const config of LSP_SERVERS) {
    const lang = config.languageId;

    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const rpc = rpcWithCap(lang, "hoverProvider");
        if (!rpc) return null;
        try {
          const res = await rpc.request<LspHover | null>("textDocument/hover", {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          });
          const value = res ? hoverToMarkdown(res.contents) : "";
          return value ? { contents: [{ value }] } : null;
        } catch {
          return null;
        }
      },
    });

    monaco.languages.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        const rpc = rpcWithCap(lang, "definitionProvider");
        if (!rpc) return null;
        try {
          const res = await rpc.request<LspLocation | LspLocation[] | null>(
            "textDocument/definition",
            {
              textDocument: { uri: model.uri.toString() },
              position: toLspPosition(position),
            },
          );
          return toMonacoLocations(monaco, res);
        } catch {
          return null;
        }
      },
    });

    monaco.languages.registerReferenceProvider(lang, {
      async provideReferences(model, position, context) {
        const rpc = rpcWithCap(lang, "referencesProvider");
        if (!rpc) return null;
        try {
          const res = await rpc.request<LspLocation[] | null>(
            "textDocument/references",
            {
              textDocument: { uri: model.uri.toString() },
              position: toLspPosition(position),
              context: { includeDeclaration: context.includeDeclaration },
            },
          );
          return toMonacoLocations(monaco, res ?? []) ?? [];
        } catch {
          return [];
        }
      },
    });

    monaco.languages.registerCompletionItemProvider(lang, {
      async provideCompletionItems(model, position) {
        const rpc = rpcWithCap(lang, "completionProvider");
        if (!rpc) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        try {
          const res = await rpc.request<
            LspCompletionItem[] | { items: LspCompletionItem[] } | null
          >("textDocument/completion", {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          });
          const items = Array.isArray(res) ? res : (res?.items ?? []);
          return {
            suggestions: items.map((item) => ({
              label: item.label,
              detail: item.detail,
              kind: completionKindToMonaco(monaco, item.kind),
              insertText: item.insertText ?? item.label,
              range,
            })),
          };
        } catch {
          return { suggestions: [] };
        }
      },
    });

    monaco.languages.registerDocumentSymbolProvider(lang, {
      async provideDocumentSymbols(model) {
        const rpc = rpcWithCap(lang, "documentSymbolProvider");
        if (!rpc) return [];
        try {
          const res = await rpc.request<
            LspDocumentSymbol[] | LspSymbolInformation[] | null
          >("textDocument/documentSymbol", {
            textDocument: { uri: model.uri.toString() },
          });
          return toMonacoSymbols(res ?? []);
        } catch {
          return [];
        }
      },
    });

    monaco.languages.registerRenameProvider(lang, {
      async provideRenameEdits(model, position, newName) {
        const rpc = rpcWithCap(lang, "renameProvider");
        if (!rpc) return { edits: [] };
        try {
          const res = await rpc.request<LspWorkspaceEdit | null>(
            "textDocument/rename",
            {
              textDocument: { uri: model.uri.toString() },
              position: toLspPosition(position),
              newName,
            },
          );
          return toMonacoWorkspaceEdit(monaco, res);
        } catch {
          return { edits: [] };
        }
      },
    });

    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      async provideDocumentFormattingEdits(model) {
        const rpc = rpcWithCap(lang, "documentFormattingProvider");
        if (!rpc) return [];
        try {
          const res = await rpc.request<LspTextEdit[] | null>(
            "textDocument/formatting",
            {
              textDocument: { uri: model.uri.toString() },
              options: { tabSize: model.getOptions().tabSize, insertSpaces: true },
            },
          );
          return (res ?? []).map((edit) => ({
            range: lspRangeToMonaco(edit.range),
            text: edit.newText,
          }));
        } catch {
          return [];
        }
      },
    });
  }
}

// Return the session's RPC client only if the server advertised `cap` in its
// initialize result (capabilities is empty until the handshake resolves, so
// providers correctly stay inert until then). Avoids issuing requests for
// features the server can't service.
function rpcWithCap(lang: string, cap: string) {
  const session = getSession(lang);
  if (!session || !session.capabilities[cap]) return null;
  return session.rpc;
}

function toLspPosition(position: {
  lineNumber: number;
  column: number;
}): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

// Map an LSP `CompletionItemKind` (1-based, spec-fixed numbering) to the Monaco
// enum (same names, DIFFERENT numeric values), so completions render with the
// right icon (function/class/variable/…) and Monaco's kind-aware sorting works.
// Falls back to Text when the server omits a kind.
function completionKindToMonaco(
  monaco: typeof Monaco,
  kind?: number,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 1:
      return K.Text;
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 4:
      return K.Constructor;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 8:
      return K.Interface;
    case 9:
      return K.Module;
    case 10:
      return K.Property;
    case 11:
      return K.Unit;
    case 12:
      return K.Value;
    case 13:
      return K.Enum;
    case 14:
      return K.Keyword;
    case 15:
      return K.Snippet;
    case 16:
      return K.Color;
    case 17:
      return K.File;
    case 18:
      return K.Reference;
    case 19:
      return K.Folder;
    case 20:
      return K.EnumMember;
    case 21:
      return K.Constant;
    case 22:
      return K.Struct;
    case 23:
      return K.Event;
    case 24:
      return K.Operator;
    case 25:
      return K.TypeParameter;
    default:
      return K.Text;
  }
}

function severityToMonaco(monaco: typeof Monaco, severity?: number): number {
  // LSP: 1 Error, 2 Warning, 3 Information, 4 Hint
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

function hoverToMarkdown(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => hoverToMarkdown(c)).filter(Boolean).join("\n\n");
  }
  if (contents && typeof contents === "object") {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

function toMonacoLocations(
  monaco: typeof Monaco,
  res: LspLocation | LspLocation[] | null,
): Monaco.languages.Location[] | null {
  if (!res) return null;
  const list = Array.isArray(res) ? res : [res];
  return list.map((loc) => ({
    uri: monaco.Uri.parse(loc.uri),
    range: lspRangeToMonaco(loc.range),
  }));
}

function lspRangeToMonaco(range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function toMonacoSymbols(
  res: LspDocumentSymbol[] | LspSymbolInformation[],
): Monaco.languages.DocumentSymbol[] {
  return (res as Array<LspDocumentSymbol | LspSymbolInformation>).map((s) => {
    // LSP SymbolKind is 1-based; Monaco's is the same order but 0-based.
    const kind = (s.kind - 1) as Monaco.languages.SymbolKind;
    if ("location" in s) {
      const range = lspRangeToMonaco(s.location.range);
      return {
        name: s.name,
        detail: "",
        kind,
        tags: [],
        range,
        selectionRange: range,
        children: [],
      };
    }
    return {
      name: s.name,
      detail: s.detail ?? "",
      kind,
      tags: [],
      range: lspRangeToMonaco(s.range),
      selectionRange: lspRangeToMonaco(s.selectionRange ?? s.range),
      children: s.children ? toMonacoSymbols(s.children) : [],
    };
  });
}

function toMonacoWorkspaceEdit(
  monaco: typeof Monaco,
  res: LspWorkspaceEdit | null,
): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
  const push = (uri: string, list: LspTextEdit[]) => {
    for (const edit of list) {
      edits.push({
        resource: monaco.Uri.parse(uri),
        textEdit: { range: lspRangeToMonaco(edit.range), text: edit.newText },
        versionId: undefined,
      });
    }
  };
  if (res?.changes) {
    for (const [uri, list] of Object.entries(res.changes)) push(uri, list);
  }
  if (res?.documentChanges) {
    for (const dc of res.documentChanges) push(dc.textDocument.uri, dc.edits);
  }
  return { edits };
}
