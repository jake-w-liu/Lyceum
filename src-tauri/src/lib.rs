// lyceum backend library entry point.
//
// Tauri commands are the primary IPC mechanism (frontend `invoke(...)` -> Rust).
// Long-lived / streaming concerns (terminal PTY output, LSP messages) will use
// Tauri events in later milestones. For M1 we expose a single `get_app_info`
// command so the status bar can display real platform information end-to-end.

mod app_info;
mod file_ops;
mod fs_ops;
mod julia;
mod lsp;
mod menu;
mod search;
mod terminal;
mod walk;

use app_info::AppInfo;
use tauri::Emitter;

/// Returns basic information about the running app and host platform.
/// Used by the status bar (M1) and the command palette / about view later.
#[tauri::command]
fn get_app_info() -> AppInfo {
    app_info::app_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::TerminalManager::default())
        .manage(lsp::LspManager::default())
        .manage(julia::RunManager::default())
        .setup(|app| {
            let menu = menu::build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        // Native menu items carry frontend command ids; forward clicks to the UI.
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            fs_ops::read_directory,
            fs_ops::create_file,
            fs_ops::create_directory,
            fs_ops::rename_path,
            fs_ops::delete_path,
            search::search_workspace,
            file_ops::read_file,
            file_ops::write_file,
            file_ops::read_file_bytes,
            file_ops::app_config_path,
            walk::list_workspace_files,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            julia::run_julia,
            julia::run_build,
            julia::run_cancel,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
