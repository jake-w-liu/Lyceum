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

fn label_sequence(label: &str) -> Option<u64> {
    if label == "main" {
        return Some(0);
    }
    label.strip_prefix("main")?.parse().ok()
}

fn adjacent_window_label<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    focused: Option<&str>,
    direction: i8,
) -> Option<String> {
    let mut labels: Vec<&str> = labels.into_iter().collect();
    labels.sort_unstable_by(
        |left, right| match (label_sequence(left), label_sequence(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.cmp(right),
        },
    );
    if labels.len() < 2 {
        return None;
    }

    let current = focused.and_then(|focused| labels.iter().position(|label| *label == focused));
    let next = match (current, direction < 0) {
        (Some(current), true) => (current + labels.len() - 1) % labels.len(),
        (Some(current), false) => (current + 1) % labels.len(),
        // No eligible focused window (app inactive, focus on a minimized
        // window, etc.). Land on the first/last window in the cycle set.
        (None, true) => labels.len() - 1,
        (None, false) => 0,
    };
    Some(labels[next].to_string())
}

/// Whether a window may participate in keyboard window cycling.
///
/// Matches macOS AppKit / VS Code: a miniaturized window stays in the Dock and
/// is not reached by Cmd+` / Cmd+Shift+` until the user restores it (Dock,
/// Window menu, Mission Control, etc.).
fn is_cycle_eligible<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    !window.is_minimized().unwrap_or(false)
}

pub fn focus_adjacent_window<R: Runtime>(app: &AppHandle<R>, direction: i8) -> Result<(), String> {
    let windows = app.webview_windows();
    let focused = windows
        .iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.as_str());
    // Only non-minimized windows. Including miniaturized ones and calling
    // unminimize() made Cmd+` restore windows the user deliberately hid with
    // the yellow traffic light — unlike VS Code and native macOS apps.
    let cycle_labels: Vec<&str> = windows
        .iter()
        .filter(|(_, window)| is_cycle_eligible(window))
        .map(|(label, _)| label.as_str())
        .collect();
    let Some(label) = adjacent_window_label(cycle_labels, focused, direction) else {
        return Ok(());
    };
    let window = windows
        .get(&label)
        .ok_or_else(|| format!("window {label} disappeared before it could be focused"))?;
    // Target is already non-minimized (filtered above). Do not unminimize —
    // that would reintroduce minimized windows into the cycle path.
    window.show().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn focus_window_relative(app: AppHandle, direction: i8) -> Result<(), String> {
    if direction != -1 && direction != 1 {
        return Err("window focus direction must be -1 or 1".to_string());
    }
    focus_adjacent_window(&app, direction)
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
    use super::{
        adjacent_window_label, next_available_window_label, prepare_then_build, window_label,
    };
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
    fn adjacent_window_labels_follow_creation_order_and_wrap() {
        let labels = ["main10", "main2", "main", "utility"];

        assert_eq!(
            adjacent_window_label(labels, Some("main2"), 1).as_deref(),
            Some("main10")
        );
        assert_eq!(
            adjacent_window_label(labels, Some("utility"), 1).as_deref(),
            Some("main")
        );
        assert_eq!(
            adjacent_window_label(labels, Some("main"), -1).as_deref(),
            Some("utility")
        );
    }

    #[test]
    fn adjacent_window_label_is_noop_without_an_alternative() {
        assert_eq!(adjacent_window_label(["main"], Some("main"), 1), None);
        assert_eq!(adjacent_window_label([], None, -1), None);
    }

    #[test]
    fn adjacent_window_label_selects_an_endpoint_without_a_focused_window() {
        let labels = ["main2", "main", "main1"];

        assert_eq!(
            adjacent_window_label(labels, None, 1).as_deref(),
            Some("main")
        );
        assert_eq!(
            adjacent_window_label(labels, None, -1).as_deref(),
            Some("main2")
        );
    }

    #[test]
    fn window_cycle_skips_minimized_windows_when_caller_filters_them() {
        // focus_adjacent_window only passes non-minimized labels. If the only
        // other window is minimized, the cycle set has a single entry and
        // must be a no-op — never deminiaturize via this path.
        assert_eq!(
            adjacent_window_label(["main"], Some("main"), 1),
            None
        );
        // Two visible windows still cycle; a third miniaturized label is simply
        // omitted by the caller before this helper runs.
        assert_eq!(
            adjacent_window_label(["main", "main1"], Some("main"), 1).as_deref(),
            Some("main1")
        );
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
