# Settings Schema

This document is the canonical reference for **user settings** and **keybindings**
persistence in the IDE. It defines every settings key — its type, default value,
allowed values, and meaning — provides a complete example `settings.json`,
documents the on-disk locations per OS, and describes the migration/versioning
strategy.

Settings and keybindings are persisted as JSON in the OS application
configuration directory via Tauri. The Rust backend owns reading and writing
these files; the frontend reads and writes through Tauri commands (typed IPC
wrappers in `src/lib/`). Settings are loaded once on startup, validated, and
applied to the relevant Zustand stores (editor, terminal, layout). Persistence
itself lands with **M10 (Settings persistence + workspace restore)**, but
several keys are consumed by earlier milestones (theming in M7, terminal in M5,
Julia workflow in M8, LaTeX/preview in M6/M11).

---

## 1. Conventions

- All settings live in a single flat JSON object (no nested namespaces in v1).
- A reserved `version` field (integer) tracks the schema revision for migration.
  It is **not** a user-facing setting; see
  [§5 Versioning & Migration](#5-versioning--migration).
- Missing keys fall back to their documented default. A user only needs to
  specify the keys they wish to override.
- Unknown keys are preserved on read and written back unchanged when possible
  (forward-compatibility for files written by a newer build); they are otherwise
  ignored.
- Path-valued keys may use `~` for the home directory; the backend expands it.
- Empty string (`""`) on a path-valued key means "resolve automatically"
  (default shell / `julia` on `PATH`), never "the current directory".

---

## 2. Settings Keys

The current schema version is **`1`**.

| Key | Type | Default | Allowed values | Description |
|-----|------|---------|----------------|-------------|
| `version` | integer | `1` | positive integer | Reserved schema-version field used for migration. Not user-facing; managed by the app. |
| `theme` | string | `"vscode-dark"` | `"light"`, `"dark"`, `"high-contrast"`, `"vscode-dark"` | Active color theme. `vscode-dark` is the VS Code-like default dark theme. Drives both the app chrome (CSS custom properties) and the Monaco editor theme (M7). |
| `fontFamily` | string | `"SF Mono, Menlo, Consolas, 'Courier New', monospace"` | any valid CSS `font-family` string | Font stack used by the Monaco editor and the integrated terminal (xterm.js). |
| `fontSize` | number | `13` | integer 6–72 (px) | Editor and terminal font size in pixels. |
| `lineHeight` | number | `0` | `0`, or a number ≥ `8` | Editor line height. `0` means "derive automatically from `fontSize`" (Monaco default). A value ≥ 8 is an absolute pixel line height; a value > 0 and < 8 is treated as a multiplier of `fontSize`. |
| `ligatures` | boolean | `false` | `true`, `false` | Enable font ligatures (Monaco `fontLigatures`). Only visible with a ligature-capable `fontFamily`. |
| `tabSize` | number | `4` | integer 1–16 | Number of spaces a tab is rendered/inserted as in the editor (Monaco `tabSize`). |
| `wordWrap` | string | `"off"` | `"off"`, `"on"`, `"wordWrapColumn"`, `"bounded"` | Editor soft-wrap mode, mapped directly to Monaco's `wordWrap` option. |
| `shellPath` | string | `""` | absolute path to a shell executable, or `""` | Shell launched by the integrated terminal (real PTY via the `portable-pty` crate, M5). `""` means "use the OS default shell" (`$SHELL` on macOS/Linux; the configured default on Windows). |
| `terminalCwdBehavior` | string | `"workspaceRoot"` | `"workspaceRoot"`, `"currentFileDir"` | Working directory used when opening a new terminal: the opened workspace root, or the directory of the active file. |
| `juliaPath` | string | `""` | absolute path to the `julia` executable, or `""` | Julia binary used for run-file / run-selection (M8) and for launching LanguageServer.jl (M9). `""` means "resolve `julia` from `PATH`". |
| `latexBuildCommand` | string | `"latexmk -pdf main.tex"` | any shell command string | Command run for the Markdown/LaTeX build-and-preview workflow (M11). Executed in the workspace root via the process/PTY layer. |
| `pdfPreviewMode` | string | `"tab"` | `"tab"`, `"sidePanel"` | Where PDF.js renders a previewed PDF (M6): in a dedicated editor tab, or in a side panel next to the editor. |
| `autosave` | string | `"off"` | `"off"`, `"afterDelay"`, `"onFocusChange"` | Automatic save behavior. `afterDelay` saves dirty files after a short idle delay; `onFocusChange` saves when the editor/tab loses focus. |
| `restoreWorkspaceOnStartup` | boolean | `true` | `true`, `false` | When `true`, the last opened folder, open tabs, and panel layout are restored on launch (M10). |
| `minimap` | boolean | `false` | `true`, `false` | Show the Monaco minimap (`minimap.enabled`). |
| `lineNumbers` | string | `"on"` | `"on"`, `"off"`, `"relative"` | Editor line-number gutter mode, mapped to Monaco's `lineNumbers` option. |

### Notes on types and validation

- `boolean` keys accept only the JSON literals `true` / `false`.
- `number` keys must be JSON numbers; non-integer values for integer-only keys
  (`fontSize`, `tabSize`) are rounded by the backend on load.
- String enum keys are matched case-sensitively against their allowed values.
- A value outside the allowed range or set is clamped/coerced to the nearest
  valid value (or the default for enums) and a warning is logged. The file is
  not silently rewritten unless a migration runs (see §5).

---

## 3. Example `settings.json` (all defaults)

This is the complete default settings object. A freshly initialized
installation writes exactly this file.

```json
{
  "version": 1,
  "theme": "vscode-dark",
  "fontFamily": "SF Mono, Menlo, Consolas, 'Courier New', monospace",
  "fontSize": 13,
  "lineHeight": 0,
  "ligatures": false,
  "tabSize": 4,
  "wordWrap": "off",
  "shellPath": "",
  "terminalCwdBehavior": "workspaceRoot",
  "juliaPath": "",
  "latexBuildCommand": "latexmk -pdf main.tex",
  "pdfPreviewMode": "tab",
  "autosave": "off",
  "restoreWorkspaceOnStartup": true,
  "minimap": false,
  "lineNumbers": "on"
}
```

A user override file only needs the keys being changed, for example:

```json
{
  "version": 1,
  "theme": "high-contrast",
  "fontSize": 15,
  "ligatures": true,
  "juliaPath": "/usr/local/bin/julia",
  "autosave": "afterDelay"
}
```

---

## 4. On-Disk Locations

Both `settings.json` and `keybindings.json` live in the Tauri **app config
directory**, resolved at runtime via `app_config_dir()` on Tauri v2's path
resolver. Tauri derives that directory from the bundle **identifier** in
`src-tauri/tauri.conf.json`, which for this project is **`dev.lyceum.app`**. The
app config directory is therefore the OS config base joined with
`dev.lyceum.app`:

| OS | App config directory | Settings file | Keybindings file |
|----|----------------------|---------------|------------------|
| macOS | `~/Library/Application Support/dev.lyceum.app/` | `~/Library/Application Support/dev.lyceum.app/settings.json` | `~/Library/Application Support/dev.lyceum.app/keybindings.json` |
| Windows | `%APPDATA%\dev.lyceum.app\` (i.e. `C:\Users\<user>\AppData\Roaming\dev.lyceum.app\`) | `%APPDATA%\dev.lyceum.app\settings.json` | `%APPDATA%\dev.lyceum.app\keybindings.json` |
| Linux | `$XDG_CONFIG_HOME/dev.lyceum.app/` (defaults to `~/.config/dev.lyceum.app/`) | `$XDG_CONFIG_HOME/dev.lyceum.app/settings.json` | `$XDG_CONFIG_HOME/dev.lyceum.app/keybindings.json` |

> The directory name tracks the `identifier` field in `tauri.conf.json`. If that
> identifier ever changes, these paths change with it; this document is the
> source of truth for the mapping.

### Read/write behavior

- On first launch, if a file does not exist, the backend creates the config
  directory and writes the default file (the defaults from §3 for settings; the
  default keymap shipped in `src/keybindings/` for keybindings).
- Writes are **atomic**: the backend writes to a temporary file in the same
  directory and renames it over the target, avoiding corruption on crash.
- If a file exists but is invalid JSON, the backend backs it up to
  `<name>.bak.<timestamp>` and regenerates defaults, logging the action. User
  data is never silently destroyed.
- Reads and writes happen only through Tauri commands; the frontend never
  touches the filesystem directly.

### `keybindings.json`

Keybindings are persisted **separately** from settings because they are managed
by a distinct registry (the keybinding registry in `src/keybindings/`). The file
maps key chords to **command ids** from the TS command registry — keybindings
never invoke behavior directly, they only dispatch a command id. The default
keymap ships in the repo under `src/keybindings/` and is written to the app
config directory on first launch; the on-disk file is the user-editable
override layer.

The on-disk file is a JSON object with a `version` field and a `keybindings`
array. Each entry has a normalized `key` chord, a `command` id, and an optional
`when` context expression (omitted in the abbreviated sample below; see
[KEYBINDINGS.md](./KEYBINDINGS.md) for the full keymap with `when` clauses). Use
`mod` for the platform Cmd/Ctrl key (`mod`
resolves to `Cmd` on macOS and `Ctrl` on Windows/Linux); `alt` is `Option` on
macOS. Special keys use names such as `enter`, `escape`, `tab`, `backquote`
(the `` ` `` key), `up`, `down`, `f12`.

