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

import { useCallback, useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  isTextDoc,
  setPendingEditsFlusher,
  useEditorStore,
} from "../state/editorStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useStatusStore } from "../state/statusStore";
import { useSettingsStore, type Settings } from "../state/settingsStore";
import { monacoThemeFor, useThemeStore } from "../state/themeStore";
import { registerLanguages } from "../editor/monacoLanguages";
import {
  attachMonacoLsp,
  clearLspUriOverride,
  lspUriForModel,
  setLspUriOverride,
} from "../lsp/monacoLsp";
import {
  didChange,
  didClose,
  didOpen,
  ensureServer,
  getSession,
  stopServer,
} from "../lsp/lspClient";
import type { LspSession } from "../lsp/lspClient";
import { serverForLanguage } from "../lsp/servers";
import { setActiveEditor } from "../lib/editorBridge";
import { commandRegistry } from "../commands/commandRegistry";
import { reconcileMapMove } from "../lib/rekeyMapEntry";

// Monotonic LSP document version (incremented on every edit across models).
let lspChangeVersion = 1;
// Coalesce per-keystroke edits into one LSP didChange notification.
const LSP_DIDCHANGE_DEBOUNCE_MS = 150;
// Coalesce per-keystroke editor->store content writes (each one copies the
// whole document; a 10 MB file would otherwise produce tens of MB/s garbage).
const STORE_WRITE_DEBOUNCE_MS = 150;

// --- Debounced editor->store content sync ----------------------------------
// The dirty transition (clean -> first edit) writes through immediately so the
// tab's dirty dot appears on the first keystroke; while already dirty, writes
// are debounced. Every reader of doc.content (saves, dirty checks, run/build)
// calls flushPendingEdits() first — registered below via setPendingEditsFlusher
// so callers never import this (lazy-loaded) chunk. Module-level state: there
// is at most one Monaco host, and only the active model receives edits.
let pendingStoreWrite: {
  path: string;
  model: monaco.editor.ITextModel;
} | null = null;
let storeWriteTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingStoreWrite(): void {
  if (storeWriteTimer) {
    clearTimeout(storeWriteTimer);
    storeWriteTimer = null;
  }
  const pending = pendingStoreWrite;
  pendingStoreWrite = null;
  if (!pending || pending.model.isDisposed()) return;
  useEditorStore
    .getState()
    .updateContent(pending.path, pending.model.getValue());
}

