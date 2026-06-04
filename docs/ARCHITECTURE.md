# Architecture

System architecture for **Lyceum**, a lightweight, VS Code-inspired **research IDE**
built with Tauri (Julia-first workflow). This document is the canonical reference
for component boundaries, the IPC model, the process model, module responsibilities,
and the principal data flows.

> **Hard constraint.** This is **not** a 1:1 VS Code clone. It is a focused editor
> with a VS Code-like layout, common keybindings, code editing, terminal
> integration, syntax highlighting, Markdown/HTML/PDF/image preview, and a
> Julia-first workflow. Only
> original code and permissive open-source dependencies are used; no VS Code source
> is copied.

## Canonical tech stack

| Concern | Decision |
|---|---|
| Backend | Tauri v2, Rust (edition 2021) |
| Runtime | Native OS WebView via Tauri — no Electron, no bundled Chromium |
| Frontend | React 19 + TypeScript, built with Vite |
| Editor | Monaco Editor (`monaco-editor` / `@monaco-editor/react`), lazy-loaded |
| Terminal | `xterm.js` frontend; real PTY in Rust via the `portable-pty` crate |
| Preview | Markdown, sandboxed HTML, PDF.js (`pdfjs-dist`), and raw-byte image previews |
| Syntax highlighting | Monaco built-in grammars first; Tree-sitter only where weak (Julia, LaTeX) |
| State | Zustand (small stores), no Redux |
| Styling | Plain CSS with CSS custom properties for theming, no UI framework |
| LSP | Generic JSON-RPC client; Rust spawns servers over stdio, bridges to frontend |
| Commands | TS command registry + keybinding registry; both persisted as JSON |
| Testing | Vitest + React Testing Library (frontend); `cargo test` (Rust) |

Everything below must remain consistent with this table and with `TRACKER.md`,
`docs/ROADMAP.md`, `docs/KEYBINDINGS.md`, and `docs/SETTINGS_SCHEMA.md`.

---

## 1. High-level component diagram

The application is a single Tauri desktop process hosting one WebView (the React
UI). The Rust **core** owns all privileged I/O: the filesystem, child processes
(PTYs and language servers), and on-disk configuration. The WebView talks to the
core exclusively through Tauri **commands** (request/response) and **events**
(streaming push). No language server, shell, or file handle is ever touched
directly by the WebView.

```
+---------------------------------------------------------------------------------+
|  Tauri Application Process (Rust)                                               |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  |  WebView  (Chromium/WebKit)  -- React 19 + TypeScript (Vite bundle)        |  |
|  |                                                                           |  |
|  |  App.tsx                                                                   |  |
|  |   +- ActivityBar  Sidebar  EditorArea(Monaco)  BottomPanel(xterm)  Status |  |
|  |   +- Preview surfaces (inline source previews + PDF/image viewer tabs)    |  |
|  |                                                                           |  |
|  |  Zustand stores  |  Command registry  |  Keybinding registry              |  |
|  |  src/lib: ipc.ts (invoke wrappers), events.ts (listen), lspClient.ts      |  |
|  +-------------------------------^-------------------------+-----------------+  |
|                                  |                         |                    |
|              invoke(cmd, args)   |  commands               |  events  emit()    |
|              (request/response)  |                         |  (stream push)     |
|                                  v                         v                    |
|  +---------------------------------------------------------------------------+  |
|  |  Rust core  (src-tauri/src)                                               |  |
|  |                                                                           |  |
|  |   file_ops  fs_ops  search  walk  terminal  julia  lsp  menu  app_info    |  |
|  |   state: managed Mutex registries for PTYs, runs, and LSP sessions        |  |
|  +----+-----------------+-------------------------+------------------+-------+  |
|       | std::fs         | portable-pty            | tokio::process   |          |
|       v                 v                         v                  v          |
|   Workspace files   PTY child procs           LSP child procs    Tauri path    |
|   (read/write)      (shell: zsh/bash/pwsh)    (LanguageServer.jl, app-config   |
|                                                pyright, csharp-ls) dir (JSON)   |
+---------------------------------------------------------------------------------+
```

