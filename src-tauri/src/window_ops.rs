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

/// Exit the application. Invoked by the frontend after its own dirty-check when
/// the user picks Quit from the menu (or presses Cmd/Ctrl+Q). `app.exit` fires
/// `RunEvent::ExitRequested`, so the managers' `shutdown_all` cleanup still runs.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
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
