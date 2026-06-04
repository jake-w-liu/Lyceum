# Risks & Deferred Features

This document tracks the technical risks for the project and the features explicitly
punted out of v1. It is aligned with the canonical tech decisions: Tauri v2 + Rust
(edition 2021) backend; React 19 + TypeScript + Vite frontend; Monaco editor; xterm.js
with a real PTY via `portable-pty`; PDF.js (`pdfjs-dist`); a generic JSON-RPC LSP client;
Zustand state; plain CSS with custom properties; and a TS command + keybinding registry.

## 1. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **LSP integration complexity (generic JSON-RPC client).** A single generic client must correctly bridge stdio language servers (Julia LanguageServer.jl, then pyright, then csharp-ls/OmniSharp) through the Rust backend to the frontend via Tauri commands/events. Message framing (`Content-Length` headers), request/response correlation, and lifecycle (initialize/shutdown) are easy to get subtly wrong. | High | High | Build the client incrementally against the LSP spec with a small, well-tested message framer in Rust (`cargo test`); start with one server (Julia) before generalizing. Add Vitest coverage for the frontend RPC layer. Keep the bridge protocol-agnostic so adding pyright/csharp-ls is config, not new code. Per the NO-BUG POLICY, every LSP feature ships with tests. |
| **Julia LanguageServer.jl startup latency.** LanguageServer.jl can take many seconds (sometimes tens of seconds) to precompile and index on first launch, during which completions/diagnostics are unavailable. This can read as a hang or a broken feature. | High | Medium | Lazy-load the LSP server (do not block app start). Show explicit "Language server starting…" status in the StatusBar and degrade gracefully (editing still works without LSP). Reuse a warm server process across files. Surface `juliaPath` as a setting so users can point at a fast/local Julia. Document expected first-run latency in `docs/ARCHITECTURE.md`. |
| **PTY / terminal cross-platform quirks.** `portable-pty` behavior, default shells, signal handling, resize (SIGWINCH), and line-ending conventions differ across macOS, Windows, and Linux. Output streamed over Tauri events must stay ordered and not be dropped under load. | High | Medium | Abstract shell launch behind a single Rust module; honor the `shellPath` and `terminalCwdBehavior` (`workspaceRoot`/`currentFileDir`) settings. Test on all three OSes. Buffer/coalesce PTY output before emitting events; forward resize from xterm.js via a Tauri command. Detect a sensible default shell per platform. |
| **Monaco bundle size.** Monaco is large and can bloat the initial bundle and slow startup, conflicting with the performance goal. | Medium | Medium | Lazy-load Monaco (per the performance decision) so it is not in the initial paint path. Use Vite code-splitting and load only required language workers/grammars. Track bundle size as part of the M12 performance pass. |
| **PDF.js worker setup in Tauri.** PDF.js requires a separate worker (`pdf.worker`); worker URL resolution and the Tauri asset/CSP model frequently break worker loading inside a packaged app (vs. dev). | Medium | Medium | Lazy-load `pdfjs-dist` and configure the worker via a Vite-bundled worker URL (not a CDN). Verify worker loading both in `tauri dev` and in a packaged build. Adjust the Tauri CSP/asset protocol so the worker and preview bytes load. |
| **Tauri v2 capability / permission friction.** Tauri v2's capability and permission system is strict; missing or misconfigured permissions silently block commands, events, FS access, and the asset protocol, producing confusing runtime failures. | Medium | Medium | Define capabilities explicitly and minimally per window; enumerate the exact commands/events the frontend uses. Keep `src-tauri` capability config under review and test packaged builds early, since dev and bundled permission behavior can differ. Document required permissions in `docs/ARCHITECTURE.md`. |
| **Unconfined filesystem commands + disabled CSP.** The custom `read_file`/`write_file`/`read_file_bytes`/`read_directory`/`list_workspace_files` commands take an arbitrary frontend-supplied path with no workspace-root confinement, and `tauri.conf.json` sets `security.csp = null`. For the intended single-user desktop app loading a bundled local frontend this is acceptable (and opening files outside the workspace is a legitimate feature, like VS Code), but if webview content were ever compromised it could read/write any file the user can. | Low (local, trusted frontend) | Medium | **Tracked for M12 hardening:** add a real Content-Security-Policy compatible with Monaco/xterm/pdf.js workers, and an optional workspace-root confinement guard (canonicalize + prefix-check) toggled by a setting for users who want it. Confirmed by the M8 no-bug review; deliberately not enforced in v1 to preserve cross-folder file opening. |
| **Tree-sitter build complexity.** Tree-sitter grammars pull in native/`build.rs` compilation and per-grammar build steps, complicating the toolchain and CI across platforms. | Medium | Low–Medium | Use Tree-sitter ONLY where a Monaco built-in grammar is missing or weak (e.g. Julia, LaTeX) — Monaco grammars first. Isolate any Tree-sitter usage behind a `build.rs` step and keep grammars vendored/pinned. If a grammar proves too costly, fall back to a TextMate/Monarch grammar instead of blocking the milestone. |
| **macOS code-signing & notarization (packaging).** Distributing a notarized macOS app requires an Apple Developer ID, signing, and notarization; misconfiguration yields Gatekeeper warnings or unlaunchable builds. The process is opaque and slow to iterate. | Medium | High | Treat signing/notarization as part of M12 packaging, not a v1 blocker for local/dev use. Document the Developer ID + notarization steps; script signing in CI with secrets. Ship unsigned dev builds early and gate notarization on having credentials. |

