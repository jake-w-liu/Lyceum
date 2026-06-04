# Implementation Tracker

Primary progress tracker for the lightweight, VS Code-inspired research IDE built with Tauri (Julia-first workflow). This file is GitHub-flavored markdown. Update checkboxes as work completes.

**HARD CONSTRAINT:** This is NOT a 1:1 VS Code clone. It is a focused editor with a VS Code-like layout, common keybindings, code editing, terminal integration, syntax highlighting, Markdown/HTML/PDF/image preview, and a Julia-first workflow. Use ONLY original code and permissive open-source dependencies. Do not copy VS Code source.

## Canonical Tech Decisions (single source of truth)

- [x] Backend: Tauri v2, Rust (edition 2021)
- [x] Frontend: React 19 + TypeScript, built with Vite
- [x] Editor: Monaco Editor (`monaco-editor`), lazy-loaded
- [x] Terminal: xterm.js in the frontend; real PTY in the Rust backend via the `portable-pty` crate (output streamed over Tauri events, input sent via Tauri commands)
- [x] Preview: Markdown/HTML inline previews, PDF.js (`pdfjs-dist`) and image previews, lazy-loaded where heavy
- [x] Syntax highlighting: Monaco built-in grammars first; custom Monarch grammars where missing (Julia, LaTeX, TOML) — Tree-sitter not needed for v1
- [x] State management: Zustand (small, simple stores) — no Redux
- [x] Styling: plain CSS with CSS custom properties (CSS variables) for theming — no heavy UI framework
- [x] LSP: a generic JSON-RPC LSP client; Rust backend spawns language servers over stdio and bridges messages to the frontend via Tauri commands/events (order: Julia LanguageServer.jl, then Python pyright, then C# csharp-ls/OmniSharp)
- [x] Command system: a TS command registry (every action is a command) + a keybinding registry mapping shortcuts to command ids; keybindings persisted as JSON; settings persisted as JSON in the OS app-config dir via Tauri
- [x] Testing: Vitest + React Testing Library for the frontend; `cargo test` for Rust
- [x] Performance: lazy-load Monaco, PDF.js/image previews, terminal, and LSP servers; no extension marketplace, no Electron, no background indexing in v1

---

## Deliverables

- [x] `docs/ARCHITECTURE.md` — system architecture, module boundaries, Tauri command/event surface, data flow
- [x] `docs/ROADMAP.md` — milestone roadmap M0..M12 with scope and sequencing
- [x] `docs/KEYBINDINGS.md` — full default keymap and command-id mapping
- [x] `docs/SETTINGS_SCHEMA.md` — settings JSON schema documenting every persisted key
- [x] `docs/RISKS.md` — risk register with mitigations
- [x] Canonical repository structure scaffolded (see below)
- [x] Working M0 (Tauri + React + TS project that builds and launches)
- [x] Working M1 (shell layout: activity bar, sidebar, editor area, bottom panel, status bar)
- [x] Risks list maintained and current

### Canonical repository structure

- [x] `Lyceum/docs/` — ARCHITECTURE.md, ROADMAP.md, KEYBINDINGS.md, SETTINGS_SCHEMA.md, RISKS.md
- [x] `Lyceum/src/` — React + TS frontend
  - [x] `src/main.tsx`, `src/App.tsx`
  - [x] `src/components/` — ActivityBar.tsx, Sidebar.tsx, EditorArea.tsx, BottomPanel.tsx, StatusBar.tsx, ...
  - [x] `src/state/` — Zustand stores (layoutStore.ts, ...)
  - [x] `src/commands/` — command registry + built-in commands
  - [x] `src/keybindings/` — keybinding registry + default keymap (+ `src/lsp/`, `src/editor/` added for LSP and language grammars)
  - [x] `src/lib/` — Tauri IPC wrappers, LSP client, etc.
  - [x] `src/styles/` — global.css, theme variables
- [x] `Lyceum/src-tauri/` — Rust backend (Cargo.toml, tauri.conf.json, build.rs, src/main.rs, src/lib.rs, src/<modules>)
- [x] `Lyceum/public/`
- [x] `Lyceum/index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`
- [x] `Lyceum/TRACKER.md`, `Lyceum/README.md`

---

## Custom Skills

- [x] **build** skill — install deps, run Vite build, run `cargo build`, produce a Tauri dev/release build; reports failures clearly
- [x] **debug** skill — launch the app in dev mode, surface Rust + frontend logs, attach to PTY/LSP streams, reproduce and isolate issues
- [x] **review** skill — run the full test suite (Vitest + `cargo test`), lint/typecheck, and report against the Definition of Done
- [x] **test** skill — write/run Vitest + `cargo test`; enforce the no-bug policy (a regression test for every fix)
- [x] **new-ipc-command** skill — add a Tauri command end-to-end (Rust logic+test → `#[command]` → capability → typed `lib/ipc.ts` wrapper → tests), keeping TS/Rust contracts in sync
- [x] **milestone** skill — drive a roadmap milestone to completion under the no-bug policy (plan → implement → test → review → check off tracker → commit)
- [x] **add-lsp** skill — wire a new language server into the generic LSP layer (forward-looking for M9: Julia → Python → C#)

---

## Milestones

### M0 — Create Tauri + React + TypeScript project

- [x] Initialize Tauri v2 project with Rust backend (edition 2021)
- [x] Scaffold React 19 + TypeScript frontend built with Vite
- [x] Configure `package.json` scripts (dev, build, test) and `tsconfig.json` (strict mode)
- [x] Create `vite.config.ts` wired for Tauri dev server and HMR
- [x] Configure `src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`
- [x] Add `index.html`, `src/main.tsx`, minimal `src/App.tsx` that renders and mounts
- [x] Verify `cargo build` succeeds and the Tauri dev window launches the React app
- [x] Add `README.md` with build/run instructions
- [x] **Tests**
  - [x] Vitest configured; smoke test renders `App` without crashing
  - [x] `cargo test` configured; placeholder backend test passes (`app_info` — 3 tests)
  - [x] CI-style local command runs both test suites green (`typecheck` + Vitest + `cargo test`)

### M1 — Shell layout: activity bar, sidebar, editor area, bottom panel, status bar

- [x] Implement `ActivityBar.tsx` (icon rail) with selectable implemented views: Explorer and Search; non-goal placeholders are not shown
- [x] Implement `Sidebar.tsx` (collapsible panel bound to active activity item)
- [x] Implement `EditorArea.tsx` (central region for tabs, Monaco, and inline previews)
- [x] Implement `BottomPanel.tsx` (collapsible panel for terminal/output)
- [x] Implement `StatusBar.tsx` (bottom status strip; shows real backend platform info via `get_app_info` IPC)
- [x] Create `state/layoutStore.ts` (Zustand) tracking sidebar/bottom-panel visibility and active view
- [x] Implement `styles/global.css` and theme CSS variables (no UI framework)
- [x] Wire toggle actions for sidebar and bottom panel through layout store
- [x] Verify resizable/collapsible regions render in correct VS Code-like positions (draggable `Resizer` + right-side PDF panel region)
- [x] **Tests**
  - [x] Render test: all five layout regions present in the DOM
  - [x] layoutStore unit tests: toggle sidebar, toggle bottom panel, set active view
  - [x] Render test: hiding sidebar/bottom panel removes them from layout

### M2 — File explorer + open-folder workflow

- [x] Tauri command to open a folder (native dialog via `tauri-plugin-dialog`) and return the workspace root (`pickFolder`)
- [x] Rust command(s) to read directory trees safely (path scoping, error handling) — `fs_ops::read_directory`
- [x] File explorer tree component in the sidebar (expand/collapse, lazy children) — `Explorer.tsx`
- [x] Open-file action wired from explorer (emits an open *intent* via `workspaceStore.requestOpenFile`; the editor consumes it in M3)
- [x] Zustand workspace store (root path, open folder state) — `workspaceStore.ts`
- [x] **Tests**
  - [x] Rust: directory-read command returns expected entries for a temp tree (4 `fs_ops` tests)
  - [x] Frontend: explorer renders a mocked tree and expands/collapses nodes
  - [x] Frontend: clicking a file dispatches the open-file intent

### M3 — Monaco editor with tabs + save/open

- [x] Lazy-load Monaco editor into the editor area (own chunk via `React.lazy`; main bundle stays ~66 kB gzip)
- [x] Tab model + tab strip (open, switch, close, dirty indicator) — `TabBar.tsx`
- [x] Tauri commands for reading and writing file contents — `file_ops::read_file` / `write_file`
- [x] Save (Cmd/Ctrl+S) and open flows wired to backend (`useEditorKeybindings`, `useOpenFileBridge`)
- [x] Editor store (Zustand): open documents, active tab, dirty state — `editorStore.ts`
- [x] **Tests**
  - [x] Rust: read/write file commands round-trip content (3 `file_ops` tests)
  - [x] Frontend: editor store opens, switches, and closes tabs (+ language map, tab bar, save/cycle, open-bridge)
  - [x] Frontend: dirty flag set on edit and cleared on save

### M4 — Command registry + keybinding registry

- [x] TS command registry in `src/commands/` (register, lookup, execute by id)
- [x] Built-in commands wired to existing actions (`builtinCommands.ts`)
- [x] Keybinding registry in `src/keybindings/` mapping shortcuts to command ids (matcher + `when` evaluator)
- [x] Default keymap with macOS Cmd vs Win/Linux Ctrl handling (`DEFAULT_KEYMAP`; on-disk JSON persistence in M10)
- [x] Command palette UI (Cmd/Ctrl+Shift+P) and quick open (Cmd/Ctrl+P)
- [x] Persist keybindings as JSON via Tauri (load on startup, save on change) — completed in **M10** (settings/keybindings persistence)
- [x] Implement required keybindings:
  - [x] Cmd/Ctrl+P quick open
  - [x] Cmd/Ctrl+Shift+P command palette
  - [x] Cmd/Ctrl+B toggle sidebar
  - [x] Ctrl+` toggle terminal panel (including macOS)
  - [x] Ctrl+Shift+` new terminal (including macOS)
  - [x] Cmd/Ctrl+J toggle bottom panel
  - [x] Cmd/Ctrl+S save
  - [x] Cmd/Ctrl+W close tab
  - [x] Cmd/Ctrl+Tab next tab; Cmd/Ctrl+Shift+Tab previous tab
  - [x] Cmd/Ctrl+F find in file (Monaco built-in); ~~Cmd/Ctrl+Shift+F search workspace~~ → workspace search is a later milestone
  - [x] Cmd/Ctrl+G go to line (Monaco built-in)
  - [x] F12 go to definition; Shift+F12 find references; Cmd/Ctrl+Click go to definition — completed in **M9** (LSP)
  - [x] Cmd/Ctrl+/ toggle line comment (Monaco built-in)
  - [x] Alt/Option+Up/Down move line; Shift+Alt/Option+Up/Down duplicate line (Monaco built-in)
  - [x] Cmd/Ctrl+Enter run current file or selected code — completed in **M8** (Julia run)
  - [x] Cmd/Ctrl+Shift+V toggles Markdown/HTML rendered preview
  - [x] Esc close command palette / quick open / find box / modal panel
- [x] **Tests**
  - [x] Command registry: register/execute/duplicate-id handling
  - [x] Keybinding registry: shortcut resolves to correct command id per platform (14 tests inc. mod resolution + `when`)
  - [x] Keybinding JSON persistence round-trips — completed in **M10**
  - [x] Command palette filters and runs a command (+ quick open, fuzzy, uiStore, Rust walk)

### M5 — Embedded terminal (xterm.js + real shell process via PTY)

- [x] Lazy-load xterm.js terminal in the bottom panel (own chunk via `React.lazy`)
- [x] Rust PTY backend using `portable-pty` (spawn shell, resize, kill) — `terminal.rs`
- [x] Stream PTY output to frontend via Tauri events (`terminal:data:<id>`); send input via commands
- [x] Multiple terminal instances (new terminal) and lifecycle cleanup (close on tab/panel close)
- [x] Honor `shellPath` (`resolve_shell`: explicit → `$SHELL` → default) and cwd = workspace root; full `terminalCwdBehavior` setting wired in **M10**
- [x] **Tests**
  - [x] Rust: PTY spawns and streams command output (`pty_streams_command_output`) + `resolve_shell` unit tests
  - [x] Frontend: terminal store (create/close/rename/active) and TerminalPanel tabs (mocked view)
  - [~] xterm↔PTY rendering + resize verified via `tauri dev` smoke (not unit-testable in jsdom)

### M6 — PDF.js viewer

- [x] Lazy-load PDF.js (`pdfjs-dist`) viewer component (own chunk; worker chunked separately)
- [x] Render PDF from a workspace file path (page navigation, zoom in/out, fit width)
- [x] Support Cmd/Ctrl-wheel and trackpad pinch zoom in the PDF viewer
- [x] Render PDF.js text layer for text selection/copy when the PDF contains embedded text
- [x] Editor-tab preview (open a `.pdf` from the explorer → renders as a normal tab)
- [x] **Tests**
  - [x] Frontend: preview store (open/close/remember view state) + zoom/page helpers (14 tests)
  - [~] Viewer canvas rendering + page-count verified via `tauri dev` smoke (pdf.js needs a real worker/canvas)

### M7 — Syntax highlighting + themes

- [x] Use Monaco built-in grammars for supported languages
- [x] Custom Monarch grammars for the ones Monaco lacks (Julia, LaTeX, TOML) — `monacoLanguages.ts` (Tree-sitter deferred; Monarch is sufficient for v1)
- [x] Cover languages: Julia, Python, C#, C/C++, Rust, JavaScript/TypeScript, Markdown, LaTeX, JSON/YAML/TOML, Bash (via `languageForPath` + builtin/Monarch)
- [x] Themes via CSS variables + Monaco theme: dark (VS Code-like default), light, and high contrast (`themeStore`; persisted ids: `dark`, `light`, `hc`)
- [x] Live theme switching via command palette ("Cycle Color Theme" / "Color Theme: …"); `theme` setting persistence in **M10**
- [x] **Tests**
  - [x] Frontend: language detected from file extension maps to correct grammar (incl. julia/latex/toml)
  - [~] Julia/LaTeX tokenization verified via `tauri dev` smoke (Monarch needs the Monaco runtime)
  - [x] Frontend: switching theme updates the applied `data-theme` + Monaco theme (themeStore tests)

### M8 — Julia run-file and run-selection workflow

- [x] Run current file via Julia (Cmd/Ctrl+Enter → `editor.run`) — `juliaPath` defaults to `julia`; setting wiring in M10
- [x] Run selected code in the active editor (selection → `julia -e <code>`)
- [x] Tab-bar Run button for active `.jl` files dispatches the same run-file/run-selection path
- [x] Stream Julia process stdout/stderr to the bottom panel Output tab (`julia:output:<id>` events)
- [x] Handle run errors and non-zero exit codes in the UI (exit code + spawn errors shown)
- [x] **Tests**
  - [x] Rust: `resolve_julia` + `julia_args` (run-vs-file argument logic); real execution smoke-tested
  - [x] Frontend: `runInvocation` chooses selection vs file correctly; outputStore append/clear/running
  - [~] Cmd/Ctrl+Enter → editor.run → runActiveJulia path verified via `tauri dev` smoke

### M9 — Generic LSP client + Julia LanguageServer.jl

- [x] Generic JSON-RPC LSP client in `src/lsp/` (`jsonRpc.ts` — id correlation, notifications, dispose)
- [x] Rust backend spawns language servers over stdio and bridges messages via commands/events (`lsp.rs`: framing + lsp_start/lsp_send/lsp_stop)
- [x] Wire Julia LanguageServer.jl as the first server (`servers.ts` config; started on first `.jl` open)
- [x] Editor integration: go to definition (F12 / Cmd/Ctrl+Click), find references (Shift+F12), hover, completion, diagnostics (`monacoLsp.ts` providers + markers)
- [x] Server lifecycle (start → initialize/initialized → didOpen/didChange → stop) and per-language config (`lspClient.ts`); status in the status bar
- [x] Extension points for Python (pyright) and C# (csharp-ls) — config entries already present
- [x] **Tests**
  - [x] Frontend: JSON-RPC client frames/correlates requests/responses/notifications (8 tests); protocol URI/initialize helpers (4); server selectors (5); LSP status store
  - [x] Rust: `encode_message` + `LspDecoder` framing across split/multiple chunks (6 cargo tests)
  - [~] Live definition/references/hover/diagnostics with a real server need `LanguageServer.jl` installed (multi-minute precompile) — verified by smoke; Monaco mapping is wired in `monacoLsp.ts`

### M10 — Settings persistence + workspace restore

- [x] Settings store (Zustand) backed by JSON in the OS app-config dir via Tauri (`app_config_path` + `write_file` create-dirs)
- [x] All settings keys implemented with defaults + validation (`settingsStore`); applied: theme, font family/size/lineHeight/ligatures, minimap, lineNumbers, wordWrap, tabSize → Monaco; juliaPath → run + LSP; shellPath + terminalCwdBehavior → terminal
- [x] Keybinding persistence (the M4-deferred item): user `keybindings.json` loaded + merged over defaults (`keymapStore`)
- [x] Settings editing via the `settings.json` file ("Open Settings (JSON)" command); a dedicated GUI settings panel is deferred (file-based, like VS Code)
- [x] Workspace restore honoring `restoreWorkspaceOnStartup` (reopens the last folder); tab/layout restore is a future enhancement
- [x] **Tests**
  - [x] Rust: `write_file` creates missing parent dirs (config writes); `app_config_path` registered
  - [x] Frontend: `mergeSettings` defaults/validation/clamping (6); `parseUserKeybindings` + keymap merge; `resolveTerminalCwd` (5)
  - [~] Live load/restore round-trip verified via `tauri dev` smoke (needs the Tauri config dir)

### M11 — Markdown/LaTeX build-and-preview workflow

- [x] Markdown preview (Cmd/Ctrl+Shift+V → "Open Preview") rendered live from editor content (`MarkdownView`, lazy markdown-it, HTML escaped)
- [x] LaTeX Preview tab action / Build LaTeX command saves and compiles the active `.tex` file using `latexBuildCommand` retargeted to that file
- [x] Open resulting PDF as an editor tab on success (`deriveOutputPdf` derives the output name)
- [x] Surface build output/errors in the bottom-panel Output tab (stdout/stderr + exit code)
- [x] **Tests**
  - [x] Frontend: `renderMarkdown` (heading/strong/HTML-escaping), `deriveOutputPdf` (5), `MarkdownView` render + empty state
  - [x] Rust: `run_build` shares the unit-tested process-streaming path (resolve/args covered)
  - [~] Live latexmk build + open-pdf verified via `tauri dev` smoke (needs a TeX toolchain installed)

### M12 — Performance pass + packaging

- [x] Verify lazy-loading of Monaco, PDF.js, terminal, markdown (separate chunks; main bundle ~72 kB gzip)
- [x] No background indexing, no extension marketplace, no Electron (native WebView via Tauri) — by design
- [x] Measure bundle size; `chunkSizeWarningLimit` raised to acknowledge the intentional lazy editor chunks
- [x] Produce a packaged Tauri release build (`npm run tauri build` → unsigned `.app`/`.dmg`; signing/notarization documented as post-v1)
- [x] Docs/tracker finalized across M0–M12
- [x] **Tests**
  - [x] `src/perf.test.ts` asserts Monaco/terminal/PDF/Markdown stay behind `React.lazy(() => import(...))`
  - [x] Full Vitest + `cargo test` green; production `vite build` + release `tauri build` succeed
  - [~] Packaged-build launch verified via the `tauri dev` boot smoke (packaged `.app` smoke is manual)

---

## Definition of Done

A feature or milestone is DONE only when ALL of the following hold:

- [x] **Compiles** — `cargo build` and the Vite/TypeScript build succeed with no errors
- [x] **Runs** — the Tauri app launches and the feature is reachable in the running app
- [x] **Tests pass** — Vitest + React Testing Library and `cargo test` are green (every feature ships with tests)
- [x] **No known bugs** — no open known defects for the delivered scope (no-bug policy)
- [x] **Docs updated** — ARCHITECTURE.md, ROADMAP.md, KEYBINDINGS.md, SETTINGS_SCHEMA.md, RISKS.md, and this TRACKER.md reflect the change