There is exactly **one** WebView. Heavy subsystems (Monaco, PDF.js, xterm, LSP
sessions) are lazy-loaded so a cold start renders the shell layout without paying
their cost.

---

## 2. IPC model: commands vs events

Tauri offers two complementary IPC primitives. Lyceum uses each for a distinct role.

### 2.1 Commands (request/response)

- **Direction:** frontend -> backend, with a typed return value (or error).
- **Mechanism:** `@tauri-apps/api/core` `invoke(name, args)` on the frontend;
  `#[tauri::command]` async functions on the backend.
- **Use when** the frontend needs a result or an acknowledgement: read/write a
  file, list a directory, start/stop a terminal, send a keystroke to a PTY, send a
  JSON-RPC message to a language server, load/save settings, get app info.
- **Errors** are returned as `Result<T, E>` where `E: serde::Serialize`; the JS
  promise rejects, and `src/lib/ipc.ts` normalizes the error.

All commands are funneled through thin typed wrappers in `src/lib/ipc.ts` so that
command names and payload types live in exactly one place (matching the existing
`getAppInfo()` wrapper that calls the `get_app_info` command). The wrappers also
degrade gracefully when running outside a Tauri WebView (plain `vite` dev server or
Vitest), returning safe fallbacks.

### 2.2 Events (streaming push)

- **Direction:** backend -> frontend (primarily), one-to-many, fire-and-forget.
- **Mechanism:** backend `app_handle.emit(...)` / `Channel`; frontend
  `@tauri-apps/api/event` `listen(name, handler)`.
- **Use when** data arrives asynchronously and continuously, with no single reply:
  PTY stdout/stderr chunks, PTY exit, LSP notifications/responses (diagnostics,
  log messages), long-running Julia run output, file-watcher change notifications.
- **Channel naming** is scoped by subsystem and instance id, e.g.
  `terminal:data:<terminalId>`, `terminal:exit:<terminalId>`,
  `lsp:message:<sessionId>`. Per-instance channels let the frontend route a
  stream to exactly the component that owns it.

### 2.3 Rule of thumb

> If the frontend wants **a value back once**, use a **command**. If the backend
> needs to **keep pushing data over time**, use an **event**. Input always travels
> frontend -> backend as a command; bulk/continuous output travels
> backend -> frontend as events.

---

## 3. Process model

| Process | Owner | Lifetime | Notes |
|---|---|---|---|
| Main app + WebView | Tauri/OS | App lifetime | Single window (`main`), single WebView hosting React. |
| PTY child processes | `terminal` module via `portable-pty` | Per terminal tab | One child shell per terminal; killed on close/app exit. |
| LSP child processes | `lsp` module via `tokio::process` | Per language/workspace | One server per active language; reused across files. |
| Build/run child processes | `julia` module | Per run invocation | Transient: `julia file.jl`, `latexmk`, etc.; streamed then reaped. |

The Rust core holds long-lived child handles in an `AppState` registry
(`Arc<Mutex<...>>` maps keyed by terminal id / session id) managed via Tauri's
`State`. The WebView never holds an OS handle; it holds only opaque string ids.
All child processes are terminated on window close to avoid orphans.

---

## 4. Frontend module breakdown (`src/`)