## 2. Deferred Features (out of scope for v1)

The following are explicitly punted from v1. Each is a deliberate non-goal, not an
oversight.

### Declared non-goals (from the spec)

- **VS Code extension compatibility** — no extension marketplace, no extension host.
- **Debugger** — no DAP/debug UI.
- **Marketplace** — no plugin/extension marketplace.
- **Remote SSH** — local workspaces only.
- **Notebooks** — no notebook editing/execution UI.
- **Full Git UI** — no source-control panel, diff/staging UI, or history viewer.
- **Plugin system** — no third-party plugin API.
- **Exact VS Code API compatibility** — VS Code-*like* layout and keybindings only; this is **not a 1:1 VS Code clone**.
- **Background indexing** — no project-wide background indexing in v1.

### Additional deferrals

- **File-explorer drag reorder** — drag-to-move between folders is implemented,
  but arbitrary custom sort/reorder within a directory is still out of scope
  because the Explorer mirrors filesystem ordering.
- **Rename-symbol when the language server lacks it** — rename is offered only when the active LSP server advertises rename support; no client-side fallback rename.
- **PDF text search** — if text extraction/search via PDF.js proves infeasible within the Tauri worker/CSP setup, PDF text search is deferred (rendering/preview still ships).
- **Plot viewer** — no dedicated panel for rendering Julia/plotting output (e.g. inline figures) in v1.
- **Pluto launcher** — no integrated Pluto.jl notebook launcher (consistent with the no-notebooks non-goal).
- **Package-environment detection** — no automatic detection/activation of Julia `Project.toml`/package environments; `juliaPath` is configured via settings.
- **Auto-detection of fish / git-bash shells** — if these shells are not detected as a sensible default, they are not special-cased; users can point at them via the `shellPath` setting.

### Notes on alignment

These deferrals keep v1 focused on the milestone path (M0–M12): shell layout, file
explorer, Monaco tabs/save, the command + keybinding registries, the PTY terminal,
PDF/image preview, syntax highlighting + themes, the Julia run-file/run-selection
workflow, the generic LSP client with Julia LanguageServer.jl,
settings/workspace persistence, the Markdown/HTML/LaTeX preview workflow, and
the performance + packaging pass. Settings that govern several deferral
decisions — `shellPath`, `terminalCwdBehavior`, `juliaPath`, and
`latexBuildCommand` — remain in the persisted settings schema so the supported
manual configuration paths are clear.
