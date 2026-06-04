// Filesystem operations exposed to the frontend for the file explorer (M2).
//
// The pure listing logic lives in `read_dir_entries` so it can be unit-tested
// with `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrappers
// are thin. Directory reads are explicit, on-demand (lazy) reads — no recursive
// walking or background indexing (a v1 non-goal).

use std::path::Path;

use serde::Serialize;

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
}