```
src/
  main.tsx              React bootstrap; mounts <App/>, imports global styles.
  App.tsx               Top-level layout composition + global keybinding wiring.
  components/
    ActivityBar.tsx     Left icon rail; switches sidebar views; emits commands.
    Sidebar.tsx         File explorer / search container (open-folder workflow).
    EditorArea.tsx      Tab strip + lazy-mounted Monaco editor host.
    BottomPanel.tsx     Terminal + problems/output container (xterm host).
    StatusBar.tsx       Cursor position, language, LSP status, run status.
    PdfPanel.tsx        Legacy/auxiliary right-side preview panel.
    HtmlPreview.tsx     Sandboxed inline rendered preview for HTML sources.
    Icon.tsx            Inline SVG icon set (original artwork).
    Resizer.tsx         Drag-to-resize splitters for panels.
  state/
    layoutStore.ts      Panel visibility/sizes, active view, focus (Zustand).
    editorStore.ts      Open documents, dirty flags, active tab, selections.
    terminalStore.ts    Terminal instances and their ids/titles.
    settingsStore.ts    Loaded settings; applies to UI + Monaco/terminal.
    lspStore.ts         Per-session status and last-known diagnostics.
  commands/
    commandRegistry.ts  Command registry (register/execute/list).
    builtinCommands.ts  Built-in workbench commands.
  keybindings/
    keybindingRegistry.ts Keybinding registry + default shortcuts.
  lib/
    ipc.ts              Typed invoke() wrappers (already present: getAppInfo).
    events.ts           Typed listen() helpers and channel-name constants.
    lspClient.ts        Generic JSON-RPC LSP client bridged over IPC.
    monaco.ts           Lazy Monaco loader + theme/grammar registration.
    pdf.ts              Lazy PDF.js loader + worker setup.
    terminal.ts         xterm bootstrap + PTY wiring helpers.
  hooks/
    useLayoutKeybindings.ts   Binds global keymap to commands at the App level.
  styles/
    global.css          Resets, layout primitives, component styles.
    theme.css           CSS custom properties for the four themes.
  test/setup.ts         Vitest + Testing Library setup.
```

**Responsibility notes**

- **Stores are the single source of UI truth.** Components subscribe to Zustand;
  commands mutate stores; IPC results feed stores. Components do not call IPC
  directly except through `lib/` wrappers.
- **`src/lib/` is the only place that imports `@tauri-apps/api`.** This keeps the
  Tauri surface mockable in tests and centralized for the security review.

---

## 5. Backend module breakdown (`src-tauri/`)

```
src-tauri/
  Cargo.toml            Crate manifest (edition 2021).
  build.rs              tauri-build codegen.
  tauri.conf.json       Window config, bundle, security CSP.
  capabilities/
    default.json        Capability set granted to the `main` window (allowlist).
  src/
    main.rs             Binary entry; calls lyceum_lib::run().
    lib.rs              Builder: plugins, AppState, invoke_handler (command list).
    app_info.rs         get_app_info data.
    file_ops.rs         read_file, write_file, read_file_bytes, app_config_path.
    fs_ops.rs           Explorer file operations (read/create/rename/delete,
                        undoable workspace-local trash restore/redo).
    search.rs           Workspace text search.
    walk.rs             Quick-open workspace file listing.
    terminal.rs         PTY manager + terminal_create/write/resize/close.
    julia.rs            Julia/build process manager + run/cancel commands.
    lsp.rs              LSP process manager + JSON-RPC framing/bridge.
    menu.rs             Native app menu mapped to frontend command ids.
```

**Responsibility notes**

- `lib.rs` registers every command in a single `invoke_handler!` and constructs
  `AppState` once via `.manage(...)`.
- `terminal.rs`, `julia.rs`, and `lsp.rs` own the OS resources and the
  threads/tasks that read their output.
- `file_ops.rs::app_config_path` is the single backend entry point for resolving
  app-config file locations.

---

## 6. Command registry + keybinding registry

The command system is the spine of the UI: **every action is a command**, and
keybindings only ever resolve to command ids (never to inline handlers).

### 6.1 Command registry (`src/commands/commandRegistry.ts`)

```ts
interface Command {
  id: string;                 // stable, namespaced e.g. "file.save"
  title: string;              // shown in the command palette
  category?: string;          // grouping label
  when?: () => boolean;       // optional enablement predicate (focus/context)
  run: (args?: unknown) => void | Promise<void>;
}
```