setPendingEditsFlusher(flushPendingStoreWrite);

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
  // Per-tab Monaco view state (cursor, scroll, folds, selection). This lives on
  // the per-model viewModel that setModel() destroys/recreates, NOT on the text
  // model, so without explicit save/restore every tab switch resets the next tab
  // to scroll-top / (1,1) / folds-open. Keyed by path; re-keyed on rename.
  const viewStatesRef = useRef<
    Map<string, monaco.editor.ICodeEditorViewState | null>
  >(new Map());
  const currentPathRef = useRef<string | null>(null);

  const activePath = useEditorStore((s) => s.activePath);
  // A stable key for the *set* of open paths: changes only when a doc is opened
  // or closed, NOT on every keystroke (unlike subscribing to the docs array),
  // so the bind/dispose effects don't re-run while typing.
  const openPaths = useEditorStore((s) =>
    s.docs
      .filter(isTextDoc)
      .map((d) => d.path)
      .join("\n"),
  );
  const reloadVersions = useEditorStore((s) =>
    s.docs
      .filter(isTextDoc)
      .map((d) => `${d.path}:${d.reloadVersion}`)
      .join("\n"),
  );
  const pendingReveal = useEditorStore((s) => s.pendingReveal);
  const lastDocMoves = useEditorStore((s) => s.lastDocMoves);
  // Per-document (keyed by LSP URI) debounce + pending model, so a change in
  // one document never cancels another document's pending didChange on a fast
  // tab switch (a single shared timer would drop the outgoing doc's last edit).
  // The model (not its text) is stored; the full text is read once at flush.
  const lspChangeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pendingLspChanges = useRef<
    Map<string, { session: LspSession; model: monaco.editor.ITextModel }>
  >(new Map());
  const startedLangsRef = useRef<Set<string>>(new Set());

  // Send (and clear) the pending debounced didChange for an LSP URI immediately.
  const flushLspChange = useCallback((uri: string) => {
    const timer = lspChangeTimers.current.get(uri);
    if (timer) {
      clearTimeout(timer);
      lspChangeTimers.current.delete(uri);
    }
    const pending = pendingLspChanges.current.get(uri);
    if (pending) {
      pendingLspChanges.current.delete(uri);
      // Re-resolve the session by language: the one captured when the edit was
      // queued may have been stopped/restarted during the debounce window, in
      // which case `pending.session` is now disposed. Sending to the current
      // session (or dropping it if none) avoids a notify on a dead session;
      // didChange is gated on openDocs, so a fresh session safely ignores it.
      const session = getSession(pending.session.languageId);
      if (session && !pending.model.isDisposed()) {
        void didChange(
          session,
          uri,
          (lspChangeVersion += 1),
          pending.model.getValue(),
        );
      }
    }
  }, []);

  // Re-home a model left holding a stale, immutable URI by a prior same-language
  // rename: its modelsRef key is the doc's CURRENT path, but the model's URI
  // still points at the renamed-from path. Replace it with a fresh model at the
  // correct URI so the old URI is freed for reuse (the re-homed doc loses undo
  // history — the same tradeoff already accepted for language-changing renames).
  // Detaches it first if it is the bound model; the caller binds the real active
  // model immediately afterward.
  const rehomeStaleModel = useCallback((stale: monaco.editor.ITextModel) => {
    const editor = editorRef.current;
    let key: string | null = null;
    for (const [k, m] of modelsRef.current) {
      if (m === stale) {
        key = k;
        break;
      }
    }
    const session = getSession(stale.getLanguageId());
    if (session) void didClose(session, lspUriForModel(stale));
    if (editor?.getModel() === stale) editor.setModel(null);
    clearLspUriOverride(stale);
    const content = stale.getValue();
    const language = stale.getLanguageId();
    stale.dispose();
    if (key === null) return; // untracked orphan — released above, nothing to re-home
    const fresh = monaco.editor.createModel(
      content,
      language,
      monaco.Uri.file(key),
    );
    fresh.updateOptions({
      tabSize: useSettingsStore.getState().settings.tabSize,
    });
    modelsRef.current.set(key, fresh);
    if (session) void didOpen(session, lspUriForModel(fresh), language, content);
  }, []);

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

    // Override Monaco's built-in Alt+Z (which toggles Monaco's own wrap, leaving
    // our persisted setting out of sync) so it drives the settings store — the
    // single source of truth that the subscription below applies live. When the
    // editor isn't focused, the global keymap's alt+z handles it instead.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
      void commandRegistry.execute("editor.toggleWordWrap");
    });

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
      if (!path || !model) return;
      // Defensive: a pending write for a DIFFERENT doc (tab switched without a
      // flush — should not happen) must land before tracking this one.
      if (pendingStoreWrite && pendingStoreWrite.path !== path) {
        flushPendingStoreWrite();
      }
      const doc = useEditorStore.getState().docs.find((d) => d.path === path);
      const wasClean = !doc || doc.content === doc.savedContent;
      if (wasClean) {
        // First keystroke after a clean state: write through immediately so the
        // tab's dirty dot updates at once.
        if (storeWriteTimer) {
          clearTimeout(storeWriteTimer);
          storeWriteTimer = null;
        }
        pendingStoreWrite = null;
        useEditorStore.getState().updateContent(path, model.getValue());
      } else {
        pendingStoreWrite = { path, model };
        if (storeWriteTimer) clearTimeout(storeWriteTimer);
        storeWriteTimer = setTimeout(
          flushPendingStoreWrite,
          STORE_WRITE_DEBOUNCE_MS,
        );
      }
      const session = getSession(model.getLanguageId());
      if (session) {
        const uri = lspUriForModel(model);
        // Debounce per-URI: a burst of typing yields ONE didChange with the
        // latest text, and edits to other documents never clear this one.
        pendingLspChanges.current.set(uri, { session, model });
        const existing = lspChangeTimers.current.get(uri);
        if (existing) clearTimeout(existing);
        lspChangeTimers.current.set(
          uri,
          setTimeout(() => flushLspChange(uri), LSP_DIDCHANGE_DEBOUNCE_MS),
        );
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

    // Live Ln/Col for the status bar (isolated store; see statusStore).
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      useStatusStore
        .getState()
        .setCursor(e.position.lineNumber, e.position.column);
    });

    const models = modelsRef.current;
    const viewStates = viewStatesRef.current;
    const startedLangs = startedLangsRef.current;
    const timers = lspChangeTimers.current;
    const pendings = pendingLspChanges.current;
    return () => {
      unsubTheme();
      unsubSettings();
      changeSub.dispose();
      selSub.dispose();
      cursorSub.dispose();
      // Reset the status bar's Ln/Col: when the last document closes this editor
      // unmounts and the cursor store would otherwise keep showing the closed
      // file's stale position over the empty Welcome screen.
      useStatusStore.getState().setCursor(1, 1);
      setActiveEditor(null);
      // Commit any outstanding debounced content before the models go away.
      flushPendingStoreWrite();
      editor.dispose();
      editorRef.current = null;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      pendings.clear();
      models.forEach((m) => {
        clearLspUriOverride(m);
        m.dispose();
      });
      models.clear();
      viewStates.clear();
      // Stop the language servers this editor instance started.
      startedLangs.forEach((lang) => void stopServer(lang));
      startedLangs.clear();
    };
  }, [flushLspChange]);

  // Re-key models when open files are renamed/moved, BEFORE the bind/dispose
  // effects below react to the changed paths (effects run in declaration
  // order). Keeping the same model object preserves undo history + view state;
  // the LSP is told didClose(old)/didOpen(new) and the model's traffic is
  // routed through the new URI from now on (model URIs are immutable). When the
  // source has no preservable model, evict a stale destination model so the bind
  // effect recreates it from the authoritative moved document in the store.
  useEffect(() => {
    if (!lastDocMoves) return;
    for (const move of lastDocMoves.moves) {
      const doc = useEditorStore.getState().docs.find((d) => d.path === move.to);
      const model = reconcileMapMove(
        modelsRef.current,
        move.from,
        move.to,
        (candidate) =>
          !candidate.isDisposed() &&
          doc !== undefined &&
          isTextDoc(doc) &&
          doc.language === candidate.getLanguageId(),
        (displaced) => {
          const displacedUri = lspUriForModel(displaced);
          flushLspChange(displacedUri);
          const timer = lspChangeTimers.current.get(displacedUri);
          if (timer) {
            clearTimeout(timer);
            lspChangeTimers.current.delete(displacedUri);
          }
          pendingLspChanges.current.delete(displacedUri);
          if (pendingStoreWrite?.path === move.to) pendingStoreWrite = null;
          if (editorRef.current?.getModel() === displaced) {
            editorRef.current.setModel(null);
          }
          const displacedSession = getSession(displaced.getLanguageId());
          if (displacedSession) void didClose(displacedSession, displacedUri);
          clearLspUriOverride(displaced);
          displaced.dispose();
          viewStatesRef.current.delete(move.to);
          if (currentPathRef.current === move.to) currentPathRef.current = null;
        },
      );
      // A rename that changes the language (e.g. notes.txt -> notes.md) keeps
      // the old dispose/recreate path so the model is rebuilt with the right
      // grammar (undo history is lost in that case — known limitation).
      if (!model) continue;
      const oldUri = lspUriForModel(model);
      const newUri = monaco.Uri.file(move.to).toString();
      // Deliver the outgoing URI's pending edit before the server forgets it.
      flushLspChange(oldUri);
      // The model (and thus its view state) survives the rename — re-key it too.
      const movedView = viewStatesRef.current.get(move.from);
      if (movedView !== undefined) {
        viewStatesRef.current.delete(move.from);
        viewStatesRef.current.set(move.to, movedView);
      }
      if (pendingStoreWrite?.path === move.from) {
        pendingStoreWrite = { ...pendingStoreWrite, path: move.to };
      }
      if (currentPathRef.current === move.from) {
        currentPathRef.current = move.to;
      }
      setLspUriOverride(model, newUri);
      const session = getSession(model.getLanguageId());
      if (session) {
        void didClose(session, oldUri);
        void didOpen(session, newUri, model.getLanguageId(), model.getValue());
      }
    }
  }, [lastDocMoves, flushLspChange]);

  // Bind the active document's model to the editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Before (potentially) switching models, flush the outgoing document's
    // pending debounced store write + didChange so nothing reads stale state.
    flushPendingStoreWrite();
    const outgoing = editor.getModel();
    if (outgoing) flushLspChange(lspUriForModel(outgoing));
    // Save the outgoing tab's view state before any model swap below, so it can
    // be restored when this tab is next bound (see viewStatesRef).
    if (currentPathRef.current && outgoing) {
      viewStatesRef.current.set(currentPathRef.current, editor.saveViewState());
    }
    if (activePath === null) {
      editor.setModel(null);
      currentPathRef.current = null;
      return;
    }
    // Read the doc lazily (content/language are only needed at model creation);
    // this effect intentionally does NOT subscribe to doc content.
    const doc = useEditorStore.getState().docs.find((d) => d.path === activePath);
    if (!doc || !isTextDoc(doc)) {
      editor.setModel(null);
      currentPathRef.current = null;
      useEditorStore.getState().setSelection("");
      return;
    }
    let model = modelsRef.current.get(activePath);
    if (!model) {
      const uri = monaco.Uri.file(doc.path);
      // A prior same-language rename leaves the renamed doc's model keyed under
      // its NEW path but still holding its OLD (immutable) URI. Opening a brand
      // new file at that freed old path would collide with that orphan and make
      // createModel throw ("model already exists"). Re-home the orphan onto a
      // fresh model at its correct URI first, releasing this URI.
      const colliding = monaco.editor.getModel(uri);
      if (colliding && !colliding.isDisposed()) rehomeStaleModel(colliding);
      const created = monaco.editor.createModel(doc.content, doc.language, uri);
      modelsRef.current.set(activePath, created);
      created.updateOptions({
        tabSize: useSettingsStore.getState().settings.tabSize,
      });
      model = created;
      // Start the language server for this language (if any) and open the doc.
      if (serverForLanguage(doc.language)) {
        startedLangsRef.current.add(doc.language);
        const openedPath = doc.path;
        const rootPath = useWorkspaceStore.getState().rootPath;
        const juliaRuntimePath =
          useSettingsStore.getState().settings.runtimePaths.julia || null;
        void ensureServer(doc.language, rootPath, juliaRuntimePath).then(
          (session) => {
            if (!session) return;
            const liveDoc = useEditorStore
              .getState()
              .docs.find((candidate) => candidate.path === openedPath);
            if (
              !liveDoc ||
              !isTextDoc(liveDoc) ||
              created.isDisposed() ||
              modelsRef.current.get(openedPath) !== created
            ) {
              return;
            }
            void didOpen(
              session,
              lspUriForModel(created),
              liveDoc.language,
              created.getValue(),
            );
          },
        );
      }
    }
    const switching = editor.getModel() !== model;
    if (switching) editor.setModel(model);
    currentPathRef.current = activePath;
    // Restore this tab's saved view state (cursor/scroll/folds/selection) on a
    // real model swap; a freshly created model has none and stays at top/(1,1).
    if (switching) {
      const savedView = viewStatesRef.current.get(activePath);
      if (savedView) editor.restoreViewState(savedView);
    }
    // Sync the selection store to the newly-bound model so a stale selection
    // from the previous tab doesn't linger (run-selection would otherwise act
    // on text that is no longer visible).
    const selection = editor.getSelection();
    useEditorStore
      .getState()
      .setSelection(selection ? model.getValueInRange(selection) : "");
    // Sync the status-bar cursor to the restored view state of this tab.
    const position = editor.getPosition();
    useStatusStore
      .getState()
      .setCursor(position?.lineNumber ?? 1, position?.column ?? 1);
  }, [activePath, openPaths, flushLspChange, rehomeStaleModel]);

  // Reveal a requested position (e.g. a search result's line/column) once its
  // document is bound. The store field is consumed-and-cleared so a later tab
  // switch back to the same doc never re-reveals.
  useEffect(() => {
    if (!pendingReveal) return;
    const editor = editorRef.current;
    if (!editor || pendingReveal.path !== currentPathRef.current) return;
    const model = editor.getModel();
    if (!model) return;
    const position = model.validatePosition({
      lineNumber: pendingReveal.line,
      column: pendingReveal.column,
    });
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
    useEditorStore.getState().clearPendingReveal();
  }, [pendingReveal, activePath, openPaths]);

  // When a clean open text file changes on disk, the watcher updates the store.
  // Existing Monaco models do not subscribe to content, so explicitly sync only
  // on reloadVersion changes to avoid re-running this effect on every keystroke.
  useEffect(() => {
    // Commit any debounced active-doc edit FIRST. This effect fires on ANY open
    // doc's reloadVersion bump (e.g. a DIFFERENT file changed on disk), and that
    // bump can land in a later task than the watcher's flush (the clean-text
    // reload awaits readFile). Without flushing here, the setValue below would
    // overwrite the active model with the store's lagged content, discarding the
    // user's un-flushed keystrokes. After the flush the active dirty doc has
    // model.getValue() === doc.content and is skipped by the guard below.
    flushPendingStoreWrite();
    for (const doc of useEditorStore.getState().docs.filter(isTextDoc)) {
      const model = modelsRef.current.get(doc.path);
      if (!model || model.getValue() === doc.content) continue;
      const uri = lspUriForModel(model);
      const isActiveModel = editorRef.current?.getModel() === model;
      flushLspChange(uri);
      model.setValue(doc.content);
      if (!isActiveModel) {
        const session = getSession(model.getLanguageId());
        if (session) {
          void didChange(session, uri, (lspChangeVersion += 1), doc.content);
        }
      }
    }
  }, [reloadVersions, flushLspChange]);

  // Dispose models for documents that were closed (runs only when the open set
  // changes, not on every keystroke).
  useEffect(() => {
    const open = new Set(
      useEditorStore.getState().docs.filter(isTextDoc).map((d) => d.path),
    );
    for (const [path, model] of modelsRef.current) {
      if (!open.has(path)) {
        const uri = lspUriForModel(model);
        // Drop any pending debounced change for this doc so its timer can't fire
        // after didClose (a no-op now that didChange is gated on openDocs, but we
        // also avoid leaking the timer/payload until the whole editor unmounts).
        const timer = lspChangeTimers.current.get(uri);
        if (timer) {
          clearTimeout(timer);
          lspChangeTimers.current.delete(uri);
        }
        pendingLspChanges.current.delete(uri);
        if (pendingStoreWrite?.path === path) pendingStoreWrite = null;
        const session = getSession(model.getLanguageId());
        if (session) void didClose(session, uri);
        clearLspUriOverride(model);
        model.dispose();
        modelsRef.current.delete(path);
        viewStatesRef.current.delete(path);
      }
    }
  }, [openPaths]);

  return <div className="monaco-host" ref={hostRef} />;
}
