// Filesystem operations exposed to the frontend for the file explorer (M2).
//
// The pure listing logic lives in `read_dir_entries` so it can be unit-tested
// with `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrappers
// are thin. Directory reads are explicit, on-demand (lazy) reads — no recursive
// walking or background indexing (a v1 non-goal).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const LYCEUM_TRASH_DIR: &str = ".lyceum-trash";
static TRASH_BATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// A single entry in a directory listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    /// File or directory name (final path component).
    pub name: String,
    /// Absolute path to the entry.
    pub path: String,
    /// True if the entry is a directory.
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemDto {
    pub original_path: String,
    pub trashed_path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchDto {
    pub id: String,
    pub items: Vec<TrashItemDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MovedPathDto {
    pub from: String,
    pub to: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceEntryTarget {
    path: PathBuf,
    is_dir: bool,
}

/// List the immediate children of `dir`, directories first then files, each
/// group sorted case-insensitively by name. Returns an error string on failure.
pub fn read_dir_entries(dir: &Path) -> Result<Vec<DirEntryDto>, String> {
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }

    let mut entries: Vec<DirEntryDto> = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == LYCEUM_TRASH_DIR {
            continue;
        }
        let path = entry.path().to_string_lossy().to_string();
        entries.push(DirEntryDto {
            name,
            path,
            is_dir: file_type.is_dir(),
        });
    }

    // Directories before files, then case-insensitive name order.
    // `sort_by_cached_key` lowercases each name once (O(n)) rather than on every
    // comparison (O(n log n) temporary Strings).
    entries.sort_by_cached_key(|e| (std::cmp::Reverse(e.is_dir), e.name.to_lowercase()));

    Ok(entries)
}

/// Read the immediate children of a directory path. Used by the file explorer
/// to lazily expand folders.
#[tauri::command]
pub fn read_directory(path: String) -> Result<Vec<DirEntryDto>, String> {
    read_dir_entries(Path::new(&path))
}

/// Create an empty file at `path`. Errors if it already exists. Parent
/// directories are created as needed.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if path_entry_exists(target) {
        return Err(format!("already exists: {path}"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map(|_| ())
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("already exists: {path}")
            } else {
                format!("{path}: {e}")
            }
        })
}

/// Create a directory (and any missing parents) at `path`.
#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

/// Rename/move `from` to `to`. Errors if the destination already exists.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if path_entry_exists(Path::new(&to)) {
        return Err(format!("already exists: {to}"));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// Move one or more workspace paths into an existing destination directory.
#[tauri::command]
pub fn move_paths(
    root: String,
    paths: Vec<String>,
    destination_dir: String,
) -> Result<Vec<MovedPathDto>, String> {
    move_paths_impl(Path::new(&root), paths, Path::new(&destination_dir))
}

/// Delete `path`, recursively removing directory trees and unlinking files.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let file_type = std::fs::symlink_metadata(target)
        .map_err(|e| format!("{path}: {e}"))?
        .file_type();
    if file_type.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| format!("{path}: {e}"))
    } else {
        std::fs::remove_file(target).map_err(|e| format!("{path}: {e}"))
    }
}

#[tauri::command]
pub fn delete_file_if_exists(path: String) -> Result<bool, String> {
    let target = Path::new(&path);
    let metadata = match std::fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("{path}: {error}")),
    };
    if metadata.file_type().is_dir() {
        return Err(format!("expected a file, found directory: {path}"));
    }
    std::fs::remove_file(target)
        .map(|_| true)
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn move_paths_to_trash(root: String, paths: Vec<String>) -> Result<TrashBatchDto, String> {
    move_paths_to_trash_impl(Path::new(&root), paths)
}

#[tauri::command]
pub fn restore_trash_batch(root: String, items: Vec<TrashItemDto>) -> Result<(), String> {
    restore_trash_batch_impl(Path::new(&root), items)
}

#[tauri::command]
pub fn redo_trash_batch(root: String, items: Vec<TrashItemDto>) -> Result<(), String> {
    redo_trash_batch_impl(Path::new(&root), items)
}

