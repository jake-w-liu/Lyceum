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
#[cfg(target_os = "macos")]
mod macos_service;
mod menu;
mod path_access;
mod search;
mod terminal;
mod walk;
mod window_ops;
mod workspace_paths;
mod workspace_watch;

use std::collections::HashMap;
use std::sync::Mutex;

use app_info::AppInfo;
use tauri::{Emitter, Manager, RunEvent};

/// Folders Lyceum was asked to open, e.g. via `lyceum .` which runs
/// `open -na Lyceum --args /abs/path`, keyed by the window label that should
/// open them. Seeded in `setup` with the cold-start folder for the initial
/// window, then extended whenever the single-instance plugin forwards a second
/// launch (keyed to the window opened for it). Each window's frontend reads its
/// own entry once on mount, taking precedence over the restored workspace.
///
/// Keying by window label (not a FIFO queue) avoids a race: webviews load
/// asynchronously, so a later-created window can call `get_launch_dir` before an
/// earlier one — a queue would then hand it the wrong folder. The lookup is by
/// the *calling* window's label, so each window always gets its own folder.
struct LaunchDir(Mutex<HashMap<String, String>>);

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

fn first_dir_arg_from<I: IntoIterator<Item = String>>(
    args: I,
    launch_cwd: &std::path::Path,
) -> Option<String> {
    args.into_iter()
        .map(std::path::PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                launch_cwd.join(path)
            }
        })
        .find(|path| path.is_dir())
        .and_then(|path| std::fs::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// The launch folder for a cold start, resolved from this process's argv.
fn launch_dir_from_args() -> Option<String> {
    first_dir_arg(std::env::args().skip(1))
}

/// Preserve the cross-manager teardown invariant for a destroyed window. The
/// watcher tombstone must exist before its path grants are cleared, otherwise a
/// previously claimed setup can recreate a grant and install in between.
fn teardown_window_workspace_ownership(
    invalidate_watcher: impl FnOnce(),
    clear_path_access: impl FnOnce(),
) {
    invalidate_watcher();
    clear_path_access();
}

/// Returns basic information about the running app and host platform.
/// Used by the status bar (M1) and the command palette / about view later.
#[tauri::command]
fn get_app_info() -> AppInfo {
    app_info::app_info()
}

/// The folder this window was launched to open (or `null`). `window` is the
/// calling webview, injected by Tauri; we look its label up and consume the
/// entry so the folder opens exactly once for the window it was meant for.
#[tauri::command]
fn get_launch_dir(window: tauri::Window, state: tauri::State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().ok()?.remove(window.label())
}

#[derive(serde::Serialize)]
struct NativeWindowContentInset {
    x: f64,
    y: f64,
}

/// Return the AppKit chrome inset between Wry's NSWindow-relative drag points
/// and the WKWebView client origin. Native page zoom is handled separately by
/// the frontend and must not be folded into this logical-point value.
#[cfg(target_os = "macos")]
#[tauri::command]
fn native_window_content_inset(window: tauri::Window) -> Result<NativeWindowContentInset, String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this NSWindow for the command's duration and
    // `ns_window` returns its valid AppKit object pointer on the main thread.
    let ns_window = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
    let frame = ns_window.frame();
    let content = ns_window.contentLayoutRect();
    Ok(NativeWindowContentInset {
        x: ((frame.size.width - content.size.width) / 2.0).max(0.0),
        y: (frame.size.height - content.size.height).max(0.0),
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn native_window_content_inset() -> NativeWindowContentInset {
    NativeWindowContentInset { x: 0.0, y: 0.0 }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (double-click or `lyceum .`)
        // hands its argv to the already-running process and exits, so macOS keeps
        // one dock icon. We open a window for it and record any folder it carried.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Open the window first so we know its label, then record the folder
            // (if any) against that exact window — never a different one.
            // Relative argv entries belong to the SECOND process's cwd, not the
            // already-running GUI process's cwd. The plugin forwards that cwd
            // explicitly; ignoring it makes `lyceum .` open the wrong folder (or
            // none) whenever the first instance was launched elsewhere.
            let dir = if cwd.is_empty() {
                first_dir_arg(argv)
            } else {
                first_dir_arg_from(argv, std::path::Path::new(&cwd))
            };
            match window_ops::open_new_window(app) {
                Ok(window) => {
                    if let Some(dir) = dir {
                        if let Some(state) = app.try_state::<LaunchDir>() {
                            if let Ok(mut map) = state.0.lock() {
                                map.insert(window.label().to_string(), dir);
                            }
                        }
                    }
                }
                Err(err) => eprintln!("failed to open window for second instance: {err}"),
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchDir(Mutex::new(HashMap::new())))
        .manage(terminal::TerminalManager::default())
        .manage(lsp::LspManager::default())
        .manage(julia::RunManager::default())
        .manage(workspace_watch::WorkspaceWatchManager::default())
        .manage(path_access::PathAccessManager::default())
        .setup(|app| {
            let menu = menu::build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            // Install/refresh the "Open in Lyceum" Finder Quick Action so users
            // can right-click a folder to open it. Best-effort, never fatal.
            #[cfg(target_os = "macos")]
            if let Err(err) = macos_service::ensure_installed() {
                eprintln!("failed to install Finder Quick Action: {err}");
            }
            // Route the cold-start folder (`lyceum .`) to the initial window by
            // its label, so its frontend — and no other window — opens it.
            if let Some(dir) = launch_dir_from_args() {
                if let Some(window) = app.webview_windows().into_values().next() {
                    if let Ok(mut map) = app.state::<LaunchDir>().0.lock() {
                        map.insert(window.label().to_string(), dir);
                    }
                }
            }
            Ok(())
        })
        // Window labels are never reused (window_ops::WINDOW_SEQUENCE is
        // monotonic), so a destroyed window's backend resources — its workspace
        // watcher, terminal shells, language servers, and Julia runs — would
        // otherwise leak until app exit. Tear them down here. Each manager
        // removes its entries under its own lock and kills/drops after the
        // guard is released; the managers are independent, so no two locks are
        // ever held at once.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                teardown_window_workspace_ownership(
                    || {
                        window
                            .state::<workspace_watch::WorkspaceWatchManager>()
                            .remove_window(label);
                    },
                    || {
                        // Once tombstoned, a previously claimed setup cannot
                        // install; its stale-setup path revokes any grant it
                        // happens to insert after this clear.
                        window
                            .state::<path_access::PathAccessManager>()
                            .remove_window(window.app_handle(), label);
                    },
                );
                window
                    .state::<terminal::TerminalManager>()
                    .close_sessions_for_window(label);
                window
                    .state::<lsp::LspManager>()
                    .stop_servers_for_window(label);
                window
                    .state::<julia::RunManager>()
                    .cancel_runs_for_window(label);
                // Drop any unconsumed launch-dir entry for this window. Normally
                // get_launch_dir removes it on frontend mount, but a window
                // destroyed before its webview mounts (load failure / rapid close)
                // would otherwise leak the entry forever (labels are never reused).
                if let Some(state) = window.try_state::<LaunchDir>() {
                    if let Ok(mut map) = state.0.lock() {
                        map.remove(label);
                    }
                }
            }
        })
        // Native menu items carry frontend command ids; window lifecycle
        // commands must run in the backend so they work without a live webview.
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "app.newWindow" {
                if let Err(err) = window_ops::open_new_window(app) {
                    eprintln!("failed to open new window: {err}");
                }
                return;
            }
            // The macOS menu bar is app-global, so deliver the command to the
            // focused window ONLY. Broadcasting with app.emit ran it in every
            // window at once — e.g. Open Folder fired in the first window even
            // when clicked from the second. Fall back to a broadcast if no
            // window reports focus (rare; e.g. all minimized).
            let focused_label = app
                .webview_windows()
                .into_iter()
                .find(|(_, win)| win.is_focused().unwrap_or(false))
                .map(|(label, _)| label);
            match focused_label {
                Some(label) => {
                    let _ = app.emit_to(label.as_str(), "menu", id);
                }
                None => {
                    let _ = app.emit("menu", id);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_launch_dir,
            native_window_content_inset,
            path_access::authorize_workspace_root,
            path_access::revoke_workspace_root,
            fs_ops::read_directory,
            fs_ops::create_file,
            fs_ops::create_directory,
            fs_ops::rename_path,
            fs_ops::move_paths,
            fs_ops::copy_paths,
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
            julia::run_process,
            julia::run_julia,
            julia::run_cancel,
            latex::run_latex_build,
            workspace_watch::watch_workspace,
            workspace_watch::unwatch_workspace,
            window_ops::new_window,
            window_ops::quit_app,
            window_ops::cancel_quit,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop
        ])
        .build({
            #[cfg(target_os = "macos")]
            {
                tauri::generate_context!()
            }

            #[cfg(not(target_os = "macos"))]
            {
                tauri::generate_context!(test = true)
            }
        })
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // On quit, tear down every child process we manage so language
                // servers, shells, and Julia runs are never orphaned.
                RunEvent::ExitRequested { .. } => {
                    app.state::<terminal::TerminalManager>().shutdown_all();
                    app.state::<lsp::LspManager>().shutdown_all();
                    app.state::<julia::RunManager>().shutdown_all();
                    // Drop the filesystem watcher too, so its notify worker
                    // threads stop before teardown instead of emitting onto a
                    // closing app handle.
                    app.state::<workspace_watch::WorkspaceWatchManager>()
                        .shutdown_all();
                }
                // During a Quit, exit the whole app once the last window has run
                // its own close guard and been destroyed — so no window's unsaved
                // work is discarded, and so macOS (which keeps the process alive
                // after the last window closes) still actually quits.
                RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if window_ops::quit_requested()
                    && app.webview_windows().into_keys().all(|l| l == label) =>
                {
                    app.exit(0);
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    let result = if has_visible_windows {
                        window_ops::focus_or_open_window(app)
                    } else {
                        window_ops::open_new_window(app).map(|_| ())
                    };
                    if let Err(err) = result {
                        eprintln!("failed to handle app reopen: {err}");
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{first_dir_arg_from, teardown_window_workspace_ownership};
    use std::cell::RefCell;

    #[test]
    fn relative_second_instance_directory_uses_the_launching_process_cwd() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();

        let resolved =
            first_dir_arg_from(["lyceum".to_string(), "workspace".to_string()], tmp.path());

        let expected = workspace.canonicalize().unwrap();
        assert_eq!(
            resolved.as_deref(),
            Some(expected.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn destroyed_window_tombstones_watcher_before_clearing_path_access() {
        let order = RefCell::new(Vec::new());

        teardown_window_workspace_ownership(
            || order.borrow_mut().push("watcher"),
            || order.borrow_mut().push("access"),
        );

        assert_eq!(order.into_inner(), ["watcher", "access"]);
    }
}
