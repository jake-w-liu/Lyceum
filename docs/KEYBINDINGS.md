# Keybindings Reference

This document is the canonical reference for keyboard shortcuts in **Lyceum**, a lightweight,
VS Code-inspired research IDE built with Tauri (Tauri v2 + Rust backend; React 19 + TypeScript
frontend; Monaco editor). It lists every default keybinding, the command id each shortcut invokes,
and the milestone in which the binding becomes active. It also documents the keybinding JSON format
and how users customize bindings.

Keybindings are resolved by a TypeScript **keybinding registry** (`src/keybindings/`) that maps
shortcuts to **command ids**. Every action in the application is a command in the **command
registry** (`src/commands/`); keybindings never invoke behavior directly — they only dispatch a
command id. This keeps shortcuts, the command palette, and programmatic invocation all routed
through a single code path, and means any command remains reachable from the palette
(`Cmd/Ctrl+Shift+P`) even when it has no bound key.

Platform conventions:

- **macOS** uses `Cmd` (the `⌘` / `meta` key), plus `Shift`, `Option`, and `Ctrl`.
- **Windows/Linux** uses `Ctrl` as the primary modifier, plus `Shift` and `Alt`.
- `Alt` on Windows/Linux is `Option` on macOS.

In the keymap JSON the primary modifier is written generically as `mod`, which the registry resolves
to `Cmd` on macOS and `Ctrl` on Windows/Linux.

## Default keybindings

| Action | macOS | Windows/Linux | Command ID | Milestone |
| --- | --- | --- | --- | --- |
| Quick open (files) | `Cmd+P` | `Ctrl+P` | `quickOpen.show` | M4 |
| Command palette | `Cmd+Shift+P` | `Ctrl+Shift+P` | `commandPalette.show` | M4 |
| Toggle sidebar | `Cmd+B` | `Ctrl+B` | `workbench.toggleSidebar` | M1 |
| Toggle terminal panel | `` Ctrl+` `` | `` Ctrl+` `` | `terminal.toggle` | M5 |
| New terminal | `` Ctrl+Shift+` `` | `` Ctrl+Shift+` `` | `terminal.new` | M5 |
| Toggle bottom panel | `Cmd+J` | `Ctrl+J` | `workbench.toggleBottomPanel` | M1 |
| Save file | `Cmd+S` | `Ctrl+S` | `file.save` | M3 |
| Close tab | `Cmd+W` | `Ctrl+W` | `editor.closeTab` | M3 |
| Next tab | `Cmd+Tab` | `Ctrl+Tab` | `editor.nextTab` | M3 |
| Previous tab | `Cmd+Shift+Tab` | `Ctrl+Shift+Tab` | `editor.previousTab` | M3 |
| Find in file | `Cmd+F` | `Ctrl+F` | `editor.find` | M3 |
| Search workspace | `Cmd+Shift+F` | `Ctrl+Shift+F` | `workbench.searchWorkspace` | M4 |
| Go to line | `Cmd+G` | `Ctrl+G` | `editor.goToLine` | M3 |
| Go to definition | `F12` | `F12` | `editor.goToDefinition` | M9 |
| Find references | `Shift+F12` | `Shift+F12` | `editor.findReferences` | M9 |
| Go to definition (click) | `Cmd+Click` | `Ctrl+Click` | `editor.goToDefinition` | M9 |
| Toggle line comment | `Cmd+/` | `Ctrl+/` | `editor.toggleLineComment` | M3 |
| Move line up | `Option+Up` | `Alt+Up` | `editor.moveLineUp` | M3 |
| Move line down | `Option+Down` | `Alt+Down` | `editor.moveLineDown` | M3 |
| Duplicate line up | `Shift+Option+Up` | `Shift+Alt+Up` | `editor.duplicateLineUp` | M3 |
| Duplicate line down | `Shift+Option+Down` | `Shift+Alt+Down` | `editor.duplicateLineDown` | M3 |
| Run current file or selection | `Cmd+Enter` | `Ctrl+Enter` | `editor.run` | M8 |
| Open Markdown/HTML/PDF/image preview | `Cmd+Shift+V` | `Ctrl+Shift+V` | `preview.open` | M6 / M11 |
| Close palette / quick open / find / modal | `Esc` | `Esc` | `workbench.dismiss` | M4 |

