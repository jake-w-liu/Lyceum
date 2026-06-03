// Monaco editor host (M3). Default-exported and loaded via React.lazy from
// EditorArea so the (large) monaco bundle + language workers land in a separate
// chunk that is only fetched once the first document opens (perf goal).
//
// One editor instance is reused; each open document gets its own text model
// (keyed by path) so switching tabs preserves cursor/undo state. Content edits
// flow back to the editor store; closing a tab disposes its model.
//
// Not unit-tested: Monaco requires real layout/canvas/workers unavailable in
// jsdom. The editor *store*, language map, tab bar, and file I/O are unit-tested;
// this wrapper is exercised by the `tauri dev` smoke test.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useEditorStore } from "../state/editorStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useSettingsStore, type Settings } from "../state/settingsStore";
import { monacoThemeFor, useThemeStore } from "../state/themeStore";
import { registerLanguages } from "../editor/monacoLanguages";
import { attachMonacoLsp } from "../lsp/monacoLsp";
import {
  didChange,
  didClose,
  didOpen,
  ensureServer,
  getSession,
  stopServer,
} from "../lsp/lspClient";
import { serverForLanguage } from "../lsp/servers";
import { setActiveEditor } from "../lib/editorBridge";

// Monotonic LSP document version (incremented on every edit across models).
let lspChangeVersion = 1;
// Coalesce per-keystroke edits into one LSP didChange notification.
const LSP_DIDCHANGE_DEBOUNCE_MS = 150;

// Wire Monaco's web workers for Vite (offline; no CDN). Configured once.
type MonacoEnv = { getWorker: (workerId: string, label: string) => Worker };
(self as unknown as { MonacoEnvironment?: MonacoEnv }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

function editorOptionsFromSettings(s: Settings): monaco.editor.IEditorOptions {
  return {
    fontSize: s.fontSize,
    fontFamily: s.fontFamily || undefined,
    lineHeight: s.lineHeight || undefined,
    fontLigatures: s.ligatures,
    minimap: { enabled: s.minimap },
    lineNumbers: s.lineNumbers ? "on" : "off",
    wordWrap: s.wordWrap,
  };
}

export default function MonacoEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const currentPathRef = useRef<string | null>(null);

  const activePath = useEditorStore((s) => s.activePath);
  // A stable key for the *set* of open paths: changes only when a doc is opened
  // or closed, NOT on every keystroke (unlike subscribing to the docs array),
  // so the bind/dispose effects don't re-run while typing.
  const openPaths = useEditorStore((s) => s.docs.map((d) => d.path).join("\n"));
  const lspChangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedLangsRef = useRef<Set<string>>(new Set());

  // Create the single editor instance once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Register Julia/LaTeX/TOML grammars (Monaco lacks them) before creating,
    // and wire LSP providers (diagnostics/hover/definition/references/completion).
    registerLanguages(monaco);
    attachMonacoLsp(monaco);
    const editor = monaco.editor.create(host, {
      automaticLayout: true,
      theme: monacoThemeFor(useThemeStore.getState().theme),
      scrollBeyondLastLine: false,
      ...editorOptionsFromSettings(useSettingsStore.getState().settings),
    });
    editorRef.current = editor;
    setActiveEditor(editor); // expose to workbench commands (format/goto/rename)

    // Keep Monaco's theme in sync with the app theme.
    const unsubTheme = useThemeStore.subscribe((s) =>
      monaco.editor.setTheme(monacoThemeFor(s.theme)),
    );

    // Apply editor settings live (font, minimap, wrap, line numbers, tab size).
    const unsubSettings = useSettingsStore.subscribe((st) => {
      editor.updateOptions(editorOptionsFromSettings(st.settings));
      modelsRef.current.forEach((m) =>
        m.updateOptions({ tabSize: st.settings.tabSize }),
      );
    });

    const changeSub = editor.onDidChangeModelContent(() => {
      const path = currentPathRef.current;
      const model = editor.getModel();
      if (path && model) {
        const text = model.getValue();
        useEditorStore.getState().updateContent(path, text);
        const session = getSession(model.getLanguageId());
        if (session) {
          const uri = model.uri.toString();
          // Debounce: a burst of typing yields ONE didChange with the latest text.
          if (lspChangeTimer.current) clearTimeout(lspChangeTimer.current);
          lspChangeTimer.current = setTimeout(() => {
            void didChange(session, uri, (lspChangeVersion += 1), text);
          }, LSP_DIDCHANGE_DEBOUNCE_MS);
        }
      }
    });

    const selSub = editor.onDidChangeCursorSelection(() => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      useEditorStore
        .getState()
        .setSelection(
          model && selection ? model.getValueInRange(selection) : "",
        );
    });

    const models = modelsRef.current;
    const startedLangs = startedLangsRef.current;
    const changeTimer = lspChangeTimer;
    return () => {
      unsubTheme();
      unsubSettings();
      changeSub.dispose();
      selSub.dispose();
      setActiveEditor(null);
      editor.dispose();
      editorRef.current = null;
      if (changeTimer.current) clearTimeout(changeTimer.current);
      models.forEach((m) => m.dispose());
      models.clear();
      // Stop the language servers this editor instance started.
      startedLangs.forEach((lang) => void stopServer(lang));
      startedLangs.clear();
    };
  }, []);

  // Bind the active document's model to the editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (activePath === null) {
      editor.setModel(null);
      currentPathRef.current = null;
      return;
    }
    // Read the doc lazily (content/language are only needed at model creation);
    // this effect intentionally does NOT subscribe to doc content.
    const doc = useEditorStore.getState().docs.find((d) => d.path === activePath);
    if (!doc) return;
    let model = modelsRef.current.get(activePath);
    if (!model) {
      const created = monaco.editor.createModel(
        doc.content,
        doc.language,
        monaco.Uri.file(doc.path),
      );
      modelsRef.current.set(activePath, created);
      created.updateOptions({
        tabSize: useSettingsStore.getState().settings.tabSize,
      });
      model = created;
      // Start the language server for this language (if any) and open the doc.
      if (serverForLanguage(doc.language)) {
        startedLangsRef.current.add(doc.language);
        const rootPath = useWorkspaceStore.getState().rootPath;
        const juliaPath =
          useSettingsStore.getState().settings.juliaPath || null;
        void ensureServer(doc.language, rootPath, juliaPath).then((session) => {
          if (session) {
            void didOpen(
              session,
              created.uri.toString(),
              doc.language,
              doc.content,
            );
          }
        });
      }
    }
    if (editor.getModel() !== model) editor.setModel(model);
    currentPathRef.current = activePath;
  }, [activePath, openPaths]);

  // Dispose models for documents that were closed (runs only when the open set
  // changes, not on every keystroke).
  useEffect(() => {
    const open = new Set(useEditorStore.getState().docs.map((d) => d.path));
    for (const [path, model] of modelsRef.current) {
      if (!open.has(path)) {
        const session = getSession(model.getLanguageId());
        if (session) void didClose(session, model.uri.toString());
        model.dispose();
        modelsRef.current.delete(path);
      }
    }
  }, [openPaths]);

  return <div className="monaco-host" ref={hostRef} />;
}