fn move_paths_to_trash_impl(root: &Path, paths: Vec<String>) -> Result<TrashBatchDto, String> {
    let root = canonical_dir(root)?;
    let targets = normalize_delete_targets(&root, paths)?;
    if targets.is_empty() {
        return Err("no paths to delete".to_string());
    }

    let id = unique_trash_batch_id();
    let batch_dir = root.join(LYCEUM_TRASH_DIR).join(&id);
    std::fs::create_dir_all(&batch_dir).map_err(|e| format!("{}: {e}", batch_dir.display()))?;

    let mut items = Vec::with_capacity(targets.len());
    // Completed moves (trashed_dest, original_source); on any failure these are
    // rolled back so a partial multi-file delete cannot silently lose files
    // into the hidden trash dir with no Undo affordance.
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
    for target in targets {
        let rel = match target.path.strip_prefix(&root) {
            Ok(rel) => rel,
            Err(e) => {
                rollback_moves(&done);
                let _ = std::fs::remove_dir_all(&batch_dir);
                return Err(format!("{}: {e}", target.path.display()));
            }
        };
        let destination = batch_dir.join(rel);
        if let Some(parent) = destination.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                let _ = std::fs::remove_dir_all(&batch_dir);
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        if let Err(e) = move_entry(&target.path, &destination) {
            rollback_moves(&done);
            let _ = std::fs::remove_dir_all(&batch_dir);
            return Err(format!(
                "{} -> {}: {e}",
                target.path.display(),
                destination.display()
            ));
        }
        done.push((destination.clone(), target.path.clone()));
        items.push(TrashItemDto {
            original_path: target.path.to_string_lossy().to_string(),
            trashed_path: destination.to_string_lossy().to_string(),
            is_dir: target.is_dir,
        });
    }

    Ok(TrashBatchDto { id, items })
}

fn move_paths_impl(
    root: &Path,
    paths: Vec<String>,
    destination_dir: &Path,
) -> Result<Vec<MovedPathDto>, String> {
    let root = canonical_dir(root)?;
    let destination = destination_dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", destination_dir.display()))?;
    validate_move_destination(&root, &destination)?;
    let targets = normalize_move_targets(&root, paths)?;

    let mut planned = Vec::new();
    let mut destinations = HashSet::new();
    for target in targets {
        let parent = target
            .path
            .parent()
            .ok_or_else(|| format!("invalid move path: {}", target.path.display()))?;
        if parent == destination {
            continue;
        }
        if target.is_dir && destination.starts_with(&target.path) {
            return Err(format!(
                "cannot move a folder into itself: {} -> {}",
                target.path.display(),
                destination.display()
            ));
        }
        let name = target
            .path
            .file_name()
            .ok_or_else(|| format!("cannot determine file name for {}", target.path.display()))?;
        let to = destination.join(name);
        if !destinations.insert(to.clone()) {
            return Err(format!(
                "multiple moved items would overwrite {}",
                to.display()
            ));
        }
        if path_entry_exists(&to) {
            return Err(format!("already exists: {}", to.display()));
        }
        planned.push((target.path.clone(), to, target.is_dir));
    }

    let mut moved = Vec::with_capacity(planned.len());
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to, is_dir) in planned {
        if let Err(e) = move_entry(&from, &to) {
            rollback_moves(&done);
            return Err(format!("{} -> {}: {e}", from.display(), to.display()));
        }
        done.push((to.clone(), from.clone()));
        moved.push(MovedPathDto {
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            is_dir,
        });
    }
    Ok(moved)
}

