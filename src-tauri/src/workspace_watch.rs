use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const WORKSPACE_FS_CHANGE_EVENT: &str = "workspace:fs-change";

#[derive(Default)]
pub struct WorkspaceWatchManager {
    active: Mutex<Option<ActiveWatcher>>,
}

struct ActiveWatcher {
    root: PathBuf,
    requested_root: String,
    _watcher: RecommendedWatcher,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsEvent {
    root: String,
    paths: Vec<String>,
    kind: String,
}

#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: State<'_, WorkspaceWatchManager>,
    root: String,
) -> Result<(), String> {
    let root_path = canonical_dir(&root)?;
    let mut active = state
        .active
        .lock()
        .map_err(|_| "workspace watcher lock poisoned".to_string())?;
    if active
        .as_ref()
        .is_some_and(|watcher| watcher.root == root_path)
    {
        return Ok(());
    }

    let event_root = root_path.to_string_lossy().to_string();
    let app_for_events = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let paths = event
            .paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        let payload = WorkspaceFsEvent {
            root: event_root.clone(),
            paths,
            kind: format!("{:?}", event.kind),
        };
        let _ = app_for_events.emit(WORKSPACE_FS_CHANGE_EVENT, payload);
    })
    .map_err(|e| format!("watcher setup failed: {e}"))?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("{}: {e}", root_path.display()))?;
    *active = Some(ActiveWatcher {
        root: root_path,
        requested_root: root,
        _watcher: watcher,
    });
    Ok(())
}

#[tauri::command]
pub fn unwatch_workspace(
    state: State<'_, WorkspaceWatchManager>,
    root: Option<String>,
) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "workspace watcher lock poisoned".to_string())?;
    let should_clear = match (active.as_ref(), root.as_deref()) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(watcher), Some(root)) => {
            watcher.requested_root == root
                || Path::new(root)
                    .canonicalize()
                    .ok()
                    .is_some_and(|path| path == watcher.root)
        }
    };
    if should_clear {
        *active = None;
    }
    Ok(())
}

fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let root = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    Ok(root)
}
