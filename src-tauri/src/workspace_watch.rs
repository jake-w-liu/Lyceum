use std::collections::{HashMap, HashSet};
use std::mem;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use notify::event::{EventKind, MetadataKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::git;
use crate::path_access::{self, PathAccessManager};
use crate::workspace_paths::{
    path_resolves_into_workspace_trash, path_resolves_through_workspace_name,
    path_resolves_through_workspace_names, INDEX_EXCLUDED_DIRS,
};

const WORKSPACE_FS_CHANGE_EVENT: &str = "workspace:fs-change";
static WATCH_FLOW_SEQ: AtomicU64 = AtomicU64::new(1);

/// Active watchers keyed by window label: each window owns at most one watcher,
/// and watching/unwatching in one window never disturbs another window's.
#[derive(Default)]
pub struct WorkspaceWatchManager {
    state: Mutex<WorkspaceWatchState>,
}

#[derive(Default)]
struct WorkspaceWatchState {
    active: HashMap<String, ActiveWatcher>,
    /// Watch setups run without the state lock because notify::watch can block.
    /// The token lets unwatch/window teardown invalidate an in-flight setup so it
    /// cannot install a watcher after its owner has already gone away.
    pending: HashMap<String, PendingWatcher>,
    /// Window labels in this app are monotonic and never reused. Remembering a
    /// destroyed label prevents a watch command that was still canonicalizing
    /// its root from claiming state after `remove_window` already ran.
    removed_windows: HashSet<String>,
    shutting_down: bool,
}

struct PendingWatcher {
    root: PathBuf,
    requested_root: String,
    cancelled: Arc<AtomicBool>,
}

impl WorkspaceWatchManager {
    /// Drop all active watchers (called on app exit). Dropping a
    /// `RecommendedWatcher` stops its notify worker threads and releases the
    /// sender feeding its coalescer, which then ends its own current merge
    /// window and exits. A coalescer mid-window may still emit once afterwards;
    /// that is a no-op, because emitting onto a closing runtime just fails and
    /// is discarded.
    pub fn shutdown_all(&self) {
        let removed = match self.state.lock() {
            Ok(mut state) => {
                state.shutting_down = true;
                for pending in state.pending.drain().map(|(_, pending)| pending) {
                    pending.cancelled.store(true, Ordering::Release);
                }
                mem::take(&mut state.active)
            }
            Err(_) => HashMap::new(),
        };
        drop(removed);
    }

    /// Drop the destroyed window's watcher (if any), stopping its notify worker
    /// threads and releasing its fds. The entry is removed under the lock but
    /// dropped after the guard is released, since dropping a
    /// `RecommendedWatcher` can block while its worker threads shut down.
    pub fn remove_window(&self, label: &str) {
        let removed = match self.state.lock() {
            Ok(mut state) => {
                state.removed_windows.insert(label.to_string());
                if let Some(pending) = state.pending.remove(label) {
                    pending.cancelled.store(true, Ordering::Release);
                }
                state.active.remove(label)
            }
            Err(_) => None,
        };
        drop(removed);
    }
}

struct ActiveWatcher {
    root: PathBuf,
    requested_root: String,
    watch_id: u64,
    output_flow: Arc<crate::output_flow::OutputFlow>,
    _watcher: RecommendedWatcher,
}

impl Drop for ActiveWatcher {
    fn drop(&mut self) {
        self.output_flow.cancel();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsEvent {
    root: String,
    paths: Vec<String>,
    kind: String,
    git_changed: bool,
    /// The bounded path accumulator overflowed while the WebView was asleep.
    /// The frontend must reload every open document instead of only `paths`.
    rescan: bool,
    /// Generation-safe acknowledgement token for this watcher.
    watch_id: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct WorkspaceEventPaths {
    paths: Vec<String>,
    git_changed: bool,
}

/// How long the coalescer keeps merging filesystem notifications before it
/// emits. Shorter than the frontend's own 150 ms refresh debounce, so merging
/// adds no perceptible delay to the Explorer/Git refresh it feeds.
const FS_EVENT_COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_millis(100);
/// Stop merging once a batch carries this many paths and emit what we have. The
/// rest of the burst simply lands in the next batch — nothing is dropped.
const MAX_COALESCED_PATHS: usize = 2048;
/// Queue depth between the notify worker and the coalescer. A full queue blocks
/// only that watcher's own worker thread, which is correct backpressure: the
/// producer is the filesystem, and the UI thread is never involved.
const FS_EVENT_QUEUE_CAPACITY: usize = 4096;
/// `kind` on a merged event. The field is part of the published payload but the
/// frontend keys off `paths`/`gitChanged` only, so a burst of mixed kinds needs
/// no per-kind fidelity.
const COALESCED_EVENT_KIND: &str = "Coalesced";

/// Merge every notification that arrives within `window` into one payload,
/// de-duplicating paths and OR-ing `git_changed`.
///
/// This is behaviour-preserving for the frontend: it refreshes the tree when a
/// batch has any path (or is a pathless native event) and refreshes Git when any
/// merged event touched Git metadata — exactly the union of what the individual
/// events would have produced.
fn coalesce_fs_events(
    rx: &std::sync::mpsc::Receiver<WorkspaceEventPaths>,
    first: WorkspaceEventPaths,
    window: std::time::Duration,
    max_paths: usize,
) -> WorkspaceEventPaths {
    fn absorb(incoming: Vec<String>, seen: &mut HashSet<String>, paths: &mut Vec<String>) {
        for path in incoming {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }

    let mut git_changed = first.git_changed;
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    absorb(first.paths, &mut seen, &mut paths);

    let deadline = std::time::Instant::now() + window;
    // The cap is checked per event, not per path, so an event that is accepted
    // always contributes all of its paths.
    while paths.len() < max_paths {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(event) => {
                git_changed |= event.git_changed;
                absorb(event.paths, &mut seen, &mut paths);
            }
            // Timeout: the filesystem went quiet, emit now. Disconnected: the
            // watcher is gone, emit the tail and let the caller's `recv` end the
            // coalescer thread.
            Err(_) => break,
        }
    }
    WorkspaceEventPaths { paths, git_changed }
}

/// Start the coalescer for one watcher and return the sender its notify callback
/// writes to. The thread ends on its own when the watcher (and therefore the
/// closure holding the sender) is dropped, so it needs no separate teardown.
fn spawn_fs_event_coalescer(
    app: AppHandle,
    label: String,
    root: String,
    watch_id: u64,
    output_flow: Arc<crate::output_flow::OutputFlow>,
) -> std::sync::mpsc::SyncSender<WorkspaceEventPaths> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<WorkspaceEventPaths>(FS_EVENT_QUEUE_CAPACITY);
    let label_for_error = label.clone();
    let spawned = std::thread::Builder::new()
        .name("lyceum-fs-coalesce".to_string())
        .spawn(move || {
            let mut pending: Option<(Vec<String>, HashSet<String>, bool, bool)> = None;
            loop {
                if pending.is_none() {
                    let Ok(first) = rx.recv() else { break };
                    let merged = coalesce_fs_events(
                        &rx,
                        first,
                        FS_EVENT_COALESCE_WINDOW,
                        MAX_COALESCED_PATHS,
                    );
                    let rescan = merged.paths.len() > MAX_COALESCED_PATHS;
                    let seen = if rescan {
                        HashSet::new()
                    } else {
                        merged.paths.iter().cloned().collect()
                    };
                    pending = Some((
                        if rescan { Vec::new() } else { merged.paths },
                        seen,
                        merged.git_changed,
                        rescan,
                    ));
                }

                if output_flow.try_reserve() {
                    let Some((paths, _, git_changed, rescan)) = pending.take() else {
                        output_flow.acknowledge(1);
                        continue;
                    };
                    if app
                        .emit_to(
                            label.as_str(),
                            WORKSPACE_FS_CHANGE_EVENT,
                            WorkspaceFsEvent {
                                root: root.clone(),
                                paths,
                                kind: COALESCED_EVENT_KIND.to_string(),
                                git_changed,
                                rescan,
                                watch_id,
                            },
                        )
                        .is_err()
                    {
                        output_flow.acknowledge(1);
                        break;
                    }
                    continue;
                }
                if output_flow.is_cancelled() {
                    break;
                }

                // JavaScript has not acknowledged the prior event. Keep
                // consuming native notifications and fold them into one bounded
                // pending payload instead of filling either the Rust channel or
                // Tauri's unbounded WebView queue.
                let first = match rx.recv_timeout(FS_EVENT_COALESCE_WINDOW) {
                    Ok(first) => first,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let merged =
                    coalesce_fs_events(&rx, first, FS_EVENT_COALESCE_WINDOW, MAX_COALESCED_PATHS);
                if let Some((paths, seen, git_changed, rescan)) = pending.as_mut() {
                    *git_changed |= merged.git_changed;
                    if !*rescan {
                        for path in merged.paths {
                            if seen.insert(path.clone()) {
                                paths.push(path);
                                if paths.len() > MAX_COALESCED_PATHS {
                                    paths.clear();
                                    seen.clear();
                                    *rescan = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        });
    if spawned.is_err() {
        // Thread creation failed (OS limit). Returning the sender anyway is safe:
        // with no receiver every `send` fails immediately, so the watcher runs
        // without change notifications rather than blocking its notify worker.
        eprintln!("failed to start workspace fs-event coalescer for {label_for_error}");
    }
    tx
}

#[tauri::command(async)]
pub fn watch_workspace(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WorkspaceWatchManager>,
    access: State<'_, PathAccessManager>,
    root: String,
) -> Result<(), String> {
    let root_path = canonical_dir(&root)?;
    let label = window.label().to_string();
    // Dedup check under the lock, then RELEASE it before building the watcher.
    // notify's recursive `watch()` is synchronous and can block for a noticeable
    // time (large trees, network/FUSE mounts, slow disks). Holding `active`
    // across it would stall every other holder of this lock — most importantly
    // `remove_window`, which runs on the main UI thread when ANY window is
    // destroyed — freezing the app until the slow setup finishes.
    let pending_token = {
        let mut watch_state = state
            .state
            .lock()
            .map_err(|_| "workspace watcher lock poisoned".to_string())?;
        if watch_state
            .active
            .get(&label)
            .is_some_and(|watcher| watcher.root == root_path)
        {
            // A slower setup for another root may still be pending even though
            // the requested root is already active. This newest request wins:
            // invalidate the stale setup before returning success.
            if let Some(previous) = watch_state.pending.remove(&label) {
                previous.cancelled.store(true, Ordering::Release);
            }
            return Ok(());
        }
        let Some(token) =
            claim_pending_watch(&mut watch_state, &label, root_path.clone(), root.clone())
        else {
            return Ok(());
        };
        token
    };

    if let Err(error) = path_access::authorize_workspace_root_for_watcher_impl(
        &app,
        &label,
        &access,
        root_path.clone(),
    ) {
        remove_pending_watch(&state, &label, &pending_token);
        // A superseded same-root setup may already have authorized this root,
        // then deferred its own revoke because this newer setup was pending.
        // Authorization failed before this setup inserted anything, but it must
        // still release that inherited grant when no active/newer setup needs
        // it; otherwise a failed watch leaves stale IPC access behind.
        revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
        return Err(error);
    }
    if !pending_watch_is_current(&state, &label, &pending_token) {
        revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
        return Ok(());
    }

    let watched_root = root_path.clone();
    let requested_root = PathBuf::from(&root);
    let external_git_roots = external_git_metadata_roots(&root_path);
    let event_git_roots = external_git_roots.clone();
    // Hand filtered events to a coalescing thread instead of emitting straight
    // from the notify callback. Every Tauri event is a `webview.eval()` posted
    // to the UI thread through an unbounded queue, so one event per filesystem
    // notification let a build (or an npm install) inside the workspace enqueue
    // thousands of script evaluations and freeze the window. The frontend
    // already debounces these by 150 ms, so merging them costs it nothing.
    let watch_id = WATCH_FLOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let output_flow = Arc::new(crate::output_flow::OutputFlow::new(1));
    let events_tx = spawn_fs_event_coalescer(
        app.clone(),
        label.clone(),
        root.clone(),
        watch_id,
        output_flow.clone(),
    );
    let watcher_result =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            let Some(event_paths) = workspace_event_paths_with_git_roots(
                &watched_root,
                &requested_root,
                &event_git_roots,
                &event,
            ) else {
                return;
            };
            // A full queue means the coalescer is still merging a burst; the
            // send blocks only that watcher's own notify worker, never the UI.
            let _ = events_tx.send(event_paths);
        });
    let mut watcher = match watcher_result {
        Ok(watcher) => watcher,
        Err(error) => {
            remove_pending_watch(&state, &label, &pending_token);
            revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
            return Err(format!("watcher setup failed: {error}"));
        }
    };

    // Slow, blocking setup happens with NO lock held.
    if let Err(error) = watcher.watch(&root_path, RecursiveMode::Recursive) {
        remove_pending_watch(&state, &label, &pending_token);
        revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
        return Err(format!("{}: {error}", root_path.display()));
    }
    for git_root in &external_git_roots {
        if let Err(error) = watcher.watch(git_root, RecursiveMode::Recursive) {
            remove_pending_watch(&state, &label, &pending_token);
            revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
            return Err(format!(
                "failed to watch Git metadata at {}: {error}",
                git_root.display()
            ));
        }
    }
    let next = ActiveWatcher {
        root: root_path.clone(),
        requested_root: root.clone(),
        watch_id,
        output_flow,
        _watcher: watcher,
    };
    // Re-acquire only to install the finished watcher, re-checking the dedup in
    // case a concurrent call already installed an identical one for this label.
    let mut watch_state = state
        .state
        .lock()
        .map_err(|_| "workspace watcher lock poisoned".to_string())?;
    let still_current = watch_state.pending.get(&label).is_some_and(|pending| {
        Arc::ptr_eq(&pending.cancelled, &pending_token)
            && !pending.cancelled.load(Ordering::Acquire)
    });
    if !still_current {
        // An unwatch/window-destroy/newer-watch invalidated this slow setup. Drop
        // the just-started notify threads and undo only this stale authorization.
        drop(watch_state);
        drop(next);
        revoke_watch_access_if_unused(&app, &access, &state, &label, &root_path);
        return Ok(());
    }
    watch_state.pending.remove(&label);
    let removed = watch_state.active.insert(label, next);
    if let Some(previous) = removed.as_ref() {
        if previous.root != root_path {
            // The new watcher supersedes a different workspace. Release every
            // grant for the old canonical root while claims are serialized by
            // `state`; grants for the newly active root remain untouched.
            let _ = path_access::revoke_workspace_root_canonical_impl(
                &app,
                window.label(),
                &access,
                Some(&previous.root),
            );
        }
    }
    drop(watch_state);
    drop(removed);
    Ok(())
}

#[tauri::command(async)]
pub fn unwatch_workspace(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WorkspaceWatchManager>,
    access: State<'_, PathAccessManager>,
    root: Option<String>,
) -> Result<(), String> {
    let label = window.label();
    let removed = {
        let mut watch_state = state
            .state
            .lock()
            .map_err(|_| "workspace watcher lock poisoned".to_string())?;
        let should_clear = match (watch_state.active.get(label), root.as_deref()) {
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
        let should_cancel_pending = match (watch_state.pending.get(label), root.as_deref()) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(pending), Some(root)) => {
                pending.requested_root == root
                    || Path::new(root)
                        .canonicalize()
                        .ok()
                        .is_some_and(|path| path == pending.root)
            }
        };
        let mut canonical_roots = HashSet::new();
        if should_clear {
            if let Some(active) = watch_state.active.get(label) {
                canonical_roots.insert(active.root.clone());
            }
        }
        if should_cancel_pending {
            if let Some(pending) = watch_state.pending.get(label) {
                canonical_roots.insert(pending.root.clone());
            }
        }
        // With no matching state, a still-existing requested path can identify
        // a leftover grant. If its symlink disappeared, matching state above
        // supplies the stored canonical identity instead.
        if canonical_roots.is_empty() {
            if let Some(canonical) = root
                .as_deref()
                .and_then(|requested| Path::new(requested).canonicalize().ok())
            {
                canonical_roots.insert(canonical);
            }
        }
        if should_cancel_pending {
            if let Some(pending) = watch_state.pending.remove(label) {
                pending.cancelled.store(true, Ordering::Release);
            }
        }
        let removed = if should_clear {
            watch_state.active.remove(label)
        } else {
            None
        };
        // Keep the watcher-state guard through revocation. A same-root setup
        // cannot claim between state removal and grant removal. A completed
        // workspace unwatch owns both direct-command and watcher grants.
        if root.is_none() {
            path_access::revoke_workspace_root_canonical_impl(&app, label, &access, None)?;
        } else {
            for canonical_root in &canonical_roots {
                path_access::revoke_workspace_root_canonical_impl(
                    &app,
                    label,
                    &access,
                    Some(canonical_root),
                )?;
            }
        }
        removed
    };
    drop(removed);
    Ok(())
}

/// Acknowledge the latest coalesced filesystem event. `watch_id` prevents a
/// delayed callback from an old root/generation from releasing the new watcher.
#[tauri::command]
pub fn workspace_watch_ack(
    window: tauri::Window,
    state: State<'_, WorkspaceWatchManager>,
    watch_id: u64,
) -> Result<(), String> {
    let flow = state
        .state
        .lock()
        .map_err(|_| "workspace watcher lock poisoned".to_string())?
        .active
        .get(window.label())
        .filter(|watcher| watcher.watch_id == watch_id)
        .map(|watcher| watcher.output_flow.clone());
    if let Some(flow) = flow {
        flow.acknowledge(1);
    }
    Ok(())
}

fn pending_watch_is_current(
    manager: &WorkspaceWatchManager,
    label: &str,
    token: &Arc<AtomicBool>,
) -> bool {
    manager.state.lock().ok().is_some_and(|state| {
        state.pending.get(label).is_some_and(|pending| {
            Arc::ptr_eq(&pending.cancelled, token) && !pending.cancelled.load(Ordering::Acquire)
        })
    })
}

fn claim_pending_watch(
    state: &mut WorkspaceWatchState,
    label: &str,
    root: PathBuf,
    requested_root: String,
) -> Option<Arc<AtomicBool>> {
    if state.shutting_down || state.removed_windows.contains(label) {
        return None;
    }
    let token = Arc::new(AtomicBool::new(false));
    if let Some(previous) = state.pending.insert(
        label.to_string(),
        PendingWatcher {
            root,
            requested_root,
            cancelled: token.clone(),
        },
    ) {
        previous.cancelled.store(true, Ordering::Release);
    }
    Some(token)
}

fn remove_pending_watch(manager: &WorkspaceWatchManager, label: &str, token: &Arc<AtomicBool>) {
    let Ok(mut state) = manager.state.lock() else {
        token.store(true, Ordering::Release);
        return;
    };
    if state
        .pending
        .get(label)
        .is_some_and(|pending| Arc::ptr_eq(&pending.cancelled, token))
    {
        if let Some(pending) = state.pending.remove(label) {
            pending.cancelled.store(true, Ordering::Release);
        }
    }
}

fn revoke_watch_access_if_unused(
    app: &AppHandle,
    access: &State<'_, PathAccessManager>,
    manager: &WorkspaceWatchManager,
    label: &str,
    canonical_root: &Path,
) {
    // A newer concurrent setup may target the same root. Remove this watcher-
    // owned grant only when no active or pending watcher still needs it; direct
    // editor/LSP grants for the same root are intentionally preserved.
    with_unused_watch_access(manager, label, canonical_root, || {
        // Do not release `state` before revoking: a new same-root setup must not
        // claim/authorize in the check-to-revoke gap and lose its fresh grant.
        let _ = path_access::revoke_workspace_root_for_watcher_impl(
            app,
            label,
            access,
            Some(canonical_root),
        );
    });
}

fn with_unused_watch_access(
    manager: &WorkspaceWatchManager,
    label: &str,
    canonical_root: &Path,
    revoke: impl FnOnce(),
) {
    let Ok(state) = manager.state.lock() else {
        return;
    };
    if !watch_access_is_needed_in_state(&state, label, canonical_root) {
        revoke();
    }
}

fn watch_access_is_needed_in_state(
    state: &WorkspaceWatchState,
    label: &str,
    canonical_root: &Path,
) -> bool {
    state
        .active
        .get(label)
        .is_some_and(|watcher| watcher.root == canonical_root)
        || state
            .pending
            .get(label)
            .is_some_and(|watcher| watcher.root == canonical_root)
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

/// Git metadata normally lives at `<workspace>/.git`, where the recursive
/// workspace watch already sees it. A workspace can also be a subdirectory of
/// a larger repository or a linked worktree; in those cases the owning Git
/// directory is outside the visible tree and needs its own watch registration.
fn external_git_metadata_roots(root: &Path) -> Vec<PathBuf> {
    git::repo_git_dir(root)
        .filter(|git_dir| !git_dir.starts_with(root))
        .into_iter()
        .collect()
}

fn event_path_for_requested_root(
    canonical_root: &Path,
    requested_root: &Path,
    path: &Path,
) -> String {
    match path.strip_prefix(canonical_root) {
        Ok(relative) => join_requested_root_text(requested_root, relative),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

fn join_requested_root_text(requested_root: &Path, relative: &Path) -> String {
    let root = requested_root.to_string_lossy();
    let separator = if root.contains('/') && !root.contains('\\') {
        "/"
    } else {
        std::path::MAIN_SEPARATOR_STR
    };
    let mut out = root.trim_end_matches(['/', '\\']).to_string();
    // A root that is purely separators (e.g. the filesystem root "/") trims to
    // "", which would drop the leading separator and emit a RELATIVE event path
    // that never matches an open doc's absolute path. Seed the leading separator
    // so descendants of such a root stay absolute.
    if out.is_empty() && !root.is_empty() {
        out.push_str(separator);
    }
    for component in relative.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        if !out.is_empty() && !out.ends_with('/') && !out.ends_with('\\') {
            out.push_str(separator);
        }
        out.push_str(&name.to_string_lossy());
    }
    if out.is_empty() {
        root.to_string()
    } else {
        out
    }
}

// Only visible workspace mutations should drive Explorer refreshes. Read-only
// filesystem activity and internal Git/trash bookkeeping can otherwise feed
// back into the watcher and make the tree reload continuously.
#[cfg(test)]
fn workspace_event_paths(
    canonical_root: &Path,
    requested_root: &Path,
    event: &notify::Event,
) -> Option<WorkspaceEventPaths> {
    workspace_event_paths_with_git_roots(canonical_root, requested_root, &[], event)
}

fn workspace_event_paths_with_git_roots(
    canonical_root: &Path,
    requested_root: &Path,
    external_git_roots: &[PathBuf],
    event: &notify::Event,
) -> Option<WorkspaceEventPaths> {
    if ignores_workspace_event_kind(&event.kind) {
        return None;
    }

    // An empty native event does not identify which registered watch emitted
    // it. If this watcher has an external Git root, conservatively refresh both
    // the tree (the existing empty-event behavior) and Git decorations.
    let mut git_changed = event.paths.is_empty() && !external_git_roots.is_empty();
    let mut paths = Vec::new();
    for path in &event.paths {
        if external_git_roots
            .iter()
            .any(|git_root| path == git_root || path.starts_with(git_root))
        {
            git_changed = true;
            continue;
        }
        if path_is_in_index_excluded_dir(canonical_root, path) {
            continue;
        }
        match internal_workspace_path_kind(canonical_root, requested_root, path) {
            Some(InternalWorkspacePath::Git) => {
                git_changed = true;
            }
            Some(InternalWorkspacePath::AmbiguousGit) => {
                git_changed = true;
                paths.push(event_path_for_requested_root(
                    canonical_root,
                    requested_root,
                    path,
                ));
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

/// Cheaply classify paths inside the same high-churn trees that quick-open,
/// search, and Git discovery exclude.
///
/// The common descendant case is purely lexical: doing canonicalize/stat work
/// for every compiler notification was itself enough to saturate a core. A leaf
/// named `target` is checked with metadata so an ordinary file with that name
/// remains visible. Case-only aliases take the slower identity-aware route only
/// when their spelling actually resembles an excluded name; this preserves
/// distinct uppercase directories on case-sensitive filesystems.
fn path_is_in_index_excluded_dir(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(component) = component else {
            continue;
        };
        let Some(name) = component.to_str() else {
            continue;
        };
        // Git/trash bookkeeping has stricter semantics than generated-tree
        // suppression. Let the identity-aware classifier below handle it even
        // when a later component happens to be named `target` or `dist`.
        if name.eq_ignore_ascii_case(".git")
            || name.eq_ignore_ascii_case(crate::workspace_paths::LYCEUM_TRASH_DIR)
        {
            return false;
        }
        if INDEX_EXCLUDED_DIRS.contains(&name) {
            return components.peek().is_some() || path.is_dir();
        }
        if INDEX_EXCLUDED_DIRS
            .iter()
            .any(|excluded| name.eq_ignore_ascii_case(excluded))
        {
            return path_resolves_through_workspace_names(root, path, &[], &INDEX_EXCLUDED_DIRS);
        }
    }
    false
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
    AmbiguousGit,
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
    } else if matches!(canonical_kind, Some(InternalWorkspacePath::AmbiguousGit))
        || matches!(requested_kind, Some(InternalWorkspacePath::AmbiguousGit))
    {
        Some(InternalWorkspacePath::AmbiguousGit)
    } else {
        None
    }
}

fn internal_path_kind_under_root(root: &Path, path: &Path) -> Option<InternalWorkspacePath> {
    if path.strip_prefix(root).is_err() {
        return None;
    }
    // Only the root trash identity is internal; an ordinary nested directory
    // with the same name remains visible. Aliases resolving into the root trash
    // are internal at any lexical depth.
    if path_resolves_into_workspace_trash(root, path) {
        return Some(InternalWorkspacePath::Trash);
    }
    if path_resolves_through_workspace_name(root, path, ".git") {
        return Some(InternalWorkspacePath::Git);
    }
    // Once a case-aliased `.git` directory has been removed, neither spelling
    // has an identity to compare. Keep the path visible (it may be a legitimate
    // `.GIT` on a case-sensitive filesystem) but conservatively refresh Git
    // decorations too.
    if path_contains_absent_ascii_case_alias(root, path, ".git") {
        return Some(InternalWorkspacePath::AmbiguousGit);
    }
    None
}

fn path_contains_absent_ascii_case_alias(root: &Path, path: &Path, name: &str) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut parent = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        let entry = parent.join(component);
        if component
            .to_str()
            .is_some_and(|component| component != name && component.eq_ignore_ascii_case(name))
            && std::fs::symlink_metadata(&entry)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return true;
        }
        parent = entry;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{
        claim_pending_watch, coalesce_fs_events, event_path_for_requested_root,
        external_git_metadata_roots, pending_watch_is_current, remove_pending_watch,
        watch_access_is_needed_in_state, with_unused_watch_access, workspace_event_paths,
        workspace_event_paths_with_git_roots, PendingWatcher, WorkspaceEventPaths,
        WorkspaceWatchManager, FS_EVENT_QUEUE_CAPACITY,
    };
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
    };
    use notify::Event;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn fs_event_channel() -> (
        std::sync::mpsc::SyncSender<WorkspaceEventPaths>,
        std::sync::mpsc::Receiver<WorkspaceEventPaths>,
    ) {
        std::sync::mpsc::sync_channel(FS_EVENT_QUEUE_CAPACITY)
    }

    fn event(paths: &[&str], git_changed: bool) -> WorkspaceEventPaths {
        WorkspaceEventPaths {
            paths: paths.iter().map(|path| (*path).to_string()).collect(),
            git_changed,
        }
    }

    #[test]
    fn coalesce_fs_events_merges_a_burst_into_one_payload() {
        // A build touching many files used to emit one Tauri event (one UI-thread
        // script evaluation) per notification.
        let (sender, receiver) = fs_event_channel();
        for index in 0..500 {
            sender
                .try_send(event(&[&format!("/w/out/{index}.o")], false))
                .expect("queue capacity");
        }
        sender.try_send(event(&[], true)).expect("queue capacity");

        let first = receiver.recv().expect("first event");
        let merged = coalesce_fs_events(
            &receiver,
            first,
            std::time::Duration::from_millis(500),
            2048,
        );

        assert_eq!(merged.paths.len(), 500);
        assert!(merged.git_changed, "a merged Git event still refreshes Git");
        assert_eq!(merged.paths[0], "/w/out/0.o");
    }

    #[test]
    fn coalesce_fs_events_deduplicates_repeated_paths() {
        let (sender, receiver) = fs_event_channel();
        for _ in 0..10 {
            sender
                .try_send(event(&["/w/main.tex"], false))
                .expect("queue capacity");
        }

        let first = receiver.recv().expect("first event");
        let merged = coalesce_fs_events(
            &receiver,
            first,
            std::time::Duration::from_millis(200),
            2048,
        );

        assert_eq!(merged.paths, vec!["/w/main.tex".to_string()]);
    }

    #[test]
    fn coalesce_fs_events_keeps_whole_events_when_it_hits_the_cap() {
        // The cap is checked per event, so an accepted event always contributes
        // all of its paths and the remainder of the burst lands in the next batch.
        let (sender, receiver) = fs_event_channel();
        for index in 0..4 {
            sender
                .try_send(event(
                    &[&format!("/w/a{index}"), &format!("/w/b{index}")],
                    false,
                ))
                .expect("queue capacity");
        }

        let first = receiver.recv().expect("first event");
        let merged = coalesce_fs_events(&receiver, first, std::time::Duration::from_millis(200), 3);

        assert_eq!(
            merged.paths.len(),
            4,
            "stops after the event that hit the cap"
        );
        assert_eq!(receiver.try_recv().map(|e| e.paths.len()).ok(), Some(2));
    }

    #[test]
    fn coalesce_fs_events_returns_promptly_once_the_watcher_is_gone() {
        let (sender, receiver) = fs_event_channel();
        sender
            .try_send(event(&["/w/only"], false))
            .expect("queue capacity");
        drop(sender);

        let first = receiver.recv().expect("first event");
        let started = std::time::Instant::now();
        let merged = coalesce_fs_events(&receiver, first, std::time::Duration::from_secs(30), 2048);

        assert_eq!(merged.paths, vec!["/w/only".to_string()]);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn coalesce_fs_events_preserves_a_pathless_native_event() {
        // An empty native event still means "refresh the tree"; merging must not
        // turn it into something the frontend ignores.
        let (sender, receiver) = fs_event_channel();
        sender.try_send(event(&[], false)).expect("queue capacity");
        drop(sender);

        let first = receiver.recv().expect("first event");
        let merged =
            coalesce_fs_events(&receiver, first, std::time::Duration::from_millis(50), 2048);

        assert!(merged.paths.is_empty());
        assert!(!merged.git_changed);
    }

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
    fn removing_a_window_invalidates_its_in_flight_watch_setup() {
        let manager = WorkspaceWatchManager::default();
        let token = Arc::new(AtomicBool::new(false));
        manager.state.lock().unwrap().pending.insert(
            "main1".to_string(),
            PendingWatcher {
                root: PathBuf::from("/workspace"),
                requested_root: "/workspace".to_string(),
                cancelled: token.clone(),
            },
        );
        assert!(pending_watch_is_current(&manager, "main1", &token));

        manager.remove_window("main1");

        assert!(token.load(Ordering::Acquire));
        assert!(!pending_watch_is_current(&manager, "main1", &token));
        let mut state = manager.state.lock().unwrap();
        assert!(
            claim_pending_watch(
                &mut state,
                "main1",
                PathBuf::from("/workspace"),
                "/workspace".to_string(),
            )
            .is_none(),
            "a command delayed before its claim must not resurrect a destroyed label"
        );
    }

    #[test]
    fn newer_overlapping_watch_keeps_a_distinct_token_and_cancels_the_old_one() {
        let manager = WorkspaceWatchManager::default();
        let mut state = manager.state.lock().unwrap();
        let first = claim_pending_watch(
            &mut state,
            "main1",
            PathBuf::from("/workspace-a"),
            "/workspace-a".to_string(),
        )
        .unwrap();
        let second = claim_pending_watch(
            &mut state,
            "main1",
            PathBuf::from("/workspace-b"),
            "/workspace-b".to_string(),
        )
        .unwrap();
        drop(state);

        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        assert!(!pending_watch_is_current(&manager, "main1", &first));
        assert!(pending_watch_is_current(&manager, "main1", &second));
    }

    #[test]
    fn failed_newer_same_root_setup_releases_inherited_authorization() {
        let manager = WorkspaceWatchManager::default();
        let root = PathBuf::from("/workspace");
        let first = {
            let mut state = manager.state.lock().unwrap();
            claim_pending_watch(&mut state, "main1", root.clone(), "/workspace".to_string())
                .unwrap()
        };
        let second = {
            let mut state = manager.state.lock().unwrap();
            claim_pending_watch(&mut state, "main1", root.clone(), "/workspace".to_string())
                .unwrap()
        };
        assert!(first.load(Ordering::Acquire));
        assert!(watch_access_is_needed_in_state(
            &manager.state.lock().unwrap(),
            "main1",
            &root
        ));

        // Model the newer setup's authorization failure: its pending token is
        // removed, and the superseded first setup is no longer registered.
        // The failure branch must therefore revoke the inherited grant.
        remove_pending_watch(&manager, "main1", &second);

        let revoked = std::cell::Cell::new(false);
        with_unused_watch_access(&manager, "main1", &root, || {
            assert!(matches!(
                manager.state.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            revoked.set(true);
        });
        assert!(revoked.get());
    }

    #[test]
    fn same_root_claim_cannot_interleave_between_unused_check_and_revoke() {
        let manager = WorkspaceWatchManager::default();
        let root = PathBuf::from("/workspace");
        let revoke_ran = std::cell::Cell::new(false);

        with_unused_watch_access(&manager, "main1", &root, || {
            // The callback is the PathAccess revoke in production. Prove the
            // watcher-state lock remains held through it, so another setup's
            // claim cannot appear in the check-to-revoke gap.
            assert!(matches!(
                manager.state.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            revoke_ran.set(true);
        });

        assert!(revoke_ran.get());
        let mut state = manager.state.lock().unwrap();
        assert!(
            claim_pending_watch(&mut state, "main1", root, "/workspace".to_string(),).is_some()
        );
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

    #[cfg(unix)]
    #[test]
    fn filesystem_root_workspace_keeps_event_paths_absolute() {
        // A workspace opened at the filesystem root "/" must still emit ABSOLUTE
        // event paths; a relative path would never match an open doc's absolute
        // path, so the tab would silently not reload when the file changes.
        let mapped = event_path_for_requested_root(
            Path::new("/"),
            Path::new("/"),
            Path::new("/src/main.tex"),
        );

        assert_eq!(mapped, "/src/main.tex");
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
    fn generated_tree_events_do_not_refresh_workspace() {
        for path in [
            "/real/project/target/debug/object.o",
            "/real/project/node_modules/pkg/index.js",
            "/real/project/web/dist/bundle.js",
            "/real/project/.vite/deps/chunk.js",
        ] {
            let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(PathBuf::from(path));

            assert_eq!(
                workspace_event_paths(
                    Path::new("/real/project"),
                    Path::new("/link/project"),
                    &event
                ),
                None,
                "{path} should be excluded"
            );
        }
    }

    #[test]
    fn ordinary_file_named_like_generated_directory_remains_visible() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let target = tmp.path().join("target");
        std::fs::write(&target, b"ordinary file").unwrap();
        let visible_path = target.to_string_lossy().into_owned();
        let event =
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content))).add_path(target);

        assert_eq!(
            workspace_event_paths(tmp.path(), tmp.path(), &event),
            visible(&[&visible_path])
        );
    }

    #[test]
    fn git_metadata_wins_over_a_later_generated_directory_name() {
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(PathBuf::from("/real/project/.git/target/index"));

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
    fn case_distinct_generated_name_remains_visible_on_case_sensitive_filesystems() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let upper = tmp.path().join("TARGET");
        std::fs::create_dir(&upper).unwrap();
        let event_path = upper.join("artifact");
        std::fs::write(&event_path, b"artifact").unwrap();
        let visible_path = event_path.to_string_lossy().into_owned();
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(event_path);

        let result = workspace_event_paths(tmp.path(), tmp.path(), &event);
        if tmp.path().join("target").exists() {
            assert_eq!(result, None);
        } else {
            assert_eq!(result, visible(&[&visible_path]));
        }
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
    fn external_git_metadata_events_only_refresh_git_decorations() {
        let external_git_root = PathBuf::from("/real/project/.git");
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(external_git_root.join("index"));

        assert_eq!(
            workspace_event_paths_with_git_roots(
                Path::new("/real/project/opened-subdirectory"),
                Path::new("/link/project/opened-subdirectory"),
                &[external_git_root],
                &event,
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
    fn nested_trash_named_directory_events_remain_visible() {
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/real/project/docs/.lyceum-trash/file.tex"));

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event
            ),
            visible(&["/link/project/docs/.lyceum-trash/file.tex"])
        );
    }

    #[test]
    fn case_aliased_root_trash_events_are_internal_when_the_filesystem_aliases_it() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper = root.join(".LYCEUM-TRASH");
        std::fs::create_dir(&upper).unwrap();
        if !root.join(".lyceum-trash").exists() {
            return;
        }
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(upper.join("batch").join("file.tex"));

        assert_eq!(workspace_event_paths(root, root, &event), None);
    }

    #[test]
    fn case_aliased_nested_git_events_follow_filesystem_identity() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let nested = root.join("nested");
        let upper_git = nested.join(".GIT");
        std::fs::create_dir_all(&upper_git).unwrap();
        let event_path = upper_git.join("index.lock");
        let visible_path = event_path.to_string_lossy().into_owned();
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(event_path);

        let result = workspace_event_paths(root, root, &event);
        if nested.join(".git").exists() {
            assert_eq!(result, git_only());
        } else {
            assert_eq!(result, visible(&[&visible_path]));
        }
    }

    #[test]
    fn absent_case_ambiguous_git_event_remains_visible_and_refreshes_git() {
        let event_path = PathBuf::from("/real/project/.GIT");
        let event =
            Event::new(EventKind::Remove(notify::event::RemoveKind::Folder)).add_path(event_path);

        assert_eq!(
            workspace_event_paths(
                Path::new("/real/project"),
                Path::new("/link/project"),
                &event,
            ),
            visible_with_git(&["/link/project/.GIT"])
        );
    }

    #[test]
    fn removed_case_aliased_git_directory_remains_visible_and_refreshes_git() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper_git = root.join(".GIT");
        std::fs::create_dir(&upper_git).unwrap();
        if !root.join(".git").exists() {
            return;
        }
        std::fs::remove_dir(&upper_git).unwrap();
        let visible_path = upper_git.to_string_lossy().into_owned();
        let event =
            Event::new(EventKind::Remove(notify::event::RemoveKind::Folder)).add_path(upper_git);

        assert_eq!(
            workspace_event_paths(root, root, &event),
            visible_with_git(&[&visible_path])
        );
    }

    #[cfg(unix)]
    #[test]
    fn aliases_into_root_workspace_trash_do_not_refresh_workspace() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let trash = root.join(".lyceum-trash");
        let docs = root.join("docs");
        std::fs::create_dir(&trash).unwrap();
        std::fs::write(trash.join("deleted.txt"), b"deleted").unwrap();
        std::fs::create_dir(&docs).unwrap();
        symlink(".lyceum-trash", root.join("trash-link")).unwrap();
        symlink("../.lyceum-trash/deleted.txt", docs.join("deleted-link")).unwrap();

        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(root.join("trash-link").join("deleted.txt"))
            .add_path(docs.join("deleted-link"));

        assert_eq!(workspace_event_paths(root, root, &event), None);
    }

    #[cfg(unix)]
    #[test]
    fn removed_event_through_git_directory_alias_still_refreshes_git() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::create_dir(root.join("docs")).unwrap();
        symlink("../.git", root.join("docs").join("git-link")).unwrap();
        let event = Event::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(root.join("docs").join("git-link").join("removed.lock"));

        assert_eq!(workspace_event_paths(root, root, &event), git_only());
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

    #[test]
    #[ignore = "manual integration probe for native notify + git"]
    fn native_git_commit_emits_a_git_decoration_refresh() {
        use notify::{RecursiveMode, Watcher};
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let tmp = tempfile::tempdir().expect("create temp git repository");
        let repo_root = tmp.path();
        let workspace_root = repo_root.join("opened-subdirectory");
        std::fs::create_dir(&workspace_root).expect("create subdirectory workspace");
        let canonical_workspace_root = workspace_root
            .canonicalize()
            .expect("canonicalize subdirectory workspace");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(repo_root)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Lyceum Watch Probe"]);
        git(&["config", "user.email", "watch-probe@invalid.example"]);
        std::fs::write(workspace_root.join("tracked.txt"), b"initial\n")
            .expect("write initial file");
        git(&["add", "opened-subdirectory/tracked.txt"]);
        git(&["commit", "-q", "-m", "initial"]);
        std::fs::write(workspace_root.join("tracked.txt"), b"changed\n")
            .expect("modify tracked file");

        let (tx, rx) = mpsc::channel();
        let external_git_roots = external_git_metadata_roots(&canonical_workspace_root);
        assert_eq!(external_git_roots.len(), 1);
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .expect("create native watcher");
        watcher
            .watch(&canonical_workspace_root, RecursiveMode::Recursive)
            .expect("watch repository");
        for git_root in &external_git_roots {
            watcher
                .watch(git_root, RecursiveMode::Recursive)
                .expect("watch external Git metadata");
        }

        git(&["commit", "-q", "-am", "watched commit"]);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_git_refresh = false;
        while Instant::now() < deadline {
            let timeout = deadline.saturating_duration_since(Instant::now());
            let Ok(event) = rx.recv_timeout(timeout) else {
                break;
            };
            let event = event.expect("native watcher event");
            let classified = workspace_event_paths_with_git_roots(
                &canonical_workspace_root,
                &workspace_root,
                &external_git_roots,
                &event,
            );
            eprintln!("native event: {event:?}; classified: {classified:?}");
            saw_git_refresh |= classified.is_some_and(|paths| paths.git_changed);
            if saw_git_refresh {
                break;
            }
        }

        assert!(
            saw_git_refresh,
            "git commit produced no event classified as a Git decoration refresh"
        );
    }
}