fn restore_trash_batch_impl(root: &Path, items: Vec<TrashItemDto>) -> Result<(), String> {
    let root = canonical_dir(root)?;
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        validate_restore_pair(&root, &original, &trashed)?;
        if !path_entry_exists(&trashed) {
            return Err(format!(
                "restore source no longer exists: {}",
                trashed.display()
            ));
        }
        if path_entry_exists(&original) {
            return Err(format!(
                "restore destination already exists: {}",
                original.display()
            ));
        }
    }
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        if let Some(parent) = original.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        if let Err(e) = move_entry(&trashed, &original) {
            rollback_moves(&done);
            return Err(format!("{} -> {}: {e}", trashed.display(), original.display()));
        }
        done.push((original.clone(), trashed.clone()));
        cleanup_empty_trash_ancestors(&root, &trashed);
    }
    Ok(())
}

fn redo_trash_batch_impl(root: &Path, items: Vec<TrashItemDto>) -> Result<(), String> {
    let root = canonical_dir(root)?;
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        validate_restore_pair(&root, &original, &trashed)?;
        if !path_entry_exists(&original) {
            return Err(format!(
                "redo source does not exist: {}",
                original.display()
            ));
        }
        if path_entry_exists(&trashed) {
            return Err(format!(
                "redo destination already exists: {}",
                trashed.display()
            ));
        }
    }
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        if let Some(parent) = trashed.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        if let Err(e) = move_entry(&original, &trashed) {
            rollback_moves(&done);
            return Err(format!("{} -> {}: {e}", original.display(), trashed.display()));
        }
        done.push((trashed.clone(), original.clone()));
    }
    Ok(())
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    Ok(path)
}

fn path_entry_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// True when an io error is a cross-filesystem rename (EXDEV on unix,
/// ERROR_NOT_SAME_DEVICE on Windows). Such renames must fall back to copy+delete.
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(18)
    }
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = e;
        false
    }
}

/// Move `from` to `to`, preferring an atomic rename and falling back to a
/// recursive copy + delete when the two live on different filesystems (a
/// workspace that spans a mount point). Symlinks are recreated as symlinks
/// (the link itself moves, never its target), matching the rename semantics the
/// rest of the module relies on.
fn move_entry(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            copy_recursive(from, to)?;
            remove_entry(from)
        }
        Err(e) => Err(e),
    }
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(from)?;
        symlink_to(&target, to)
    } else if ft.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(unix)]
fn symlink_to(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink_to(target: &Path, link: &Path) -> std::io::Result<()> {
    // Pick the right Windows symlink kind from the resolved target.
    if std::fs::metadata(target).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

#[cfg(not(any(unix, windows)))]
fn symlink_to(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks unsupported on this platform",
    ))
}

/// Reverse a sequence of completed moves `(dest, source)` by moving each
/// `dest` back to `source` (newest first). Best-effort cleanup used to keep
/// trash/restore/redo all-or-nothing on a mid-batch failure.
fn rollback_moves(done: &[(PathBuf, PathBuf)]) {
    for (dest, source) in done.iter().rev() {
        if let Some(parent) = source.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = move_entry(dest, source);
    }
}

fn normalize_delete_targets(
    root: &Path,
    paths: Vec<String>,
) -> Result<Vec<WorkspaceEntryTarget>, String> {
    let mut targets: Vec<WorkspaceEntryTarget> = Vec::new();
    for raw in paths {
        let target = existing_workspace_entry_target(&raw)?;
        validate_workspace_target(root, &target.path)?;
        if !targets.iter().any(|entry| entry.path == target.path) {
            targets.push(target);
        }
    }
    targets.sort_by_key(|entry| entry.path.components().count());
    let mut top_level: Vec<WorkspaceEntryTarget> = Vec::new();
    for target in targets {
        if !top_level
            .iter()
            .any(|parent| target.path.starts_with(&parent.path))
        {
            top_level.push(target);
        }
    }
    Ok(top_level)
}

