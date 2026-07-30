use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

static WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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

/// Reserve a unique label before a native window is built. Callers that need to
/// publish per-window startup state must do so after this reservation and before
/// `open_new_window_with_label`; otherwise the WebView can mount and consume the
/// state before it has been recorded.
pub(crate) fn reserve_window_label<R: Runtime>(app: &AppHandle<R>) -> String {
    next_window_label(app)
}

pub(crate) fn open_new_window_with_label<R: Runtime>(
    app: &AppHandle<R>,
    label: String,
) -> Result<WebviewWindow<R>, String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "missing app window configuration".to_string())?;

    config.label = label;
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    Ok(window)
}

fn prepare_then_build<T>(
    label: &str,
    prepare: impl FnOnce(&str) -> Result<(), String>,
    build: impl FnOnce() -> Result<T, String>,
    rollback: impl FnOnce(&str),
) -> Result<T, String> {
    prepare(label)?;
    match build() {
        Ok(window) => Ok(window),
        Err(error) => {
            rollback(label);
            Err(error)
        }
    }
}

pub(crate) fn open_new_window_prepared<R: Runtime>(
    app: &AppHandle<R>,
    prepare: impl FnOnce(&str) -> Result<(), String>,
    rollback: impl FnOnce(&str),
) -> Result<WebviewWindow<R>, String> {
    let label = reserve_window_label(app);
    prepare_then_build(
        &label,
        prepare,
        || open_new_window_with_label(app, label.clone()),
        rollback,
    )
}

pub fn open_new_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    open_new_window_prepared(app, |_| Ok(()), |_| {})
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
/// (handled by the run loop's last-window invariant). The calling window has
/// already been dirty-checked and had its settings flushed by the `quit` command,
/// so we destroy it directly rather than re-firing its guard.
#[tauri::command]
pub fn quit_app(window: WebviewWindow, app: AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::{next_available_window_label, prepare_then_build, window_label};
    use std::cell::RefCell;

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

    #[test]
    fn prepared_window_state_precedes_build() {
        let events = RefCell::new(Vec::new());

        let result = prepare_then_build(
            "main4",
            |label| {
                events.borrow_mut().push(format!("prepare:{label}"));
                Ok(())
            },
            || {
                events.borrow_mut().push("build".to_string());
                Ok(())
            },
            |_| events.borrow_mut().push("rollback".to_string()),
        );

        assert_eq!(result, Ok(()));
        assert_eq!(events.into_inner(), ["prepare:main4", "build"]);
    }

    #[test]
    fn failed_prepared_window_build_rolls_back_state() {
        let events = RefCell::new(Vec::new());

        let result: Result<(), String> = prepare_then_build(
            "main5",
            |label| {
                events.borrow_mut().push(format!("prepare:{label}"));
                Ok(())
            },
            || {
                events.borrow_mut().push("build".to_string());
                Err("build failed".to_string())
            },
            |label| events.borrow_mut().push(format!("rollback:{label}")),
        );

        assert_eq!(result, Err("build failed".to_string()));
        assert_eq!(
            events.into_inner(),
            ["prepare:main5", "build", "rollback:main5"]
        );
    }
}
