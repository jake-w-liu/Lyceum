# Lyceum Roadmap

Lyceum is a lightweight, VS Code-inspired **research IDE** built with Tauri, with a Julia-first workflow.
This is **not** a 1:1 VS Code clone: it is a focused editor with a VS Code-like layout, common
keybindings, code editing, terminal integration, syntax highlighting, PDF preview, and a Julia-first
workflow. Only original code and permissive open-source dependencies are used; no VS Code source is copied.

This roadmap defines milestones **M0..M12**. Each milestone lists its goal, concrete scope, acceptance
criteria ("done when..."), and the tests that must pass.

## Canonical tech decisions (single source of truth)

Every milestone below is constrained by these decisions. No milestone may introduce a conflicting choice.

- **Backend:** Tauri v2, Rust (edition 2021).
- **Frontend:** React 19 + TypeScript, built with Vite.
- **Editor:** Monaco Editor (`@monaco-editor/react` or `monaco-editor` directly), lazy-loaded.
- **Terminal:** xterm.js in the frontend; real PTY in the Rust backend via the `portable-pty` crate.
  Terminal output is streamed frontend<->backend over Tauri events; input is sent via Tauri commands.
- **PDF preview:** PDF.js (`pdfjs-dist`), lazy-loaded.
- **Syntax highlighting:** Monaco built-in grammars first; Tree-sitter **only** if a language is
  missing/weak (e.g. Julia, LaTeX).
- **State management:** Zustand (small, simple stores). No Redux.
- **Styling:** plain CSS with CSS custom properties (CSS variables) for theming. No heavy UI framework.
- **LSP:** a generic JSON-RPC LSP client. The Rust backend spawns language servers over stdio and bridges
  messages to the frontend via Tauri commands/events. Order: Julia LanguageServer.jl first, then Python
  (pyright), then C# (csharp-ls or OmniSharp).
- **Command system:** a TS command registry — every action is a command. A keybinding registry maps
  shortcuts to command ids. Keybindings persisted as JSON. Settings persisted as JSON in the OS
  app-config dir via Tauri.
- **Testing:** Vitest + React Testing Library for the frontend; `cargo test` for Rust.
- **Performance:** lazy-load Monaco, PDF.js/image previews, terminal, and LSP servers. No extension marketplace,
  no Electron, no background indexing in v1.

## No-bug policy and the compile-and-run rule

- **No-bug policy:** every feature ships with tests. A milestone is not complete until its tests pass.
- **Compile-and-run rule (applies to EVERY milestone):** at the end of each milestone the project MUST
  compile and run. Concretely, `cargo build` and the Rust test suite succeed, the frontend type-checks
  and builds with Vite, the Vitest suite passes, and `tauri dev` launches the app without runtime errors.
  No milestone may be marked done if it leaves the tree in a broken state.

## Current status

**M0–M1 are being implemented first.** M0 stands up the Tauri + React + TypeScript project, and M1 builds
the shell layout (activity bar, sidebar, editor area, bottom panel, status bar). Later milestones are
planned but not yet started. This roadmap is the agreed plan of record.

---

## M0 — Create Tauri + React + TypeScript project

**Goal:** A running Tauri v2 application skeleton with a React 19 + TypeScript frontend built by Vite.

