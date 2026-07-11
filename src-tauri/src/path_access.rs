use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::workspace_paths::path_resolves_into_workspace_trash;

/// Per-window filesystem access roots. The frontend must explicitly authorize a
/// workspace root before Explorer/editor commands can read or write inside it.
#[derive(Default)]
pub struct PathAccessManager {
    window_roots: Mutex<HashMap<String, WindowAccessRoots>>,
}

#[derive(Default)]
struct WindowAccessRoots {
    /// Grants requested directly by Explorer/editor/LSP commands. Repeated
    /// authorization is set-like and watcher teardown must never remove it.
    explicit: HashSet<PathBuf>,
    /// Grants owned by the workspace watch lifecycle. These are revoked when a
    /// watch fails, is replaced, or is explicitly stopped.
    watcher: HashSet<PathBuf>,
}

impl WindowAccessRoots {
    fn allows(&self, path: &Path) -> bool {
        self.explicit.iter().chain(self.watcher.iter()).any(|root| {
            is_same_or_descendant(path, root) && !path_resolves_into_workspace_trash(root, path)
        })
    }

    fn is_empty(&self) -> bool {
        self.explicit.is_empty() && self.watcher.is_empty()
    }
}

impl PathAccessManager {
    pub fn remove_window(&self, app: &AppHandle, label: &str) {
        let _ = app;
        let _removed = match self.window_roots.lock() {
            Ok(mut roots) => roots.remove(label).unwrap_or_default(),
            Err(_) => WindowAccessRoots::default(),
        };
    }
}

#[tauri::command]
pub fn authorize_workspace_root(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, PathAccessManager>,
    root: String,
) -> Result<String, String> {
    let root_path = canonical_dir(Path::new(&root))?;
    authorize_workspace_root_impl(&app, window.label(), &state, root_path)
}

pub fn authorize_workspace_root_impl(
    app: &AppHandle,
    label: &str,
    state: &State<'_, PathAccessManager>,
    root_path: PathBuf,
) -> Result<String, String> {
    app.asset_protocol_scope()
        .allow_directory(&root_path, true)
        .map_err(|e| {
            format!(
                "failed to authorize {} for previews: {e}",
                root_path.display()
            )
        })?;
    let mut roots = state
        .window_roots
        .lock()
        .map_err(|_| "path access lock poisoned".to_string())?;
    roots
        .entry(label.to_string())
        .or_default()
        .explicit
        .insert(root_path.clone());
    Ok(root_path.to_string_lossy().into_owned())
}