fn normalize_move_targets(
    root: &Path,
    paths: Vec<String>,
) -> Result<Vec<WorkspaceEntryTarget>, String> {
    let mut targets: Vec<WorkspaceEntryTarget> = Vec::new();
    for raw in paths {
        let target = existing_workspace_entry_target(&raw)?;
        validate_workspace_move_target(root, &target.path)?;
        if !targets.iter().any(|entry| entry.path == target.path) {
            targets.push(target);
        }
    }
    targets.sort_by_key(|entry| entry.path.components().count());
    let mut top_level: Vec<WorkspaceEntryTarget> = Vec::new();
    for target in targets {
        if !top_level
            .iter()
            .any(|parent| target.path.starts_with(&parent.path))
        {
            top_level.push(target);
        }
    }
    Ok(top_level)
}

fn existing_workspace_entry_target(raw: &str) -> Result<WorkspaceEntryTarget, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {raw}"));
    }
    let file_type = std::fs::symlink_metadata(path)
        .map_err(|e| format!("{raw}: {e}"))?
        .file_type();
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid path: {}", path.display()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", parent.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("cannot determine file name for {}", path.display()))?;
    Ok(WorkspaceEntryTarget {
        path: canonical_parent.join(file_name),
        is_dir: file_type.is_dir(),
    })
}

fn validate_workspace_target(root: &Path, target: &Path) -> Result<(), String> {
    if target == root {
        return Err("refusing to delete the workspace root".to_string());
    }
    if !target.starts_with(root) {
        return Err(format!("outside workspace: {}", target.display()));
    }
    if path_starts_with_trash(root, target) {
        return Err(format!(
            "refusing to delete Lyceum trash: {}",
            target.display()
        ));
    }
    Ok(())
}

fn validate_workspace_move_target(root: &Path, target: &Path) -> Result<(), String> {
    if target == root {
        return Err("refusing to move the workspace root".to_string());
    }
    if !target.starts_with(root) {
        return Err(format!("outside workspace: {}", target.display()));
    }
    if path_starts_with_trash(root, target) {
        return Err(format!(
            "refusing to move Lyceum trash: {}",
            target.display()
        ));
    }
    Ok(())
}

fn validate_move_destination(root: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_dir() {
        return Err(format!("not a directory: {}", destination.display()));
    }
    if !destination.starts_with(root) {
        return Err(format!(
            "move destination outside workspace: {}",
            destination.display()
        ));
    }
    if path_starts_with_trash(root, destination) {
        return Err(format!(
            "refusing to move into Lyceum trash: {}",
            destination.display()
        ));
    }
    Ok(())
}

fn validate_restore_pair(root: &Path, original: &Path, trashed: &Path) -> Result<(), String> {
    validate_workspace_path_no_traversal(root, original, "restore destination")?;
    validate_workspace_path_no_traversal(root, trashed, "trash item")?;
    let original_parent = original
        .parent()
        .ok_or_else(|| format!("invalid restore path: {}", original.display()))?;
    validate_existing_ancestor_inside(root, original_parent, "restore destination")?;
    if let Some(trashed_parent) = trashed.parent() {
        validate_existing_ancestor_inside(root, trashed_parent, "trash item")?;
    }
    if path_starts_with_trash(root, original) {
        return Err(format!(
            "restore destination is inside Lyceum trash: {}",
            original.display()
        ));
    }
    if !path_starts_with_trash(root, trashed) {
        return Err(format!(
            "trash item outside Lyceum trash: {}",
            trashed.display()
        ));
    }
    Ok(())
}

fn validate_existing_ancestor_inside(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if path_entry_exists(candidate) {
            let canonical = candidate
                .canonicalize()
                .map_err(|e| format!("{}: {e}", candidate.display()))?;
            if canonical.starts_with(root) {
                return Ok(());
            }
            return Err(format!(
                "{label} resolves outside workspace: {}",
                path.display()
            ));
        }
        current = candidate.parent();
    }
    Err(format!(
        "{label} has no existing workspace ancestor: {}",
        path.display()
    ))
}

fn validate_workspace_path_no_traversal(
    root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} is not absolute: {}", path.display()));
    }
    if !path.starts_with(root) {
        return Err(format!("{label} outside workspace: {}", path.display()));
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "{label} contains path traversal: {}",
            path.display()
        ));
    }
    Ok(())
}