- A singleton `CommandRegistry` exposes `register`, `execute(id, args)`,
  `getAll()` (for the palette), and `isEnabled(id)`.
- Built-in commands are registered in `commands/builtinCommands.ts` with stable
  ids grouped by prefix (`file.*`, `workbench.*`, `terminal.*`, `editor.*`,
  `preview.*`, `latex.*`, `julia.*`).
- The **command palette** (`Cmd/Ctrl+Shift+P`) is just a filtered list over
  `getAll()`; **quick open** (`Cmd/Ctrl+P`) is a file-name picker that ultimately
  executes `file.open`.

### 6.2 Keybinding registry (`src/keybindings/keybindingRegistry.ts`)

- Maps a normalized shortcut (e.g. `mod+shift+p`) to a command id.
- `DEFAULT_KEYMAP` lives in `keybindingRegistry.ts`; `keymapStore.ts` overlays
  user keybindings loaded from `keybindings.json` (see §12). On macOS `mod` is
  `Cmd`; on Windows/Linux it is `Ctrl`.
- A single keydown listener (installed by `useCommandKeybindings.ts`) matches the
  active shortcut, checks the command's `when` expression, and calls
  `commandRegistry.execute(id)`; `Esc` dismisses the active overlay through the
  `workbench.dismiss` command. Monaco's own keybindings handle
  in-editor edits (move/duplicate line, comment toggle, find, go-to-line) so they
  are not intercepted twice.

The full default keymap, including all required shortcuts, is documented in
`docs/KEYBINDINGS.md`.

---

## 7. Generic LSP client layer

The LSP layer is **language-agnostic**. The backend speaks JSON-RPC over a child
process's stdio; the frontend speaks LSP semantics. Server order per the roadmap:
**Julia LanguageServer.jl first**, then Python (**pyright**), then C#
(**csharp-ls** / **OmniSharp**).

### 7.1 Backend (`src-tauri/src/lsp.rs`)

- A server is launched with `std::process::Command` over **stdio**
  (e.g. Julia: `julia --project=... -e 'using LanguageServer; ...'`).
- The session implements the LSP **base protocol** framing on the child's stdout:
  read `Content-Length: N\r\n\r\n` headers, then exactly `N` bytes of JSON.
- A reader task parses each message and **forwards it verbatim** to the frontend as
  an event on `lsp:message:<sessionId>`. The backend does **not** interpret LSP
  semantics; it only frames/deframes and routes.
- Commands:
  - `lsp_start(language, rootUri) -> sessionId`
  - `lsp_send(sessionId, json)` (writes a framed JSON-RPC message to stdin)
  - `lsp_stop(sessionId)` (graceful `shutdown`/`exit`, then kill if needed)

### 7.2 Frontend (`src/lib/lspClient.ts`)

- Implements the JSON-RPC client semantics: monotonic request ids, a pending-
  request map resolving promises on matching responses, and a notification
  dispatcher for server-initiated messages.
- Drives the **lifecycle**: `initialize` -> `initialized` -> document sync
  (`didOpen`/`didChange`/`didSave`/`didClose`) -> feature requests
  (definition, references, hover, completion) -> `shutdown`/`exit`.
- Bridges to Monaco: registers providers (definition, references, hover,
  completion) per language and applies `textDocument/publishDiagnostics` as Monaco
  markers (see §13.3). `lspStore.ts` tracks per-session status for the status bar.

This satisfies `F12` (go to definition), `Shift+F12` (find references), and
`Cmd/Ctrl+Click` go-to-definition by routing those Monaco actions to LSP requests.

---

## 8. Terminal architecture

- **Frontend:** `xterm.js` renders each terminal; instances are tracked in
  `terminalStore.ts`. `BottomPanel.tsx` hosts the active terminal; the addon
  `xterm-addon-fit` keeps the grid sized to the panel.