/// Grant a root on behalf of the workspace watcher. Kept separate from direct
/// command grants so an overlapping unwatch cannot revoke editor/LSP access.
pub fn authorize_workspace_root_for_watcher_impl(
    app: &AppHandle,
    label: &str,
    state: &State<'_, PathAccessManager>,
    root_path: PathBuf,
) -> Result<String, String> {
    app.asset_protocol_scope()
        .allow_directory(&root_path, true)
        .map_err(|e| {
            format!(
                "failed to authorize {} for previews: {e}",
                root_path.display()
            )
        })?;
    let mut roots = state
        .window_roots
        .lock()
        .map_err(|_| "path access lock poisoned".to_string())?;
    roots
        .entry(label.to_string())
        .or_default()
        .watcher
        .insert(root_path.clone());
    Ok(root_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn revoke_workspace_root(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, PathAccessManager>,
    root: Option<String>,
) -> Result<(), String> {
    revoke_workspace_root_impl(&app, window.label(), &state, root.as_deref())
}

pub fn revoke_workspace_root_impl(
    app: &AppHandle,
    label: &str,
    state: &State<'_, PathAccessManager>,
    root: Option<&str>,
) -> Result<(), String> {
    let removed = {
        let mut roots = state
            .window_roots
            .lock()
            .map_err(|_| "path access lock poisoned".to_string())?;
        match root {
            None => roots.remove(label).unwrap_or_default(),
            Some(root) => {
                let mut removed = WindowAccessRoots::default();
                if let Some(window_roots) = roots.get_mut(label) {
                    let requested = Path::new(root).canonicalize().ok();
                    window_roots.explicit.retain(|allowed| {
                        let matches = requested.as_ref().is_some_and(|path| path == allowed)
                            || path_equal_lexically(root, allowed);
                        if matches {
                            removed.explicit.insert(allowed.clone());
                        }
                        !matches
                    });
                    window_roots.watcher.retain(|allowed| {
                        let matches = requested.as_ref().is_some_and(|path| path == allowed)
                            || path_equal_lexically(root, allowed);
                        if matches {
                            removed.watcher.insert(allowed.clone());
                        }
                        !matches
                    });
                    if window_roots.is_empty() {
                        roots.remove(label);
                    }
                }
                removed
            }
        }
    };
    // Tauri 2.11.2 has no remove/unallow API for asset scopes, and
    // `forbid_directory` permanently wins over later allows. Keep revocation to
    // Lyceum's own IPC access set; the residual asset lifetime is documented in
    // docs/RISKS.md.
    let _ = (app, removed);
    Ok(())
}

/// Revoke only roots owned by the watcher lifecycle. Direct command grants for
/// the same canonical root remain valid.
pub fn revoke_workspace_root_for_watcher_impl(
    app: &AppHandle,
    label: &str,
    state: &State<'_, PathAccessManager>,
    canonical_root: Option<&Path>,
) -> Result<(), String> {
    let removed = {
        let mut roots = state
            .window_roots
            .lock()
            .map_err(|_| "path access lock poisoned".to_string())?;
        let mut removed = HashSet::new();
        if let Some(window_roots) = roots.get_mut(label) {
            removed = remove_canonical_roots(&mut window_roots.watcher, canonical_root);
            if window_roots.is_empty() {
                roots.remove(label);
            }
        }
        removed
    };
    // Tauri has no reversible asset-scope removal; IPC authorization above is
    // the enforceable boundary. Keep the variable to document that asymmetry.
    let _ = (app, removed);
    Ok(())
}

/// Revoke every grant owner for an exact canonical workspace root. Workspace
/// lifecycle completion (unwatch/root replacement) uses this; failed or stale
/// watcher setup uses the watcher-only variant above.
pub fn revoke_workspace_root_canonical_impl(
    app: &AppHandle,
    label: &str,
    state: &State<'_, PathAccessManager>,
    canonical_root: Option<&Path>,
) -> Result<(), String> {
    let removed = {
        let mut roots = state
            .window_roots
            .lock()
            .map_err(|_| "path access lock poisoned".to_string())?;
        let mut removed = WindowAccessRoots::default();
        if let Some(window_roots) = roots.get_mut(label) {
            removed.explicit = remove_canonical_roots(&mut window_roots.explicit, canonical_root);
            removed.watcher = remove_canonical_roots(&mut window_roots.watcher, canonical_root);
            if window_roots.is_empty() {
                roots.remove(label);
            }
        }
        removed
    };
    let _ = (app, removed);
    Ok(())
}

fn remove_canonical_roots(
    roots: &mut HashSet<PathBuf>,
    canonical_root: Option<&Path>,
) -> HashSet<PathBuf> {
    match canonical_root {
        None => std::mem::take(roots),
        Some(canonical_root) => {
            let mut removed = HashSet::new();
            roots.retain(|allowed| {
                if allowed == canonical_root {
                    removed.insert(allowed.clone());
                    false
                } else {
                    true
                }
            });
            removed
        }
    }
}

pub fn ensure_existing_allowed(
    app: &AppHandle,
    window: &tauri::Window,
    state: &State<'_, PathAccessManager>,
    path: &Path,
) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    ensure_allowed_canonical(app, window, state, &canonical)?;
    Ok(canonical)
}

pub fn ensure_existing_file_allowed(
    app: &AppHandle,
    window: &tauri::Window,
    state: &State<'_, PathAccessManager>,
    path: &Path,
) -> Result<PathBuf, String> {
    let canonical = ensure_existing_allowed(app, window, state, path)?;
    let meta = std::fs::metadata(&canonical).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    Ok(canonical)
}

pub fn ensure_existing_dir_allowed(
    app: &AppHandle,
    window: &tauri::Window,
    state: &State<'_, PathAccessManager>,
    path: &Path,
) -> Result<PathBuf, String> {
    let canonical = ensure_existing_allowed(app, window, state, path)?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    Ok(canonical)
}

pub fn ensure_write_target_allowed(
    app: &AppHandle,
    window: &tauri::Window,
    state: &State<'_, PathAccessManager>,
    path: &Path,
) -> Result<PathBuf, String> {
    if path
        .try_exists()
        .map_err(|e| format!("{}: {e}", path.display()))?
    {
        return ensure_existing_allowed(app, window, state, path);
    }

    let normalized = absolute_lexical_path(path)?;
    let parent = normalized
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("cannot determine parent directory for {}", path.display()))?;
    let existing_parent = nearest_existing_ancestor(parent)?;
    let canonical_parent = existing_parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", existing_parent.display()))?;
    ensure_allowed_canonical(app, window, state, &canonical_parent)?;
    Ok(normalized)
}

