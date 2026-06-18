# Risks & Deferred Features

This document tracks the technical risks for the project and the features explicitly
punted out of v1. It is aligned with the canonical tech decisions: Tauri v2 + Rust
(edition 2021) backend; React 19 + TypeScript + Vite frontend; Monaco editor; xterm.js
with a real PTY via `portable-pty`; PDF.js (`pdfjs-dist`); a generic JSON-RPC LSP client;
Zustand state; plain CSS with custom properties; and a TS command + keybinding registry.

## 1. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **LSP integration complexity (generic JSON-RPC client).** A single generic client must correctly bridge stdio language servers (Julia LanguageServer.jl, pyright, typescript-language-server, rust-analyzer, clangd, gopls, csharp-ls, R languageserver) through the Rust backend to the frontend via Tauri commands/events. Message framing (`Content-Length` headers), request/response correlation, and lifecycle (initialize/shutdown) are easy to get subtly wrong. | High | High | Build the client incrementally against the LSP spec with a small, well-tested message framer in Rust (`cargo test`). Add Vitest coverage for the frontend RPC layer. Keep the bridge protocol-agnostic so server additions are config plus backend command allowlist entries, not new client protocol code. |
| **Language-server startup latency.** Some servers, especially Julia LanguageServer.jl, can take many seconds to precompile and index on first launch, during which completions/diagnostics are unavailable. This can read as a hang or a broken feature. | High | Medium | Lazy-load language servers (do not block app start). Show explicit "Language server starting…" status in the StatusBar and degrade gracefully (editing still works without LSP). Reuse a warm server process across files. Surface `runtimePaths.julia` for Julia startup. Document expected first-run latency in `docs/ARCHITECTURE.md`. |
| **PTY / terminal cross-platform quirks.** `portable-pty` behavior, default shells, signal handling, resize (SIGWINCH), and line-ending conventions differ across macOS, Windows, and Linux. Output streamed over Tauri events must stay ordered and not be dropped under load. | High | Medium | Abstract shell launch behind a single Rust module; honor the `shellPath` and `terminalCwdBehavior` (`workspaceRoot`/`currentFileDir`) settings. Test on all three OSes. Buffer/coalesce PTY output before emitting events; forward resize from xterm.js via a Tauri command. Detect a sensible default shell per platform. |
| **Monaco bundle size.** Monaco is large and can bloat the initial bundle and slow startup, conflicting with the performance goal. | Medium | Medium | Lazy-load Monaco (per the performance decision) so it is not in the initial paint path. Use Vite code-splitting and load only required language workers/grammars. Track bundle size as part of the M12 performance pass. |
| **PDF.js worker setup in Tauri.** PDF.js requires a separate worker (`pdf.worker`); worker URL resolution and the Tauri asset/CSP model frequently break worker loading inside a packaged app (vs. dev). | Medium | Medium | Lazy-load `pdfjs-dist` and configure the worker via a Vite-bundled worker URL (not a CDN). Verify worker loading both in `tauri dev` and in a packaged build. Adjust the Tauri CSP/asset protocol so the worker and preview bytes load. |
| **Tauri v2 capability / permission friction.** Tauri v2's capability and permission system is strict; missing or misconfigured permissions silently block commands, events, FS access, and the asset protocol, producing confusing runtime failures. | Medium | Medium | Define capabilities explicitly and minimally per window; enumerate the exact commands/events the frontend uses. Keep `src-tauri` capability config under review and test packaged builds early, since dev and bundled permission behavior can differ. Document required permissions in `docs/ARCHITECTURE.md`. |
| **Workspace authorization IPC + HTML preview asset-scope lifetime.** Filesystem IPC is confined to per-window authorized workspace roots, and CSP is explicit, but a compromised renderer could still try to authorize a broader root. Sandboxed HTML previews also rely on Tauri's `asset:` protocol for relative project assets. In Tauri 2.11.2, `forbid_directory` has permanent precedence over previous/future allows and there is no remove/unforbid API, so a workspace asset scope cannot be cleanly revoked without breaking later previews in the same process. | Low (local, trusted frontend) | Medium | Keep the static asset protocol scope empty and add workspace roots only on demand. Keep HTML previews sandboxed without `allow-same-origin`; PDFs/images use byte IPC and Blob URLs instead of `asset:`. Track a future backend-owned workspace picker/authorization flow plus an in-app preview asset resolver if compromised-renderer hardening becomes a requirement. |
| **Custom grammar drift.** Small Monarch grammars for Julia, LaTeX, and TOML can lag behind full language syntax. | Medium | Low–Medium | Keep Monarch grammars focused on editor readability, prefer Monaco built-ins wherever available, and cover language detection/registration with tests. Avoid native grammar dependencies unless a future feature requires them. |
| **macOS code-signing & notarization (packaging).** Distributing a notarized macOS app requires an Apple Developer ID, signing, and notarization; misconfiguration yields Gatekeeper warnings or unlaunchable builds. The process is opaque and slow to iterate. | Medium | High | The manual release workflow builds unsigned artifacts for verification. Production distribution still requires Developer ID/notarization secrets and a signing pass before publishing public macOS installers. |

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
- **Package-environment detection** — no automatic detection/activation of language-specific environments; runtime paths are configured via `runtimePaths`.
- **Auto-detection of fish / git-bash shells** — if these shells are not detected as a sensible default, they are not special-cased; users can point at them via the `shellPath` setting.

### Notes on alignment

These deferrals keep v1 focused on the milestone path (M0–M12): shell layout, file
explorer, Monaco tabs/save, the command + keybinding registries, the PTY terminal,
PDF/image preview, syntax highlighting + themes, built-in run-file/run-selection
profiles, the generic LSP client with built-in server profiles,
settings/workspace persistence, the Markdown/HTML/LaTeX preview workflow, and
the performance + packaging pass. Settings that govern several deferral
decisions — `shellPath`, `terminalCwdBehavior`, `runtimePaths`, and
`latexBuildCommand` — remain in the persisted settings schema so the supported
manual configuration paths are clear.