- **Backend:** `terminal.rs` uses the **`portable-pty`** crate to spawn a real shell
  (`shellPath` setting, defaulting to the platform shell) in a PTY. A dedicated
  reader thread streams child output to the frontend.
- **Streaming:** PTY output is emitted as events on `terminal:data:<id>`; the
  child exit is signaled on `terminal:exit:<id>`. **Input** (keystrokes, paste)
  is sent frontend -> backend with the `terminal_write(id, data)` command;
  resizing uses `terminal_resize(id, cols, rows)`.
- **Multiple terminals:** each terminal has a unique id; the backend keeps a map
  `id -> PtyHandle` in `AppState`. Creating, switching, and closing terminals is
  command-driven (`Ctrl+\`` toggles the panel; `Ctrl+Shift+\`` creates a
  new terminal; `Cmd/Ctrl+J` toggles the bottom panel).
- **Working directory** follows the `terminalCwdBehavior` setting
  (`workspaceRoot` or `currentFileDir`).

---

## 9. Editor / Monaco integration

- **Lazy load.** Monaco is dynamically imported the first time an editor tab opens
  (`src/lib/monaco.ts`), keeping it out of the initial bundle. Vite is configured
  so Monaco workers are emitted correctly.
- **Models and tabs.** Each open document is a Monaco `ITextModel`; tabs in
  `EditorArea.tsx` map to models tracked in `editorStore.ts` (path, dirty flag,
  view state). Switching tabs swaps the model and restores the saved view state.
- **Highlighting.** Monaco's **built-in** grammars cover Python, C#, C/C++, Rust,
  JS/TS, Markdown, JSON/YAML/TOML, and Bash. **Tree-sitter** is used only where
  Monaco is weak/missing — notably **Julia** and **LaTeX** — registered as custom
  tokenizers/providers. This matches the "built-in first" rule.
- **Editor keybindings.** Native Monaco actions provide find (`Cmd/Ctrl+F`),
  go-to-line (`Cmd/Ctrl+G`), toggle comment (`Cmd/Ctrl+/`), move line
  (`Alt/Option+Up/Down`), and duplicate line (`Shift+Alt/Option+Up/Down`).
- **Theme.** The Monaco theme is derived from the active app theme (§10) so editor
  colors and chrome stay in sync.

---

## 10. Preview integration

- **Markdown/HTML:** Markdown renders in place with `MarkdownView.tsx`; HTML
  renders in place with `HtmlPreview.tsx` inside a sandboxed iframe. Scripts are
  allowed for ordinary HTML demos, but `allow-same-origin` is intentionally
  omitted so previewed project HTML does not gain app/WebView privileges.
- **PDFs:** PDF.js (`pdfjs-dist`) is **lazy-loaded** via `PdfViewer.tsx`, with
  the worker (`pdf.worker`) configured for Vite bundling. The viewer renders a
  canvas page plus PDF.js's text layer, so text can be selected/copied when the
  source PDF contains embedded text. Zoom is available from the toolbar,
  Cmd/Ctrl-wheel, and WebKit trackpad pinch gestures.
- **Images:** `ImageViewer.tsx` is lazy-loaded and reads common browser image
  formats (`png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp`, `avif`, `ico`, `svg`) as
  raw bytes, then
  displays them through a Blob URL that is revoked on path changes/unmount.
- **Source bytes:** the backend reads preview files via `read_file_bytes` and
  returns bytes/`ArrayBuffer`. PDF.js renders pages to `<canvas>`; images render
  through `<img>`. Reading via a command keeps file access on the privileged side
  rather than granting broad asset access.
- **Placement:** Markdown and HTML previews render inline over the active editor;
  PDF and image files open as normal editor tabs backed by `PdfViewer.tsx` and
  `ImageViewer.tsx`. `Cmd/Ctrl+Shift+V` toggles rendered preview for supported
  text documents; clicking a PDF/image in the explorer routes directly to a
  viewer tab.
