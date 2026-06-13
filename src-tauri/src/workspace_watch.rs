use std::collections::HashMap;
use std::mem;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use notify::event::{EventKind, MetadataKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const WORKSPACE_FS_CHANGE_EVENT: &str = "workspace:fs-change";

/// Active watchers keyed by window label: each window owns at most one watcher,
/// and watching/unwatching in one window never disturbs another window's.
#[derive(Default)]
pub struct WorkspaceWatchManager {
    active: Mutex<HashMap<String, ActiveWatcher>>,
}

impl WorkspaceWatchManager {
    /// Drop all active watchers (called on app exit). Dropping a
    /// `RecommendedWatcher` stops its notify worker threads, mirroring the other
    /// managers' `shutdown_all()` so nothing emits during teardown.
    pub fn shutdown_all(&self) {
        let removed = match self.active.lock() {
            Ok(mut active) => mem::take(&mut *active),
            Err(_) => HashMap::new(),
        };
        drop(removed);
    }

    /// Drop the destroyed window's watcher (if any), stopping its notify worker
    /// threads and releasing its fds. The entry is removed under the lock but
    /// dropped after the guard is released, since dropping a
    /// `RecommendedWatcher` can block while its worker threads shut down.
    pub fn remove_window(&self, label: &str) {
        let removed = match self.active.lock() {
            Ok(mut active) => active.remove(label),
            Err(_) => None,
        };
        drop(removed);
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
    git_changed: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct WorkspaceEventPaths {
    paths: Vec<String>,
    git_changed: bool,
}

#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WorkspaceWatchManager>,
    root: String,
) -> Result<(), String> {
    let root_path = canonical_dir(&root)?;
    // Widen the asset protocol scope to the opened workspace. The static config
    // scope is empty, so preview `asset:` URLs can only reach folders the user
    // actually opened (and workspaces outside $HOME, e.g. /tmp, work too).
    // A failure here breaks HTML preview (`asset:` URLs stay out of scope) but
    // must not break watching, so log it and continue.
    if let Err(err) = app.asset_protocol_scope().allow_directory(&root_path, true) {
        eprintln!(
            "failed to add {} to the asset protocol scope (HTML preview may not load): {err}",
            root_path.display()
        );
    }
    let label = window.label().to_string();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "workspace watcher lock poisoned".to_string())?;
    if active
        .get(&label)
        .is_some_and(|watcher| watcher.root == root_path)
    {
        return Ok(());
    }

    let event_root = root.clone();
    let watched_root = root_path.clone();
    let requested_root = PathBuf::from(&root);
    let app_for_events = app.clone();
    let label_for_events = label.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let Some(event_paths) = workspace_event_paths(&watched_root, &requested_root, &event)
        else {
            return;
        };
        let payload = WorkspaceFsEvent {
            root: event_root.clone(),
            paths: event_paths.paths,
            kind: format!("{:?}", event.kind),
            git_changed: event_paths.git_changed,
        };
        let _ = app_for_events.emit_to(
            label_for_events.as_str(),
            WORKSPACE_FS_CHANGE_EVENT,
            payload,
        );
    })
    .map_err(|e| format!("watcher setup failed: {e}"))?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("{}: {e}", root_path.display()))?;
    let next = ActiveWatcher {
        root: root_path,
        requested_root: root,
        _watcher: watcher,
    };
    let removed = active.insert(label, next);
    drop(active);
    drop(removed);
    Ok(())
}

#[tauri::command]
pub fn unwatch_workspace(
    window: tauri::Window,
    state: State<'_, WorkspaceWatchManager>,
    root: Option<String>,
) -> Result<(), String> {
    let label = window.label();
    let removed = {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "workspace watcher lock poisoned".to_string())?;
        let should_clear = match (active.get(label), root.as_deref()) {
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
            active.remove(label)
        } else {
            None
        }
    };
    drop(removed);
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
) -> Option<WorkspaceEventPaths> {
    if ignores_workspace_event_kind(&event.kind) {
        return None;
    }

    let mut git_changed = false;
    let mut paths = Vec::new();
    for path in &event.paths {
        match internal_workspace_path_kind(canonical_root, requested_root, path) {
            Some(InternalWorkspacePath::Git) => {
                git_changed = true;
            }
            Some(InternalWorkspacePath::Trash) => {}
            None => paths.push(event_path_for_requested_root(
                canonical_root,
                requested_root,
                path,
            )),
        }
    }

    if event.paths.is_empty() || !paths.is_empty() || git_changed {
        Some(WorkspaceEventPaths { paths, git_changed })
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InternalWorkspacePath {
    Git,
    Trash,
}

fn internal_workspace_path_kind(
    canonical_root: &Path,
    requested_root: &Path,
    path: &Path,
) -> Option<InternalWorkspacePath> {
    let canonical_kind = internal_path_kind_under_root(canonical_root, path);
    let requested_kind = internal_path_kind_under_root(requested_root, path);
    if matches!(canonical_kind, Some(InternalWorkspacePath::Trash))
        || matches!(requested_kind, Some(InternalWorkspacePath::Trash))
    {
        Some(InternalWorkspacePath::Trash)
    } else if matches!(canonical_kind, Some(InternalWorkspacePath::Git))
        || matches!(requested_kind, Some(InternalWorkspacePath::Git))
    {
        Some(InternalWorkspacePath::Git)
    } else {
        None
    }
}

fn internal_path_kind_under_root(root: &Path, path: &Path) -> Option<InternalWorkspacePath> {
    let Ok(relative) = path.strip_prefix(root) else {
        return None;
    };
    for component in relative.components() {
        if let Component::Normal(name) = component {
            if name == ".lyceum-trash" {
                return Some(InternalWorkspacePath::Trash);
            }
            if name == ".git" {
                return Some(InternalWorkspacePath::Git);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{event_path_for_requested_root, workspace_event_paths, WorkspaceEventPaths};
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
    };
    use notify::Event;
    use std::path::{Path, PathBuf};

    fn visible(paths: &[&str]) -> Option<WorkspaceEventPaths> {
        Some(WorkspaceEventPaths {
            paths: paths.iter().map(|path| (*path).to_string()).collect(),
            git_changed: false,
        })
    }

    fn git_only() -> Option<WorkspaceEventPaths> {
        Some(WorkspaceEventPaths {
            paths: Vec::new(),
            git_changed: true,
        })
    }

    fn visible_with_git(paths: &[&str]) -> Option<WorkspaceEventPaths> {
        Some(WorkspaceEventPaths {
            paths: paths.iter().map(|path| (*path).to_string()).collect(),
            git_changed: true,
        })
    }

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
            visible(&["/link/project/src/main.tex"])
        );
    }

    #[test]
    fn git_workspace_state_events_only_refresh_git_decorations() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/real/project/.git/index.lock"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            git_only()
        );
    }

    #[test]
    fn trash_workspace_state_events_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from(
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
            visible_with_git(&["/link/project/src/main.tex"])
        );
    }

    #[test]
    fn internal_requested_root_git_paths_only_refresh_git_decorations() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/link/project/.git/index.lock"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            git_only()
        );
    }

    #[test]
    fn git_paths_with_later_trash_component_still_refresh_git_decorations() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/real/project/.git/.lyceum-trash/file"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            git_only()
        );
    }

    #[test]
    fn trash_paths_with_later_git_component_do_not_refresh_workspace() {
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from(
            "/real/project/.lyceum-trash/batch/.git/index",
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
}