**Scope:**
- Initialize the canonical repository structure: `src/` (frontend), `src-tauri/` (Rust backend),
  `public/`, plus `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `TRACKER.md`, `README.md`.
- Scaffold `src/main.tsx` and `src/App.tsx`; create the `src-tauri/` crate (`Cargo.toml`,
  `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`).
- Configure Tauri v2 with Rust edition 2021; wire Vite as the frontend build/dev server.
- Add Vitest + React Testing Library and a `cargo test` harness; add the project-wide CSS file
  (`src/styles/global.css`) with theme CSS variables placeholder.
- Add npm/cargo scripts for dev, build, type-check, and test.

**Done when:**
- `tauri dev` launches a window rendering the React app.
- `cargo build` and the Vite production build (`vite build`) both succeed.
- `tsc --noEmit` type-checks clean.
- The test harnesses run (an example test passes on each side).

**Tests that must pass:**
- Vitest: a smoke test renders `<App />` without crashing.
- Rust: a `cargo test` smoke test (e.g. a trivial backend unit test) passes.

---

## M1 — Shell layout

**Goal:** The static VS Code-like shell: activity bar, sidebar, editor area, bottom panel, status bar.

**Scope:**
- Build `components/ActivityBar.tsx`, `Sidebar.tsx`, `EditorArea.tsx`, `BottomPanel.tsx`, `StatusBar.tsx`.
- Create `state/layoutStore.ts` (Zustand) holding visibility/size state for the sidebar, bottom panel,
  and active activity-bar item.
- Implement toggling/collapse behavior in the store (sidebar visible, bottom panel visible, etc.),
  exposed as plain actions for later command wiring.
- Lay out the regions with CSS using theme CSS variables; no heavy UI framework.

**Done when:**
- The app shows all five regions in the correct layout.
- Toggling sidebar and bottom panel visibility via the layout store updates the rendered UI.
- Resizing the sidebar/bottom panel persists in-session through the store.

**Tests that must pass:**
- Vitest: the layout store toggles sidebar/bottom-panel visibility correctly.
- Vitest (RTL): the shell renders activity bar, sidebar, editor area, bottom panel, and status bar.

---

## M2 — File explorer + open-folder workflow

**Goal:** Open a folder and browse its file tree in the sidebar.

**Scope:**
- Rust backend commands to pick/open a folder and read directory contents (lazy, per-expanded node).
- TS IPC wrappers in `lib/` for directory listing and the open-folder dialog.
- A file-explorer tree component in the sidebar with expand/collapse, file/folder icons, selection, modifier multi-select, and undoable delete.
- Zustand store for the workspace root and expanded-node state.

**Done when:**
- Choosing a folder shows its tree in the sidebar.
- Expanding a directory lazily lists its children; selecting a file emits an open intent.
- Cmd/Ctrl-click toggles selected rows; Shift-click selects visible ranges;
  toolbar create targets the selected folder or selected file's parent;
  drag-and-drop moves selected files/folders into another folder; Explorer
  deletes move files to a workspace-local trash that supports undo/redo.
- No background indexing occurs (directories read on demand only).

**Tests that must pass:**
- Rust: directory-listing command returns correct entries and handles missing/permission-denied paths.
- Vitest: the explorer renders a mocked tree and emits an open event on file click.

---

## M3 — Monaco editor with tabs + save/open

**Goal:** Edit files in a lazy-loaded Monaco editor with a tab bar, open and save.

**Scope:**
- Lazy-load Monaco into `EditorArea.tsx`; mount a model per open file.
- Rust commands to read and write file contents; TS IPC wrappers in `lib/`.
- Tab bar with active/dirty indicators; an editor/tabs Zustand store (open docs, active tab, dirty state).
- Wire open (from explorer) and save (`Cmd/Ctrl+S`) and close tab (`Cmd/Ctrl+W`) flows.

**Done when:**
- Selecting a file opens it in a Monaco tab; edits mark the tab dirty.
- Save writes the file and clears the dirty flag.
- Multiple tabs can be open; closing a tab works.

**Tests that must pass:**
- Rust: read/write file commands round-trip content correctly and report errors.
- Vitest: the editor/tabs store opens, marks dirty, saves (clears dirty), and closes tabs.

---

## M4 — Command registry + keybinding registry

**Goal:** Every action is a command, reachable via the command palette and keybindings.

**Scope:**
- `commands/` TS command registry (register, lookup, execute by id) plus built-in commands wrapping
  existing actions (toggle sidebar, toggle panel, save, close tab, etc.).
- `keybindings/` keybinding registry mapping shortcuts to command ids, with a default keymap JSON.
- Command palette (`Cmd/Ctrl+Shift+P`) and quick open (`Cmd/Ctrl+P`) UI; `Esc` closes them.
- Wire the required keybindings (platform-aware: Cmd on macOS / Ctrl on Win/Linux):
  - `Cmd/Ctrl+P` quick open; `Cmd/Ctrl+Shift+P` command palette.
  - `Cmd/Ctrl+B` toggle sidebar; `Cmd/Ctrl+J` toggle bottom panel.
  - `Cmd/Ctrl+S` save; `Cmd/Ctrl+W` close tab; `Cmd/Ctrl+Tab` next tab; `Cmd/Ctrl+Shift+Tab` previous tab.
  - `Cmd/Ctrl+F` find in file; `Cmd/Ctrl+Shift+F` search workspace; `Cmd/Ctrl+G` go to line.
  - `Cmd/Ctrl+/` toggle line comment; `Alt/Option+Up/Down` move line;
    `Shift+Alt/Option+Up/Down` duplicate line.
  - `Esc` closes command palette / quick open / find box / modal panel.
  - (Terminal, run, preview, and LSP bindings land with their feature milestones: `Ctrl+`` and
    `Ctrl+Shift+`` in M5; `Cmd/Ctrl+Enter` in M8; `Cmd/Ctrl+Shift+V` in M6/M11; `F12`,
    `Shift+F12`, `Cmd/Ctrl+Click` in M9.)
- Keybindings persisted as JSON (foundation reused by M10).

**Done when:**
- The command palette lists and executes registered commands.
- Quick open switches/opens files.
- The default keymap triggers the right commands; `Esc` dismisses overlays.

**Tests that must pass:**
- Vitest: registry registers/looks up/executes commands; duplicate-id handling is correct.
- Vitest: keybinding registry resolves a key event to the correct command id (platform-aware).
- Vitest (RTL): command palette opens, filters, runs a command, and closes on `Esc`.

---

## M5 — Embedded terminal (xterm.js + real shell via PTY)

**Goal:** A real shell in the bottom panel via a backend PTY.

**Scope:**
- Rust: spawn a real PTY with the `portable-pty` crate; stream output to the frontend over Tauri events;
  accept input via Tauri commands; support resize and termination.
- Frontend: lazy-loaded xterm.js terminal view in the bottom panel; wire input/output to the backend.
- Support multiple terminals; honor `Ctrl+`` (toggle terminal panel) and `Ctrl+Shift+``
  (new terminal).
- Respect `shellPath` and `terminalCwdBehavior` settings (default reasonable behavior until M10 persists them).

**Done when:**
- A terminal launches the configured shell and is fully interactive (input echoes, programs run).
- Output streams live; resizing reflows; closing the terminal kills the PTY.
- Toggle and new-terminal keybindings work.

**Tests that must pass:**
- Rust: PTY spawns, echoes input to output, resizes, and shuts down cleanly.
- Vitest: terminal component mounts xterm.js lazily, renders streamed output, and sends input via the IPC wrapper (backend mocked).

---

## M6 — PDF.js and image viewer

**Goal:** Preview PDF and common browser image files inside the IDE.

**Scope:**
- Lazy-load PDF.js (`pdfjs-dist`); render PDFs to a canvas with page navigation and zoom.
- Open PDFs/images in the right-side preview panel.
- Wire `Cmd/Ctrl+Shift+V` to open preview for the active/selected PDF or image.
- IPC to read preview bytes from disk.

**Done when:**
- Opening a `.pdf` renders the document with working page navigation and zoom.
- Opening a `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.bmp`, `.avif`, `.ico`, or `.svg`
  renders the image without reading it as text.
- `Cmd/Ctrl+Shift+V` opens the preview.

**Tests that must pass:**
- Vitest: the PDF viewer lazy-loads PDF.js and renders a mocked document; navigation updates the page.
- Vitest: image previews read bytes, create typed Blob URLs, and revoke them on cleanup.
- Rust: bytes read command returns file contents and handles missing files.

---

## M7 — Syntax highlighting + themes

**Goal:** Accurate highlighting for the target languages and switchable themes.

**Scope:**
- Use Monaco built-in grammars first for: Python, C#, C/C++, Rust, JavaScript/TypeScript, Markdown,
  JSON/YAML/TOML, Bash. Add Tree-sitter only where Monaco is missing/weak — notably **Julia** and **LaTeX**.
- Implement themes: dark (VS Code-like default), light, and high contrast, driven by CSS variables
  and Monaco theme definitions kept in sync.
- Wire the `theme` setting and editor appearance settings (`fontFamily`, `fontSize`, `lineHeight`,
  `ligatures`, `tabSize`, `wordWrap`, `minimap`, `lineNumbers`).

**Done when:**
- All listed languages highlight correctly, including Julia and LaTeX.
- Switching `theme` updates both the editor and the surrounding UI.
- Editor appearance settings take effect.

**Tests that must pass:**
- Vitest: language detection maps file extensions to the correct grammar/highlighter (incl. Julia, LaTeX).
- Vitest: theme switching updates CSS variables and the active Monaco theme.

---

## M8 — Julia run-file and run-selection workflow

**Goal:** Run the current Julia file or selected code from the editor.

**Scope:**
- Run the active file or the current selection in an integrated terminal/PTY session using the configured
  `juliaPath`.
- Wire `Cmd/Ctrl+Enter` and a tab-bar Run button to "run current file or selected code".
- Surface run output in the terminal panel; sensible behavior when nothing is selected (run whole file).
- Register run commands in the command registry.

**Done when:**
- `Cmd/Ctrl+Enter` or the Run button with no selection runs the whole file; with
  a selection runs the selection.
- Output appears in the terminal; `juliaPath` is respected.

**Tests that must pass:**
- Vitest: run command selects file-vs-selection correctly and builds the right invocation (backend mocked).
- Rust: the run/exec command launches the process with the expected arguments and streams output.

---

## M9 — Generic LSP client + Julia LanguageServer.jl

**Goal:** A generic JSON-RPC LSP client, first wired to Julia LanguageServer.jl.

**Scope:**
- Rust: spawn language servers over stdio and bridge JSON-RPC messages to the frontend via Tauri
  commands/events (generic — not Julia-specific).
- TS LSP client in `lib/`: initialize handshake, document sync, and core features (diagnostics,
  hover, completion, go-to-definition, find-references).
- Integrate Julia LanguageServer.jl first (Python pyright and C# csharp-ls/OmniSharp are deferred but
  must drop in without protocol changes).
- Wire `F12` go to definition, `Shift+F12` find references, and `Cmd/Ctrl+Click` go to definition.

**Done when:**
- The generic client completes the LSP handshake and syncs documents.
- Julia LanguageServer.jl provides diagnostics, hover, completion, definition, and references.
- `F12`, `Shift+F12`, and `Cmd/Ctrl+Click` navigate correctly.

**Tests that must pass:**
- Rust: the stdio JSON-RPC bridge frames/parses messages and round-trips a request/response.
- Vitest: the LSP client performs initialize, sends document-sync notifications, and dispatches
  diagnostics/hover/definition responses (server mocked).

---

## M10 — Settings persistence + workspace restore

**Goal:** Persist settings and keybindings as JSON; restore the workspace on startup.

**Scope:**
- Persist settings JSON in the OS app-config dir via Tauri; load on startup with sensible defaults.
- Persist the keybinding map as JSON (built on M4's registry).
- Implement all settings keys: `theme`, `fontFamily`, `fontSize`, `lineHeight`, `ligatures`, `tabSize`,
  `wordWrap`, `shellPath`, `terminalCwdBehavior` (`workspaceRoot|currentFileDir`), `juliaPath`,
  `latexBuildCommand` (e.g. `latexmk -pdf main.tex`), `restoreWorkspaceOnStartup`, `minimap`,
  `lineNumbers`.
- Restore the last opened folder on startup when `restoreWorkspaceOnStartup` is on.

**Done when:**
- Settings and keybindings persist across restarts and reload correctly with defaults for missing keys.
- With `restoreWorkspaceOnStartup` enabled, the previous folder is restored.
- Changing any setting takes effect and survives a restart.

**Tests that must pass:**
- Rust: settings/keybindings read/write to the app-config dir round-trip; defaults applied for missing keys.
- Vitest: the settings store loads/saves all keys and applies defaults; workspace-restore reconstructs
  the last folder from persisted state.

---

## M11 — Markdown/HTML/LaTeX preview workflow

**Goal:** Preview Markdown/HTML documents and build/preview LaTeX outputs.

**Scope:**
- Markdown: live rendered preview; `Cmd/Ctrl+Shift+V` opens the preview.
- HTML: rendered preview in a sandboxed iframe; `Cmd/Ctrl+Shift+V` opens the preview.
- LaTeX: save and compile the active `.tex` file by retargeting `latexBuildCommand`
  (e.g. `latexmk -pdf main.tex`) to that file; Compile writes the resulting PDF
  beside the source, and Preview opens that PDF in the M6 PDF.js viewer.
- Surface build output/errors in the terminal/bottom panel.

**Done when:**
- `Cmd/Ctrl+Shift+V` shows a Markdown or HTML preview that updates as the document changes.
- Running the LaTeX compile/preview flow for the active `.tex` file produces a
  PDF; Preview opens it in the PDF viewer, and build errors are visible.

**Tests that must pass:**
- Vitest: Markdown preview renders source to expected output and updates on change.
- Vitest: HTML preview builds a sandboxed iframe document with local asset resolution.
- Vitest: the LaTeX build command retargets `latexBuildCommand` to the active
  `.tex` file and reports the output PDF path.

---

## M12 — Performance pass + packaging

**Goal:** Meet performance constraints and produce distributable builds.

**Scope:**
- Verify and enforce lazy-loading of Monaco, PDF.js/image preview, the terminal, and LSP servers; confirm no
  background indexing and no extension marketplace.
- Profile startup and editor responsiveness; trim bundle size and defer heavy work.
- Configure Tauri packaging for target platforms (macOS / Windows / Linux); produce release artifacts.
- Finalize docs (`README.md`, `TRACKER.md`) and the non-goals (no extension compat, debugger,
  marketplace, remote SSH, notebooks, full Git UI, plugin system, or exact VS Code API compat).

**Done when:**
- Monaco, PDF.js, terminal, and LSP load lazily (verified), and startup meets the agreed budget.
- `tauri build` produces working packaged binaries for the target platforms.
- All prior milestone test suites still pass.

**Tests that must pass:**
- Vitest: assertions that heavy modules (Monaco, PDF.js, terminal, LSP client) are not loaded on
  initial render and load on demand.
- Rust: `cargo test` suite passes; a build smoke check confirms the packaged app launches.
