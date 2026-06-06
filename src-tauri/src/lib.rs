// lyceum backend library entry point.
//
// Tauri commands are the primary IPC mechanism (frontend `invoke(...)` -> Rust).
// Long-lived / streaming concerns (terminal PTY output, LSP messages) will use
// Tauri events in later milestones. For M1 we expose a single `get_app_info`
// command so the status bar can display real platform information end-to-end.

mod app_info;
mod file_ops;
mod fs_ops;
mod git;
mod julia;
mod latex;
mod lsp;
mod menu;
mod search;
mod terminal;
mod walk;
mod workspace_watch;

use app_info::AppInfo;
use tauri::{Emitter, Manager, RunEvent};

/// The folder Lyceum was asked to open on launch, e.g. via `lyceum .` which
/// runs `open -na Lyceum --args /abs/path`. Resolved once from argv at startup;
/// `None` for a plain double-click launch. The frontend reads this on mount and
/// opens it as the workspace, taking precedence over the restored workspace.
struct LaunchDir(Option<String>);

/// First argv entry that is an existing directory, canonicalized to an absolute
/// path. Filtering on `is_dir` skips the program name and macOS-injected flags
/// like `-psn_0_12345`, so a plain launch yields `None`.
fn first_dir_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.is_dir())
        .and_then(|p| std::fs::canonicalize(&p).ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// The launch folder for a cold start, resolved from this process's argv.
fn launch_dir_from_args() -> Option<String> {
    first_dir_arg(std::env::args().skip(1))
}

/// Returns basic information about the running app and host platform.
/// Used by the status bar (M1) and the command palette / about view later.
#[tauri::command]
fn get_app_info() -> AppInfo {
    app_info::app_info()
}

/// The folder passed on the command line at launch (or `null`).
#[tauri::command]
fn get_launch_dir(state: tauri::State<'_, LaunchDir>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchDir(launch_dir_from_args()))
        .manage(terminal::TerminalManager::default())
        .manage(lsp::LspManager::default())
        .manage(julia::RunManager::default())
        .manage(workspace_watch::WorkspaceWatchManager::default())
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
            get_launch_dir,
            fs_ops::read_directory,
            fs_ops::create_file,
            fs_ops::create_directory,
            fs_ops::rename_path,
            fs_ops::move_paths,
            fs_ops::delete_path,
            fs_ops::delete_file_if_exists,
            fs_ops::move_paths_to_trash,
            fs_ops::restore_trash_batch,
            fs_ops::redo_trash_batch,
            search::search_workspace,
            git::git_status,
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
            julia::run_cancel,
            latex::resolve_latex_tools,
            latex::run_latex_build,
            workspace_watch::watch_workspace,
            workspace_watch::unwatch_workspace,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On quit, tear down every child process we manage so language
            // servers, shells, and Julia runs are never orphaned.
            if let RunEvent::ExitRequested { .. } = event {
                app.state::<terminal::TerminalManager>().shutdown_all();
                app.state::<lsp::LspManager>().shutdown_all();
                app.state::<julia::RunManager>().shutdown_all();
            }
        });
}