fn ensure_allowed_canonical(
    app: &AppHandle,
    window: &tauri::Window,
    state: &State<'_, PathAccessManager>,
    canonical: &Path,
) -> Result<(), String> {
    if is_config_path(app, canonical) {
        return Ok(());
    }
    let roots = state
        .window_roots
        .lock()
        .map_err(|_| "path access lock poisoned".to_string())?;
    if roots
        .get(window.label())
        .is_some_and(|roots| roots.allows(canonical))
    {
        return Ok(());
    }
    Err(format!(
        "path is outside authorized workspace: {}",
        canonical.display()
    ))
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

fn is_config_path(app: &AppHandle, canonical: &Path) -> bool {
    config_roots(app)
        .into_iter()
        .any(|root| is_same_or_descendant(canonical, &root))
}

fn config_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().app_config_dir() {
        if let Ok(canonical) = dir.canonicalize() {
            roots.push(canonical);
        }
        if dir.file_name().is_some_and(|name| name == "dev.lyceum") {
            if let Some(parent) = dir.parent() {
                let legacy = parent.join("dev.lyceum.app");
                if let Ok(canonical) = legacy.canonicalize() {
                    roots.push(canonical);
                }
            }
        }
    }
    roots
}

fn is_same_or_descendant(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn path_equal_lexically(path: &str, canonical: &Path) -> bool {
    absolute_lexical_path(Path::new(path))
        .ok()
        .is_some_and(|path| path == canonical)
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    loop {
        if current
            .try_exists()
            .map_err(|e| format!("{}: {e}", path.display()))?
        {
            return Ok(current);
        }
        if !current.pop() {
            return Err(format!("no existing ancestor for {}", path.display()));
        }
    }
}

fn absolute_lexical_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    Ok(normalize_lexically(&absolute))
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_normalization_removes_parent_segments_before_access_checks() {
        let path = normalize_lexically(Path::new("/tmp/root/new/../../outside.txt"));
        assert_eq!(path, PathBuf::from("/tmp/outside.txt"));
    }

    #[test]
    fn watcher_revoke_preserves_an_explicit_same_root_grant() {
        let root = PathBuf::from("/workspace");
        let mut access = WindowAccessRoots::default();
        access.explicit.insert(root.clone());
        access.watcher.insert(root.clone());

        let removed = remove_canonical_roots(&mut access.watcher, Some(&root));

        assert_eq!(removed, HashSet::from([root.clone()]));
        assert!(access.watcher.is_empty());
        assert!(access.allows(&root.join("document.tex")));
    }

    #[test]
    fn replacing_workspace_a_with_b_removes_only_a_grants() {
        let old = PathBuf::from("/workspace-old");
        let new = PathBuf::from("/workspace-new");
        let mut access = WindowAccessRoots::default();
        access.explicit.extend([old.clone(), new.clone()]);
        access.watcher.extend([old.clone(), new.clone()]);

        remove_canonical_roots(&mut access.watcher, Some(&old));
        remove_canonical_roots(&mut access.explicit, Some(&old));

        assert_eq!(access.watcher, HashSet::from([new.clone()]));
        assert_eq!(access.explicit, HashSet::from([new]));
    }

    #[test]
    fn watcher_revoke_uses_stored_canonical_identity_after_requested_link_disappears() {
        // The requested spelling may have been `/link/workspace`, but cleanup
        // already owns the canonical `/real/workspace`. Exact canonical removal
        // must not depend on re-canonicalizing a now-missing symlink.
        let canonical = PathBuf::from("/real/workspace");
        let mut watcher = HashSet::from([canonical.clone()]);

        let removed = remove_canonical_roots(&mut watcher, Some(&canonical));

        assert_eq!(removed, HashSet::from([canonical]));
        assert!(watcher.is_empty());
    }

    #[test]
    fn full_revoke_semantics_clear_both_grant_owners() {
        let root = PathBuf::from("/workspace");
        let mut access = WindowAccessRoots::default();
        access.explicit.insert(root.clone());
        access.watcher.insert(root);

        let explicit = remove_canonical_roots(&mut access.explicit, None);
        let watcher = remove_canonical_roots(&mut access.watcher, None);

        assert_eq!(explicit.len(), 1);
        assert_eq!(watcher.len(), 1);
        assert!(access.is_empty());
    }

    #[test]
    fn workspace_grant_excludes_only_its_root_internal_trash() {
        let root = PathBuf::from("/workspace");
        let mut access = WindowAccessRoots::default();
        access.explicit.insert(root.clone());

        assert!(!access.allows(&root.join(".lyceum-trash/deleted.txt")));
        assert!(access.allows(&root.join("docs/.lyceum-trash/visible.txt")));
    }
}
