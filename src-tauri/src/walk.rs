// Recursive workspace file listing for the quick-open command palette (M4).
//
// The pure walk logic lives in `list_files` so it can be unit-tested with
// `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrapper is
// thin. Skipped directories (.git, node_modules, etc.) are never descended into.

use std::path::Path;

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".vite"];

/// Recursively collect absolute file paths under `root`, skipping a fixed set of
/// directories. Stops once `max` files have been collected, then sorts the
/// result. Returns an error string if `root` is not a directory.
pub fn list_files(root: &Path, max: usize) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    let mut files: Vec<String> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if files.len() >= max {
            break;
        }

        // Best-effort: an unreadable subdirectory (permission denied, removed
        // mid-walk, OS-protected) must not abort the entire workspace listing —
        // otherwise one bad folder makes quick-open show zero files. Skip it and
        // continue. (The top-level `root` was already validated above.)
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
            } else {
                if files.len() >= max {
                    break;
                }
                files.push(entry.path().to_string_lossy().to_string());
            }
        }
    }

    files.sort();
    Ok(files)
}

/// List workspace files (absolute paths) under `root` for quick-open, capped at
/// 5000 entries.
#[tauri::command]
pub fn list_workspace_files(root: String) -> Result<Vec<String>, String> {
    list_files(Path::new(&root), 5000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn errors_on_non_directory() {
        let result = list_files(Path::new("/this/path/should/not/exist/lyceum"), 5000);
        assert!(result.is_err());
    }

    #[test]
    fn collects_files_and_excludes_skipped_dirs() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join("src").join("a.rs"), b"a").unwrap();
        fs::write(root.join("src").join("b.rs"), b"b").unwrap();
        fs::write(root.join("node_modules").join("x.js"), b"x").unwrap();
        fs::write(root.join(".git").join("config"), b"c").unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files.iter().any(|f| f.ends_with("src/a.rs")));
        assert!(files.iter().any(|f| f.ends_with("src/b.rs")));
        assert!(!files.iter().any(|f| f.contains("node_modules")));
        assert!(!files.iter().any(|f| f.contains(".git")));
    }

    #[test]
    fn result_is_sorted_and_absolute() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("z.txt"), b"z").unwrap();
        fs::write(root.join("a.txt"), b"a").unwrap();

        let files = list_files(root, 5000).expect("walk");
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
        assert!(files.iter().all(|f| Path::new(f).is_absolute()));
    }

    #[test]
    fn respects_max_cap() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        for i in 0..10 {
            fs::write(root.join(format!("f{i}.txt")), b"x").unwrap();
        }

        let files = list_files(root, 3).expect("walk");
        assert_eq!(files.len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_is_skipped_not_fatal() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("visible.txt"), b"x").unwrap();
        let locked = root.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("hidden.txt"), b"y").unwrap();
        // Remove read/execute so the walk cannot list `locked`'s children.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let files = list_files(root, 5000).expect("walk must succeed despite locked dir");

        // Restore perms so tempdir cleanup can remove it.
        let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o755));

        assert!(files.iter().any(|f| f.ends_with("visible.txt")));
        assert!(!files.iter().any(|f| f.ends_with("hidden.txt")));
    }
}