### Notes on specific bindings

- **`Cmd/Ctrl+Click` go to definition** is a mouse gesture rather than a pure keybinding. It is
  handled by the editor layer but dispatches the same `editor.goToDefinition` command, so it shares
  behavior with `F12`. In the keymap JSON it is expressed with the `click` key token (see below).
- **`editor.run`** is context-aware: with an active selection it runs the selected code; with no
  selection it runs the current file. In the Julia-first workflow this routes to the Julia
  run-file / run-selection integration (M8). The `juliaPath` setting determines the interpreter.
- **`preview.open`** opens the appropriate preview for the active file: Markdown/LaTeX
  preview (M11), sandboxed HTML preview, PDF preview (M6, via PDF.js, lazy-loaded),
  or a raw-byte image preview for common browser image formats.
- **`editor.goToDefinition` / `editor.findReferences`** are served by the generic JSON-RPC LSP
  client (M9). They require an active language server — Julia LanguageServer.jl first, then Python
  (pyright), then C# (csharp-ls / OmniSharp).
- **`workbench.dismiss`** (`Esc`) is a single command that closes whichever transient surface is
  open — command palette, quick open, the in-editor find box, or a modal panel — based on the
  current `when` context. See [The `when` clause](#the-when-clause).
- **macOS `Cmd+Tab` / `Cmd+Shift+Tab`** (next/previous tab) are intercepted by the macOS app
  switcher and generally never reach the app. They are listed above for spec fidelity; in practice
  use `Ctrl+Tab` / `Ctrl+Shift+Tab` (or the editor tab UI) on macOS. The keybinding registry (M4)
  ships `Ctrl+Tab` as the working default on macOS.

## Keybinding JSON format

The default keymap ships in the repo under `src/keybindings/`, and user overrides are persisted as
JSON in the OS app-config directory via Tauri (alongside `settings.json`). The on-disk file is a
JSON object with a `version` field and a `keybindings` array; each entry of that array is an object:

```ts
interface Keybinding {
  /** Normalized chord, e.g. "mod+shift+p". Required. */
  key: string;
  /** Command id to dispatch when the chord fires. Required. */
  command: string;
  /** Optional context expression; the binding is active only when this evaluates true. */
  when?: string;
}
```

On disk, the keymap is a versioned object — `{ "version": 1, "keybindings": [ { key, command, when? }, … ] }` — matching the `version` field used by `settings.json` (see [SETTINGS_SCHEMA.md](./SETTINGS_SCHEMA.md)). The `keybindings` value is the array of entries described above.

- **`key`** — the keyboard chord. Modifiers are written in lowercase and joined with `+`:
  `mod`, `cmd`, `ctrl`, `alt`, `shift`, `meta`. Use `mod` for the cross-platform primary modifier
  (`Cmd` on macOS, `Ctrl` on Windows/Linux) — for example `"mod+s"` maps to `Cmd+S` / `Ctrl+S`.
  Use `cmd`/`ctrl` explicitly only when you intentionally want a platform-specific key. `alt` is the
  Option key on macOS. Special keys use names such as `enter`, `escape` (or `esc`), `tab`,
  `backquote` (the `` ` `` key), `up`, `down`, `left`, `right`, and `f12`. Mouse chords use the
  `click` token, e.g. `mod+click`.
- **`command`** — a command id registered in the command registry (the same id shown in the table
  above). If the id is unknown, the binding is ignored.
- **`when`** — an optional boolean context expression. Omitting it makes the binding global.

### The `when` clause

The `when` expression gates a binding by application context. It supports context keys combined with
`&&`, `||`, `!`, `==`, and parentheses. Common context keys:

- `editorFocus` — an editor pane has keyboard focus.
- `editorHasSelection` — the active editor has a non-empty selection.
- `terminalFocus` — the integrated terminal (xterm.js) has focus.
- `textInputFocus` — any text input has focus.
- `paletteOpen` — the command palette is open.
- `quickOpenOpen` — quick open is open.
- `findWidgetVisible` — the in-editor find box is visible.
- `modalOpen` — a modal panel is open.

This lets the same chord do different things in different contexts. For example, `Esc`
(`workbench.dismiss`) is only meaningful when something dismissible is open.

### Resolution rules

- When multiple bindings match a chord, the **last matching entry wins**. User overrides are loaded
  after the defaults, so a user entry for an existing chord takes precedence.
- When several active bindings share a chord, a more specific `when` clause wins; ties fall back to
  definition order (user entries last).
- A binding fires only if its `when` clause (if present) evaluates true in the current context.
- To **unbind** a default chord, add a user entry that maps the chord to the empty command
  (`{ "key": "mod+g", "command": "" }`); the empty command shadows the default and does nothing.

Resolution order, highest priority first:

1. User `keybindings.json` (OS app-config dir).
2. Built-in default keymap (`src/keybindings/`).

## Customizing keybindings

User keybindings live in a JSON file in the OS app-config directory (the same location as
`settings.json`), loaded on top of the built-in default keymap. The file is a JSON object with a
`version` field and a `keybindings` array of `Keybinding` objects. A future version exposes an
editor command (for example `keybindings.open`) to open this file directly. Workflow:

1. Open the command palette (`Cmd/Ctrl+Shift+P`) and run the open-keybindings command, or open your
   user keybindings JSON file directly.
2. Add an entry with the desired `key`, the target `command` id (copy it from the table above or the
   command palette), and an optional `when` clause.
3. Save. The registry reloads bindings on save; no restart required.

To rebind an action, add an entry for the new chord pointing at the same command id, and (optionally)
unbind the old chord with an empty-command entry as described above.

## Sample `keybindings.json`

The snippet below shows the defaults in user-override form. Use `mod` for the Cmd/Ctrl platform key.

```json
{
  "version": 1,
  "keybindings": [
    { "key": "mod+p", "command": "quickOpen.show" },
    { "key": "mod+shift+p", "command": "commandPalette.show" },
    { "key": "mod+b", "command": "workbench.toggleSidebar" },
    { "key": "ctrl+backquote", "command": "terminal.toggle" },
    { "key": "ctrl+shift+backquote", "command": "terminal.new" },
    { "key": "mod+j", "command": "workbench.toggleBottomPanel" },
    { "key": "mod+s", "command": "file.save", "when": "editorFocus" },
    { "key": "mod+w", "command": "editor.closeTab" },
    { "key": "mod+tab", "command": "editor.nextTab" },
    { "key": "mod+shift+tab", "command": "editor.previousTab" },
    { "key": "mod+f", "command": "editor.find", "when": "editorFocus" },
    { "key": "mod+shift+f", "command": "workbench.searchWorkspace" },
    { "key": "mod+g", "command": "editor.goToLine", "when": "editorFocus" },
    { "key": "f12", "command": "editor.goToDefinition", "when": "editorFocus" },
    { "key": "shift+f12", "command": "editor.findReferences", "when": "editorFocus" },
    { "key": "mod+click", "command": "editor.goToDefinition", "when": "editorFocus" },
    { "key": "mod+/", "command": "editor.toggleLineComment", "when": "editorFocus" },
    { "key": "alt+up", "command": "editor.moveLineUp", "when": "editorFocus" },
    { "key": "alt+down", "command": "editor.moveLineDown", "when": "editorFocus" },
    { "key": "shift+alt+up", "command": "editor.duplicateLineUp", "when": "editorFocus" },
    { "key": "shift+alt+down", "command": "editor.duplicateLineDown", "when": "editorFocus" },
    { "key": "mod+enter", "command": "editor.run", "when": "editorFocus" },
    { "key": "mod+shift+v", "command": "preview.open", "when": "editorFocus" },
    { "key": "escape", "command": "workbench.dismiss", "when": "paletteOpen || quickOpenOpen || findWidgetVisible || modalOpen" }
  ]
}
```

User override examples (added to the user `keybindings.json`):

```json
{
  "version": 1,
  "keybindings": [
    { "key": "mod+r", "command": "editor.run", "when": "editorFocus" },
    { "key": "mod+enter", "command": "" }
  ]
}
```

The first entry adds `Cmd/Ctrl+R` as an additional shortcut for running the current file or
selection; the second unbinds the default `Cmd/Ctrl+Enter` run binding.