- **LaTeX compile/preview:** active `.tex` editor tabs expose Compile and
  Preview actions. Both save the buffer, retarget `latexBuildCommand` to that
  file's basename, run the command in the file's directory, and stream build
  output to the Output panel. With the stock command unchanged, the Rust builder
  discovers installed TeX tools using the same augmented PATH used for child
  processes, deletes stale PDFs, and spawns the selected compiler directly
  without a shell. Custom `latexBuildCommand` values still run through the OS
  shell because they are user-authored shell commands. Compile leaves the source
  tab active after writing the PDF; Preview opens the generated PDF as a viewer
  tab.

---

## 11. Theming (CSS variables)

- All themeable colors are **CSS custom properties** declared on a root scope in
  `src/styles/theme.css`; components reference `var(--...)` only (no hard-coded
  colors). No heavy UI framework is used.
- Three themes ship: **dark** (the VS Code-like default), **light**, and
  **high contrast** (`hc`). The active theme is applied by setting a
  `data-theme` attribute on the document root, swapping the variable set.
- The `theme` setting (default `dark`) is the single switch; it drives both
  the app chrome (CSS variables) and the derived Monaco theme so the two never
  diverge.

---

## 12. Settings & keybinding persistence

The **Rust backend owns** reading and writing all config files; the frontend goes
through `app_config_path`, `read_file`, and `write_file`. Locations resolve via
the **Tauri path API** (`app.path().app_config_dir()`), centralized in
`file_ops.rs`.

| File | Location | Owner | Contents |
|---|---|---|---|
| `settings.json` | app-config dir | `settingsPersistence.ts` via `file_ops.rs` | All persisted settings keys (below). |
| `keybindings.json` | app-config dir | `settingsPersistence.ts` via `file_ops.rs` | User keymap overlay over the defaults. |
| `workspace.json` | app-config dir | `settingsPersistence.ts` via `file_ops.rs` | Last folder for startup restore. |

- Resolved app-config dir (typical): macOS
  `~/Library/Application Support/<bundle-id>/`, Windows
  `%APPDATA%/<bundle-id>/`, Linux `~/.config/<bundle-id>/`.
- Commands: `app_config_path`, `read_file`, and `write_file`. Settings are loaded
  once on startup and pushed into `settingsStore.ts`, which applies them to the
  UI, Monaco, terminal launch options, Julia, and LaTeX build commands.
- **Persisted settings keys** (full schema in `docs/SETTINGS_SCHEMA.md`):
  `theme`, `fontFamily`, `fontSize`, `lineHeight`, `ligatures`, `tabSize`,
  `wordWrap`, `shellPath`, `terminalCwdBehavior`, `juliaPath`,
  `latexBuildCommand`, `restoreWorkspaceOnStartup`, `minimap`, `lineNumbers`.
- `restoreWorkspaceOnStartup` controls whether `workspace.json` is replayed at
  launch (M10).

---

## 13. Data-flow examples

### 13.1 Open a file

1. User triggers quick open (`Cmd/Ctrl+P`) or clicks a file in `Sidebar.tsx`.
2. `useOpenFileBridge.ts` classifies the path by extension.
3. PDFs and images register viewer-tab docs in `editorStore.ts`; their viewer
   components read bytes later via `read_file_bytes`.
4. Text files call `ipc.readFile(path)` -> `read_file`, then create/update a
   Monaco model, register a tab in `editorStore.ts`, and focus `EditorArea.tsx`.
   The status bar updates language + cursor position.
5. If a language server for that text language is configured, `lspClient.ts` sends
   `textDocument/didOpen`.

### 13.2 Run Julia selection

1. User clicks the tab-bar Run button on a `.jl` file or presses
   `Cmd/Ctrl+Enter` (run current file or selected code).
2. The `julia.run` command reads the editor selection (or whole file) from the
   active Monaco model.
3. It calls `run_julia` in `src-tauri/src/julia.rs`, which spawns `julia` (path
   from the `juliaPath` setting) as a child process, passing the code/file.