```json
{
  "version": 1,
  "keybindings": [
    { "key": "mod+p",            "command": "quickOpen.show" },
    { "key": "mod+shift+p",      "command": "commandPalette.show" },
    { "key": "mod+b",            "command": "workbench.toggleSidebar" },
    { "key": "mod+backquote",    "command": "terminal.toggle" },
    { "key": "mod+shift+backquote","command": "terminal.new" },
    { "key": "mod+j",            "command": "workbench.toggleBottomPanel" },
    { "key": "mod+s",            "command": "file.save" },
    { "key": "mod+w",            "command": "editor.closeTab" },
    { "key": "mod+tab",          "command": "editor.nextTab" },
    { "key": "mod+shift+tab",    "command": "editor.previousTab" },
    { "key": "mod+f",            "command": "editor.find" },
    { "key": "mod+shift+f",      "command": "workbench.searchWorkspace" },
    { "key": "mod+g",            "command": "editor.goToLine" },
    { "key": "f12",              "command": "editor.goToDefinition" },
    { "key": "shift+f12",        "command": "editor.findReferences" },
    { "key": "mod+/",            "command": "editor.toggleLineComment" },
    { "key": "alt+up",           "command": "editor.moveLineUp" },
    { "key": "alt+down",         "command": "editor.moveLineDown" },
    { "key": "shift+alt+up",     "command": "editor.duplicateLineUp" },
    { "key": "shift+alt+down",   "command": "editor.duplicateLineDown" },
    { "key": "mod+enter",        "command": "editor.run" },
    { "key": "mod+shift+v",      "command": "preview.open" },
    { "key": "escape",           "command": "workbench.dismiss" }
  ]
}
```

