// Bottom status bar. Shows the active document's language and language-server
// status, plus live platform/version details fetched from the Rust backend.

import { useEffect, useState } from "react";
import { getAppInfo, type AppInfo } from "../lib/ipc";
import { getActiveDoc, useEditorStore } from "../state/editorStore";
import { useLspStatusStore, type LspStatus } from "../state/lspStatusStore";
import { serverForLanguage } from "../lsp/servers";

const LSP_LABEL: Record<LspStatus, string> = {
  off: "off",
  starting: "starting…",
  ready: "ready",
  error: "error",
};

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let active = true;
    getAppInfo().then((result) => {
      if (active) setInfo(result);
    });
    return () => {
      active = false;
    };
  }, []);

  // Select only the primitive we render, so editing (which replaces the active
  // doc object every keystroke) doesn't re-render the status bar.
  const language = useEditorStore((s) => getActiveDoc(s)?.language ?? "plaintext");
  const lspByLanguage = useLspStatusStore((s) => s.byLanguage);
  const lspStatus = serverForLanguage(language)
    ? (lspByLanguage[language] ?? "off")
    : null;

  return (
    <footer className="status-bar" aria-label="Status Bar">
      <div className="status-bar-left">
        <span className="status-item">Lyceum</span>
        <span className="status-item">No folder opened</span>
      </div>
      <div className="status-bar-right">
        {lspStatus && (
          <span className="status-item" data-testid="status-lsp">
            {language} LSP: {LSP_LABEL[lspStatus]}
          </span>
        )}
        <span className="status-item">Ln 1, Col 1</span>
        <span className="status-item">UTF-8</span>
        <span className="status-item">{language}</span>
        {info && (
          <span className="status-item" data-testid="status-platform">
            {info.os} · {info.arch} · v{info.version}
          </span>
        )}
      </div>
    </footer>
  );
}
