use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

static WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);
// Set while a Quit is in progress so the run loop knows to exit the whole app
// once the last window has finished its own close guard (see `quit_requested`).
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

fn window_label(id: u64) -> String {
    format!("main{id}")
}

fn next_available_window_label(
    mut next_id: impl FnMut() -> u64,
    mut exists: impl FnMut(&str) -> bool,
) -> String {
    loop {
        let label = window_label(next_id());
        if !exists(&label) {
            return label;
        }
    }
}

fn next_window_label<R: Runtime>(app: &AppHandle<R>) -> String {
    next_available_window_label(
        || WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        |label| app.get_webview_window(label).is_some(),
    )
}

#[cfg(target_os = "macos")]
fn focus_first_window<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.webview_windows().into_values().next() else {
        return false;
    };
    let _ = window.set_focus();
    true
}

pub fn open_new_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "missing app window configuration".to_string())?;

    config.label = next_window_label(app);
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    Ok(window)
}

#[cfg(target_os = "macos")]
pub fn focus_or_open_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if focus_first_window(app) {
        Ok(())
    } else {
        open_new_window(app).map(|_| ())
    }
}

#[tauri::command]
pub fn new_window(app: AppHandle) -> Result<(), String> {
    open_new_window(&app).map(|_| ())
}

/// Quit the application, prompting EVERY window about its own unsaved changes —
/// not just the one that issued the quit. Invoked by the frontend `quit` command
/// after that window's own dirty-check.
///
/// With several windows in one process, terminating via `app.exit` straight away
/// would silently discard unsaved edits in the other (unfocused) windows, since
/// their `onCloseRequested` discard guards never run. Instead we close each other
/// window so its guard prompts, and exit only once the last window is destroyed
/// (handled in the run loop, gated on `quit_requested`). The calling window has
/// already been dirty-checked and had its settings flushed by the `quit` command,
/// so we destroy it directly rather than re-firing its guard.
#[tauri::command]
pub fn quit_app(window: WebviewWindow, app: AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    QUIT_REQUESTED.store(true, Ordering::SeqCst);
    let calling_label = window.label();
    for (label, win) in windows {
        if label == calling_label {
            let _ = win.destroy();
        } else {
            // Fires this window's onCloseRequested guard (discard prompt + flush).
            // If its user cancels, it stays open and the app keeps running.
            let _ = win.close();
        }
    }
}

/// Whether a Quit is in progress, so the run loop exits once all windows close.
pub fn quit_requested() -> bool {
    QUIT_REQUESTED.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::{next_available_window_label, window_label};

    #[test]
    fn generated_window_labels_are_tauri_safe() {
        for id in [1, 2, 10, 999] {
            let label = window_label(id);
            assert!(label.chars().all(|ch| ch.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn next_available_window_label_skips_existing_labels() {
        let mut ids = [1, 2, 3].into_iter();

        let label = next_available_window_label(
            || ids.next().expect("ran out of ids"),
            |candidate| candidate == "main1" || candidate == "main2",
        );

        assert_eq!(label, "main3");
    }
}