fn path_starts_with_trash(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .map(|component| component.as_os_str() == LYCEUM_TRASH_DIR)
        .unwrap_or(false)
}

fn unique_trash_batch_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TRASH_BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", millis, std::process::id(), seq)
}

fn cleanup_empty_trash_ancestors(root: &Path, path: &Path) {
    let trash_root = root.join(LYCEUM_TRASH_DIR);
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == trash_root {
            break;
        }
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn errors_on_non_directory() {
        let result = read_dir_entries(Path::new("/this/path/should/not/exist/lyceum"));
        assert!(result.is_err());
    }

    #[test]
    fn lists_entries_directories_first_then_alphabetical() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join("zeta_dir")).unwrap();
        fs::create_dir(root.join("Alpha_dir")).unwrap();
        fs::write(root.join("b_file.txt"), b"b").unwrap();
        fs::write(root.join("A_file.txt"), b"a").unwrap();

        let entries = read_dir_entries(root).expect("read dir");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories (case-insensitive sorted) first, then files.
        assert_eq!(
            names,
            vec!["Alpha_dir", "zeta_dir", "A_file.txt", "b_file.txt"]
        );

        let dirs: Vec<bool> = entries.iter().map(|e| e.is_dir).collect();
        assert_eq!(dirs, vec![true, true, false, false]);
    }

    #[test]
    fn entry_paths_are_absolute_children_of_root() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("note.md"), b"x").unwrap();

        let entries = read_dir_entries(root).expect("read dir");
        let entry = entries.iter().find(|e| e.name == "note.md").unwrap();
        assert!(entry.path.ends_with("note.md"));
        assert!(Path::new(&entry.path).is_absolute());
        assert!(!entry.is_dir);
    }

    #[test]
    fn empty_directory_yields_no_entries() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let entries = read_dir_entries(tmp.path()).expect("read dir");
        assert!(entries.is_empty());
    }

    #[test]
    fn lyceum_trash_directory_is_hidden_from_listings() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(LYCEUM_TRASH_DIR)).unwrap();
        fs::write(root.join("visible.txt"), b"x").unwrap();

        let entries = read_dir_entries(root).expect("read dir");

        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["visible.txt"]);
    }

    #[test]
    fn create_file_creates_empty_file_and_errors_when_exists() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("nested").join("new.txt");
        let path_str = path.to_string_lossy().to_string();

        create_file(path_str.clone()).expect("create file");
        assert!(path.is_file());
        assert_eq!(fs::read(&path).unwrap().len(), 0);

        let result = create_file(path_str);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[test]
    fn create_directory_makes_nested_dirs() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("a").join("b").join("c");

        create_directory(path.to_string_lossy().to_string()).expect("create directory");
        assert!(path.is_dir());
    }

    #[test]
    fn rename_path_moves_file_and_errors_if_destination_exists() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let from = tmp.path().join("from.txt");
        let to = tmp.path().join("to.txt");
        fs::write(&from, b"hello").unwrap();

        rename_path(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        )
        .expect("rename file");
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"hello");

        let other = tmp.path().join("other.txt");
        fs::write(&other, b"x").unwrap();
        let result = rename_path(
            other.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[cfg(unix)]
    #[test]
    fn rename_path_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let from = tmp.path().join("from.txt");
        let to = tmp.path().join("broken-link.txt");
        fs::write(&from, b"hello").unwrap();
        symlink(tmp.path().join("missing.txt"), &to).unwrap();
        assert!(!to.exists());

        let result = rename_path(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        );

        assert!(result.unwrap_err().contains("already exists"));
        assert_eq!(fs::read(&from).unwrap(), b"hello");
        assert!(std::fs::symlink_metadata(&to)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn delete_path_removes_file_and_non_empty_directory_tree() {
        let tmp = tempfile::tempdir().expect("create temp dir");

        let file = tmp.path().join("doomed.txt");
        fs::write(&file, b"bye").unwrap();
        delete_path(file.to_string_lossy().to_string()).expect("delete file");
        assert!(!file.exists());

        let dir = tmp.path().join("tree");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("leaf.txt"), b"leaf").unwrap();
        delete_path(dir.to_string_lossy().to_string()).expect("delete dir tree");
        assert!(!dir.exists());
    }

    #[test]
    fn delete_file_if_exists_removes_only_files() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let file = tmp.path().join("paper.pdf");
        fs::write(&file, b"pdf").unwrap();

        assert!(delete_file_if_exists(file.to_string_lossy().to_string()).unwrap());
        assert!(!file.exists());
        assert!(!delete_file_if_exists(file.to_string_lossy().to_string()).unwrap());

        let dir = tmp.path().join("dir.pdf");
        fs::create_dir(&dir).unwrap();
        let result = delete_file_if_exists(dir.to_string_lossy().to_string());
        assert!(result.unwrap_err().contains("expected a file"));
    }

    #[cfg(unix)]
    #[test]
    fn delete_helpers_unlink_symlinks_without_touching_targets() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let target_dir = tmp.path().join("target-dir");
        let link_dir = tmp.path().join("link-dir");
        fs::create_dir(&target_dir).unwrap();
        fs::write(target_dir.join("leaf.txt"), b"leaf").unwrap();
        symlink(&target_dir, &link_dir).unwrap();

        delete_path(link_dir.to_string_lossy().to_string()).expect("delete symlinked dir entry");

        assert!(std::fs::symlink_metadata(&link_dir).is_err());
        assert_eq!(fs::read(target_dir.join("leaf.txt")).unwrap(), b"leaf");

        let target_file = tmp.path().join("target-file.txt");
        let link_file = tmp.path().join("link-file.txt");
        fs::write(&target_file, b"target").unwrap();
        symlink(&target_file, &link_file).unwrap();

        assert!(
            delete_file_if_exists(link_file.to_string_lossy().to_string())
                .expect("delete symlinked file entry")
        );

        assert!(std::fs::symlink_metadata(&link_file).is_err());
        assert_eq!(fs::read(&target_file).unwrap(), b"target");
    }

    #[test]
    fn move_restore_and_redo_trash_batch_round_trips_files_and_directories() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let file = root.join("note.txt");
        let dir = root.join("folder");
        fs::write(&file, b"note").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("leaf.txt"), b"leaf").unwrap();

        let batch = move_paths_to_trash_impl(
            root,
            vec![
                file.to_string_lossy().to_string(),
                dir.to_string_lossy().to_string(),
            ],
        )
        .expect("move to trash");

        assert_eq!(batch.items.len(), 2);
        assert!(!file.exists());
        assert!(!dir.exists());
        for item in &batch.items {
            assert!(Path::new(&item.trashed_path).exists());
        }

        restore_trash_batch_impl(root, batch.items.clone()).expect("restore");
        assert_eq!(fs::read(&file).unwrap(), b"note");
        assert_eq!(fs::read(dir.join("sub").join("leaf.txt")).unwrap(), b"leaf");

        redo_trash_batch_impl(root, batch.items.clone()).expect("redo");
        assert!(!file.exists());
        assert!(!dir.exists());
        for item in &batch.items {
            assert!(Path::new(&item.trashed_path).exists());
        }
    }

    #[test]
    fn move_to_trash_deduplicates_nested_selections() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dir = root.join("folder");
        let leaf = dir.join("leaf.txt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&leaf, b"leaf").unwrap();
        let canonical_dir = dir.canonicalize().unwrap();

        let batch = move_paths_to_trash_impl(
            root,
            vec![
                dir.to_string_lossy().to_string(),
                leaf.to_string_lossy().to_string(),
            ],
        )
        .expect("move to trash");

        assert_eq!(batch.items.len(), 1);
        assert_eq!(
            Path::new(&batch.items[0].original_path),
            canonical_dir.as_path()
        );
    }

    #[test]
    fn move_to_trash_rejects_root_and_outside_paths() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::NamedTempFile::new().expect("outside file");

        let root_result = move_paths_to_trash_impl(root, vec![root.to_string_lossy().to_string()]);
        assert!(root_result.unwrap_err().contains("workspace root"));

        let outside_result =
            move_paths_to_trash_impl(root, vec![outside.path().to_string_lossy().to_string()]);
        assert!(outside_result.unwrap_err().contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn move_to_trash_moves_symlink_itself_not_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let target = root.join("target.txt");
        let link = root.join("shortcut.txt");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();
        let expected_original = root.canonicalize().unwrap().join("shortcut.txt");

        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash symlink entry");

        assert_eq!(batch.items.len(), 1);
        assert_eq!(
            Path::new(&batch.items[0].original_path),
            expected_original.as_path()
        );
        assert!(!batch.items[0].is_dir);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn move_to_trash_allows_workspace_symlink_to_outside_without_touching_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        let root = tmp.path();
        let link = root.join("outside-shortcut.txt");
        fs::write(outside.path(), b"outside").unwrap();
        symlink(outside.path(), &link).unwrap();

        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash external symlink entry");

        assert_eq!(batch.items.len(), 1);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(outside.path()).unwrap(), b"outside");
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_moves_files_into_destination_directory() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let src = root.join("note.txt");
        let dst = root.join("folder");
        fs::write(&src, b"note").unwrap();
        fs::create_dir(&dst).unwrap();
        let expected_from = src.canonicalize().unwrap().to_string_lossy().to_string();
        let expected_to = dst
            .canonicalize()
            .unwrap()
            .join("note.txt")
            .to_string_lossy()
            .to_string();

        let moved = move_paths_impl(root, vec![src.to_string_lossy().to_string()], &dst)
            .expect("move file");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert_eq!(moved[0].to, expected_to);
        assert!(!src.exists());
        assert_eq!(fs::read(dst.join("note.txt")).unwrap(), b"note");
    }

    #[cfg(unix)]
    #[test]
    fn move_paths_moves_symlink_itself_not_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let target = root.join("target.txt");
        let link = root.join("shortcut.txt");
        let dst = root.join("folder");
        fs::write(&target, b"target").unwrap();
        fs::create_dir(&dst).unwrap();
        symlink(&target, &link).unwrap();
        let expected_from = root
            .canonicalize()
            .unwrap()
            .join("shortcut.txt")
            .to_string_lossy()
            .to_string();
        let expected_to = dst
            .canonicalize()
            .unwrap()
            .join("shortcut.txt")
            .to_string_lossy()
            .to_string();

        let moved = move_paths_impl(root, vec![link.to_string_lossy().to_string()], &dst)
            .expect("move symlink entry");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert_eq!(moved[0].to, expected_to);
        assert!(!moved[0].is_dir);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(dst.join("shortcut.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_deduplicates_nested_selections_and_skips_same_parent() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let dir = root.join("src");
        let leaf = dir.join("leaf.txt");
        let already_there = dst.join("already.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(&leaf, b"leaf").unwrap();
        fs::write(&already_there, b"same parent").unwrap();
        let expected_from = dir.canonicalize().unwrap().to_string_lossy().to_string();

        let moved = move_paths_impl(
            root,
            vec![
                dir.to_string_lossy().to_string(),
                leaf.to_string_lossy().to_string(),
                already_there.to_string_lossy().to_string(),
            ],
            &dst,
        )
        .expect("move top-level selection");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert!(dst.join("src/leaf.txt").is_file());
    }

    #[test]
    fn move_paths_rejects_overwrite_and_duplicate_destinations() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let a = root.join("a").join("note.txt");
        let b = root.join("b").join("note.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let duplicate_err = move_paths_impl(
            root,
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
            &dst,
        )
        .unwrap_err();
        assert!(duplicate_err.contains("multiple moved items"));

        fs::write(dst.join("note.txt"), b"existing").unwrap();
        let exists_err =
            move_paths_impl(root, vec![a.to_string_lossy().to_string()], &dst).unwrap_err();
        assert!(exists_err.contains("already exists"));
    }

    #[cfg(unix)]
    #[test]
    fn move_paths_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let src = root.join("src").join("note.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, b"note").unwrap();
        let broken_destination = dst.join("note.txt");
        symlink(root.join("missing.txt"), &broken_destination).unwrap();
        assert!(!broken_destination.exists());

        let err = move_paths_impl(root, vec![src.to_string_lossy().to_string()], &dst)
            .expect_err("broken symlink destination must block overwrite");

        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(&src).unwrap(), b"note");
        assert!(std::fs::symlink_metadata(&broken_destination)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_rejects_root_trash_outside_and_self_descendant_moves() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("outside dir");
        let dir = root.join("dir");
        let nested = dir.join("nested");
        let trash = root.join(LYCEUM_TRASH_DIR);
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&trash).unwrap();

        assert!(
            move_paths_impl(root, vec![root.to_string_lossy().to_string()], &dir)
                .unwrap_err()
                .contains("workspace root")
        );
        assert!(move_paths_impl(
            root,
            vec![dir.to_string_lossy().to_string()],
            outside.path()
        )
        .unwrap_err()
        .contains("outside workspace"));
        assert!(
            move_paths_impl(root, vec![dir.to_string_lossy().to_string()], &nested)
                .unwrap_err()
                .contains("itself")
        );
        assert!(
            move_paths_impl(root, vec![dir.to_string_lossy().to_string()], &trash)
                .unwrap_err()
                .contains("Lyceum trash")
        );
    }

    #[test]
    fn restore_rejects_path_traversal_in_original_path() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        let item = TrashItemDto {
            original_path: root
                .join("../outside/note.txt")
                .to_string_lossy()
                .to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(err.contains("path traversal") || err.contains("outside workspace"));
    }

    #[test]
    fn restore_rejects_path_traversal_in_trash_path() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let item = TrashItemDto {
            original_path: root.join("note.txt").to_string_lossy().to_string(),
            trashed_path: root
                .join(LYCEUM_TRASH_DIR)
                .join("../outside/note.txt")
                .to_string_lossy()
                .to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(err.contains("path traversal") || err.contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root_buf = tmp.path().canonicalize().unwrap();
        let root = root_buf.as_path();
        let original = root.join("note.txt");
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        symlink(root.join("missing.txt"), &original).unwrap();
        assert!(!original.exists());
        let item = TrashItemDto {
            original_path: original.to_string_lossy().to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(&trashed).unwrap(), b"note");
        assert!(std::fs::symlink_metadata(&original)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn redo_moves_restored_broken_symlink_back_to_trash() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let link = root.join("broken-shortcut.txt");
        symlink(root.join("missing.txt"), &link).unwrap();
        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash broken symlink");

        restore_trash_batch_impl(root, batch.items.clone()).expect("restore broken symlink");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!link.exists());

        redo_trash_batch_impl(root, batch.items.clone()).expect("redo broken symlink delete");

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlinked_destination_ancestor_outside_workspace() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        symlink(outside.path(), root.join("link")).unwrap();
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        let item = TrashItemDto {
            original_path: root
                .join("link/nested/note.txt")
                .to_string_lossy()
                .to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(
            err.contains("resolves outside workspace") || err.contains("outside workspace"),
            "{err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlinked_trash_ancestor_outside_workspace() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        let trash_root = root.join(LYCEUM_TRASH_DIR);
        fs::create_dir_all(&trash_root).unwrap();
        fs::write(outside.path().join("note.txt"), b"note").unwrap();
        symlink(outside.path(), trash_root.join("link")).unwrap();
        let item = TrashItemDto {
            original_path: root.join("note.txt").to_string_lossy().to_string(),
            trashed_path: trash_root
                .join("link/note.txt")
                .to_string_lossy()
                .to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(
            err.contains("resolves outside workspace") || err.contains("outside workspace"),
            "{err}"
        );
    }
}
