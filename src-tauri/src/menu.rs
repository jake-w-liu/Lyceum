// Native application menu (macOS menu bar / Windows-Linux window menu).
//
// Menu item ids ARE command ids from the frontend command registry. Clicking
// most items emits a `menu` Tauri event carrying that id; the frontend executes
// the command (see src/hooks/useMenuCommands.ts). Window lifecycle commands are
// handled natively in Rust because they must work without a live webview. Items
// that already have a frontend keybinding are intentionally left without an
// accelerator so the existing (tested) keyboard handling stays the single source
// for those chords. `Open Folder…` gets Cmd/Ctrl+O (otherwise unbound), while
// Close Lyceum Window uses Cmd/Ctrl+Shift+W so Cmd/Ctrl+W remains Close Editor.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build_app_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(handle, "Lyceum")
        .item(&MenuItemBuilder::with_id("app.newWindow", "New Window").build(handle)?)
        .separator()
        .about(Some(AboutMetadata::default()))
        .separator()
        // Custom Quit (not the predefined item) so it routes through the same
        // "menu" event path as every other item: the frontend can dirty-check
        // unsaved editors first and then invoke `quit_app` itself.
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Lyceum")
                .accelerator("CmdOrCtrl+Q")
                .build(handle)?,
        )
        .build()?;

    let file_menu = SubmenuBuilder::new(handle, "File")
        // No accelerator: Cmd/Ctrl+N belongs to the frontend's New File binding.
        .item(&MenuItemBuilder::with_id("app.newWindow", "New Window").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("explorer.newFile", "New File").build(handle)?)
        .item(&MenuItemBuilder::with_id("explorer.newFolder", "New Folder").build(handle)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.openFolder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?,
        )
        .item(&MenuItemBuilder::with_id("file.save", "Save").build(handle)?)
        .item(&MenuItemBuilder::with_id("editor.closeTab", "Close Editor").build(handle)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItemBuilder::with_id("editor.formatDocument", "Format Document").build(handle)?)
        .item(&MenuItemBuilder::with_id("editor.renameSymbol", "Rename Symbol").build(handle)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&MenuItemBuilder::with_id("commandPalette.show", "Command Palette…").build(handle)?)
        .item(&MenuItemBuilder::with_id("quickOpen.show", "Go to File…").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("workbench.toggleSidebar", "Toggle Sidebar").build(handle)?)
        .item(
            &MenuItemBuilder::with_id("workbench.toggleBottomPanel", "Toggle Panel")
                .build(handle)?,
        )
        .item(&MenuItemBuilder::with_id("terminal.toggle", "Toggle Terminal").build(handle)?)
        .item(&MenuItemBuilder::with_id("preview.open", "Open Preview").build(handle)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("workbench.searchWorkspace", "Find in Files")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("editor.goToSymbol", "Go to Symbol in Editor…")
                .build(handle)?,
        )
        .item(&MenuItemBuilder::with_id("editor.goToLine", "Go to Line…").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("explorer.refresh", "Refresh Explorer").build(handle)?)
        .item(&MenuItemBuilder::with_id("explorer.collapseAll", "Collapse Folders").build(handle)?)
        .build()?;

    let run_menu = SubmenuBuilder::new(handle, "Run")
        .item(&MenuItemBuilder::with_id("editor.run", "Run File or Selection").build(handle)?)
        .item(&MenuItemBuilder::with_id("run.stop", "Stop Running Process").build(handle)?)
        .item(&MenuItemBuilder::with_id("terminal.new", "New Terminal").build(handle)?)
        .item(&MenuItemBuilder::with_id("latex.build", "Compile LaTeX").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("julia.repl", "New Julia REPL").build(handle)?)
        .item(&MenuItemBuilder::with_id("python.repl", "New Python REPL").build(handle)?)
        .item(&MenuItemBuilder::with_id("node.repl", "New Node REPL").build(handle)?)
        .item(
            &MenuItemBuilder::with_id("terminal.runSelection", "Send Selection to Terminal")
                .build(handle)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&MenuItemBuilder::with_id("app.newWindow", "New Window").build(handle)?)
        .separator()
        .minimize()
        .separator()
        .item(
            // With the exact standard title "Close Window", macOS exposed this
            // item as bare Cmd+W despite the requested Shift modifier. Use an
            // app-specific title so the custom accelerator remains distinct.
            &MenuItemBuilder::with_id("window.close", "Close Lyceum Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(handle)?,
        )
        .build()?;

    MenuBuilder::new(handle)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &run_menu,
            &window_menu,
        ])
        .build()
}