4. Backend streams the process stdout/stderr to the frontend via events; the
   output renders in the Output view inside `BottomPanel.tsx`.
5. On exit, the backend emits a completion event; the status bar shows the run
   result.

### 13.3 Diagnostics from LSP to Monaco

1. The language server emits a `textDocument/publishDiagnostics` notification on
   its stdout.
2. `src-tauri/src/lsp.rs` deframes the message and emits it on
   `lsp:message:<sessionId>`.
3. `lspClient.ts` listens for that event and recognizes the notification.
4. The client converts LSP diagnostics into Monaco markers
   (`monaco.editor.setModelMarkers`) on the matching model, so squiggles appear
   inline; severity maps to Monaco marker severity.
5. `lspStore.ts` updates counts for the Problems view / status bar.

### 13.4 Toggle the terminal

1. `Ctrl+\`` runs `terminal.toggle`, flipping a flag in `layoutStore.ts`.
2. On first show, `terminal.ts` lazily creates an xterm instance and calls
   `term_create`; thereafter it only re-attaches. Output continues flowing on the
   per-id event channel regardless of panel visibility.

---

## 14. Performance & lazy-loading strategy

- **Lazy-load heavy subsystems:** Monaco, PDF.js, xterm, and LSP servers are loaded
  only on first use (dynamic `import()` on the frontend; child processes spawned on
  demand on the backend). A cold launch renders the shell layout (M1) with a small
  bundle.
- **Code-splitting:** Monaco and PDF.js live in separate Vite chunks (and Monaco
  workers in their own files) so they never bloat the entry chunk.
- **No background indexing in v1.** There is no project-wide symbol index, no
  marketplace, and no Electron; all "intelligence" comes from on-demand LSP
  requests.
- **Bounded streaming:** PTY and run output are streamed in chunks and rendered
  incrementally; xterm's scrollback is capped to avoid unbounded memory.
- **Single WebView, single window:** keeps memory low and the IPC surface small.

---

## 15. Security model

Lyceum follows Tauri v2's capability/permission model — the WebView gets the
**least privilege** required, and all sensitive I/O lives in Rust.

- **Capabilities/permissions allowlist.** `src-tauri/capabilities/default.json`
  grants the `main` window an explicit permission set. The scaffold starts from
  `core:default` and `opener:default`; new functionality adds **only** the
  specific permissions it needs. Lyceum does **not** expose broad plugin permissions
  (e.g. it does not grant the `fs` or `shell` plugins blanket access). Instead, all
  filesystem, terminal, LSP, and process work is done through **our own
  `#[tauri::command]` functions**, which are themselves gated by the command
  allowlist in `lib.rs`.
- **No arbitrary execution from the WebView.** The WebView cannot spawn processes
  or open arbitrary files directly; it can only invoke the specific, audited
  commands listed in `lib.rs`. Process launching (shells, Julia, language servers)
  is constrained to configured paths (`shellPath`, `juliaPath`,
  `latexBuildCommand`).
- **Path validation.** `file_ops.rs`, `fs_ops.rs`, and `walk.rs` validate command
  inputs enough for local desktop use; config-file paths are resolved through
  the Tauri app-config dir.
- **CSP.** `tauri.conf.json` currently sets `security.csp = null` for Monaco,
  xterm, PDF.js workers, and Tauri asset loading. This is acceptable for the
  bundled, trusted local frontend in v1, and is tracked as a hardening item in
  `docs/RISKS.md`.
- **Serializable errors only.** Commands return `Result<T, AppError>` with no raw
  OS handles crossing the IPC boundary; the frontend receives only opaque ids and
  data.

---

## 16. Non-goals (v1)

No VS Code extension compatibility, no debugger, no marketplace, no remote SSH, no
notebooks, no full Git UI, no plugin system, and no exact VS Code API
compatibility. These constrain the architecture above and must not be reintroduced
through new modules.
