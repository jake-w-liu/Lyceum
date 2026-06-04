// Filesystem operations exposed to the frontend for the file explorer (M2).
//
// The pure listing logic lives in `read_dir_entries` so it can be unit-tested
// with `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrappers
// are thin. Directory reads are explicit, on-demand (lazy) reads — no recursive
// walking or background indexing (a v1 non-goal).

use std::path::{Path, PathBuf};
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
    if target.exists() {
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
    if Path::new(&to).exists() {
        return Err(format!("already exists: {to}"));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// Delete `path`, recursively removing directory trees and unlinking files.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| format!("{path}: {e}"))
    } else {
        std::fs::remove_file(target).map_err(|e| format!("{path}: {e}"))
    }
}

#[tauri::command]
pub fn delete_file_if_exists(path: String) -> Result<bool, String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Ok(false);
    }
    if target.is_dir() {
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
    for target in targets {
        let rel = target
            .strip_prefix(&root)
            .map_err(|e| format!("{}: {e}", target.display()))?;
        let destination = batch_dir.join(rel);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let is_dir = target.is_dir();
        std::fs::rename(&target, &destination)
            .map_err(|e| format!("{} -> {}: {e}", target.display(), destination.display()))?;
        items.push(TrashItemDto {
            original_path: target.to_string_lossy().to_string(),
            trashed_path: destination.to_string_lossy().to_string(),
            is_dir,
        });
    }

    Ok(TrashBatchDto { id, items })
}

fn restore_trash_batch_impl(root: &Path, items: Vec<TrashItemDto>) -> Result<(), String> {
    let root = canonical_dir(root)?;
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        validate_restore_pair(&root, &original, &trashed)?;
        if original.exists() {
            return Err(format!(
                "restore destination already exists: {}",
                original.display()
            ));
        }
    }
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        if let Some(parent) = original.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::rename(&trashed, &original)
            .map_err(|e| format!("{} -> {}: {e}", trashed.display(), original.display()))?;
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
        if !original.exists() {
            return Err(format!(
                "redo source does not exist: {}",
                original.display()
            ));
        }
        if trashed.exists() {
            return Err(format!(
                "redo destination already exists: {}",
                trashed.display()
            ));
        }
    }
    for item in &items {
        let original = PathBuf::from(&item.original_path);
        let trashed = PathBuf::from(&item.trashed_path);
        if let Some(parent) = trashed.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::rename(&original, &trashed)
            .map_err(|e| format!("{} -> {}: {e}", original.display(), trashed.display()))?;
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

fn normalize_delete_targets(root: &Path, paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let mut targets = Vec::new();
    for raw in paths {
        let target = Path::new(&raw)
            .canonicalize()
            .map_err(|e| format!("{raw}: {e}"))?;
        validate_workspace_target(root, &target)?;
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets.sort_by_key(|p| p.components().count());
    let mut top_level: Vec<PathBuf> = Vec::new();
    for target in targets {
        if !top_level.iter().any(|parent| target.starts_with(parent)) {
            top_level.push(target);
        }
    }
    Ok(top_level)
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

fn validate_restore_pair(root: &Path, original: &Path, trashed: &Path) -> Result<(), String> {
    let original_parent = original
        .parent()
        .ok_or_else(|| format!("invalid restore path: {}", original.display()))?;
    let canonical_parent = original_parent
        .canonicalize()
        .unwrap_or_else(|_| original_parent.to_path_buf());
    if !canonical_parent.starts_with(root) {
        return Err(format!(
            "restore destination outside workspace: {}",
            original.display()
        ));
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
}
