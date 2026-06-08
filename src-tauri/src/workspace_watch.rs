use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use notify::event::{EventKind, MetadataKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const WORKSPACE_FS_CHANGE_EVENT: &str = "workspace:fs-change";

#[derive(Default)]
pub struct WorkspaceWatchManager {
    active: Mutex<Option<ActiveWatcher>>,
}

impl WorkspaceWatchManager {
    /// Drop the active watcher (called on app exit). Dropping the
    /// `RecommendedWatcher` stops its notify worker threads, mirroring the other
    /// managers' `shutdown_all()` so nothing emits during teardown.
    pub fn shutdown_all(&self) {
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
    }
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

    let event_root = root.clone();
    let watched_root = root_path.clone();
    let requested_root = PathBuf::from(&root);
    let app_for_events = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let Some(paths) = workspace_event_paths(&watched_root, &requested_root, &event) else {
            return;
        };
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

fn event_path_for_requested_root(
    canonical_root: &Path,
    requested_root: &Path,
    path: &Path,
) -> String {
    match path.strip_prefix(canonical_root) {
        Ok(relative) => requested_root.join(relative).to_string_lossy().to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

// Only visible workspace mutations should drive Explorer refreshes. Read-only
// filesystem activity and internal Git/trash bookkeeping can otherwise feed
// back into the watcher and make the tree reload continuously.
fn workspace_event_paths(
    canonical_root: &Path,
    requested_root: &Path,
    event: &notify::Event,
) -> Option<Vec<String>> {
    if ignores_workspace_event_kind(&event.kind) {
        return None;
    }

    let paths: Vec<String> = event
        .paths
        .iter()
        .filter(|path| !is_internal_workspace_path(canonical_root, requested_root, path))
        .map(|path| event_path_for_requested_root(canonical_root, requested_root, path))
        .collect();

    if event.paths.is_empty() || !paths.is_empty() {
        Some(paths)
    } else {
        None
    }
}

fn ignores_workspace_event_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))
    )
}

fn is_internal_workspace_path(canonical_root: &Path, requested_root: &Path, path: &Path) -> bool {
    is_internal_path_under_root(canonical_root, path)
        || is_internal_path_under_root(requested_root, path)
}

fn is_internal_path_under_root(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().any(|component| {
        matches!(
            component,
            Component::Normal(name) if name == ".git" || name == ".lyceum-trash"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{event_path_for_requested_root, workspace_event_paths};
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
    };
    use notify::Event;
    use std::path::{Path, PathBuf};

    #[test]
    fn event_path_is_reported_under_requested_workspace_root() {
        let mapped = event_path_for_requested_root(
            Path::new("/real/project"),
            Path::new("/link/project"),
            Path::new("/real/project/src/main.tex"),
        );

        assert_eq!(mapped, "/link/project/src/main.tex");
    }

    #[test]
    fn event_path_outside_watched_root_is_left_unchanged() {
        let mapped = event_path_for_requested_root(
            Path::new("/real/project"),
            Path::new("/link/project"),
            Path::new("/tmp/other.tex"),
        );

        assert_eq!(mapped, "/tmp/other.tex");
    }

    #[test]
    fn access_events_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Access(AccessKind::Open(AccessMode::Read)))
            .add_path(PathBuf::from("/real/project/src/main.tex"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            None
        );
    }

    #[test]
    fn access_time_metadata_events_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::AccessTime,
        )))
        .add_path(PathBuf::from("/real/project/src/main.tex"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            None
        );
    }

    #[test]
    fn content_events_refresh_workspace() {
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(PathBuf::from("/real/project/src/main.tex"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            Some(vec!["/link/project/src/main.tex".to_string()])
        );
    }

    #[test]
    fn internal_workspace_state_events_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/real/project/.git/index.lock"))
            .add_path(PathBuf::from(
                "/real/project/.lyceum-trash/batch-1/file.tex",
            ));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            None
        );
    }

    #[test]
    fn mixed_internal_and_visible_events_keep_visible_paths() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/real/project/.git/index.lock"))
            .add_path(PathBuf::from("/real/project/src/main.tex"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            Some(vec!["/link/project/src/main.tex".to_string()])
        );
    }

    #[test]
    fn internal_requested_root_paths_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/link/project/.git/index.lock"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            None
        );
    }
}
