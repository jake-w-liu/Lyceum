// A tiny bridge exposing the active Monaco editor instance so workbench commands
// (Format Document, Go to Line, Rename Symbol, Go to Symbol) can trigger Monaco
// actions without importing monaco into the main bundle. Type-only monaco import
// keeps this module out of the eager bundle's monaco dependency.

import type { editor } from "monaco-editor";

let activeEditor: editor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(instance: editor.IStandaloneCodeEditor | null): void {
  activeEditor = instance;
}

export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  return activeEditor;
}

/** Focus the editor and run one of its built-in actions by id (no-op if none). */
export function runEditorAction(actionId: string): void {
  if (!activeEditor) return;
  activeEditor.focus();
  void activeEditor.getAction(actionId)?.run();
}