Notes:

- `Cmd/Ctrl+Click` go-to-definition is a mouse gesture handled in the editor
  layer; it dispatches the same `editor.goToDefinition` command as `F12` and so
  has no standalone chord entry.
- `Esc` (close command palette / quick open / find box / modal) maps to the
  single `workbench.dismiss` command, gated by a `when` context.
- The command ids above match `docs/KEYBINDINGS.md`, which is the authoritative
  reference for the full keymap, the `Keybinding` shape (including the optional
  `when` field), the supported context keys, and rebinding/unbinding rules. This
  document covers only the on-disk **location** and **versioning** of
  `keybindings.json`.

---

## 5. Versioning & Migration

Both `settings.json` and `keybindings.json` carry a top-level integer `version`
field. The current schema version is **`1`**.

Loading algorithm (in the Rust backend):

1. Read and parse the file. On parse failure, back up and regenerate defaults
   (see §4).
2. Read the `version` field. If absent, assume `0` (pre-versioned).
3. If `version` is **less than** the app's current schema version, run the
   registered migrations in sequence (`0 -> 1 -> 2 -> ...`) until the object
   reaches the current version. Each migration is a pure function
   `(json) -> json` that renames, removes, or defaults keys as needed.
4. If `version` **equals** the current version, validate and load as-is.
5. If `version` is **greater than** the current version (file written by a newer
   build), load known keys best-effort, preserve unknown keys, and do **not**
   downgrade the file on disk. A warning is logged.
6. After a successful upgrade migration, the migrated object (with the bumped
   `version`) is written back atomically.

Guidelines for future schema changes:

- **Never** repurpose an existing key's meaning without a version bump and a
  migration.
- Additive changes (a new optional key with a default) still bump the version so
  older files are normalized on next load.
- Each migration must be deterministic and idempotent for its input version.
- Keep a changelog of migrations alongside the migration code in `src-tauri/`.
