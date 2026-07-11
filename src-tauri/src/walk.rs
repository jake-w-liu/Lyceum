// Recursive workspace file listing for the quick-open command palette (M4).
//
// The pure walk logic lives in `list_files` so it can be unit-tested with
// `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrapper is
// thin. Skipped directories (.git, node_modules, etc.) are never descended into.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::path_access::{self, PathAccessManager};
use crate::workspace_paths::{
    path_resolves_into_workspace_trash, path_resolves_through_workspace_names,
};

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".vite"];

/// Recursively collect absolute file paths under `root`, skipping a fixed set of
/// directories. Stops once `max` files have been collected, then sorts the
/// result. Returns an error string if `root` is not a directory.
pub fn list_files(root: &Path, max: usize) -> Result<Vec<String>, String> {
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("{}: {e}", root.display()))?;
    if !root_canonical.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    let mut files: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    // Canonical paths of directories already walked. Guards against descending
    // the same tree twice and against symlink cycles. Seeded with `root`.
    let mut visited: HashSet<PathBuf> = HashSet::new();
    visited.insert(root_canonical.clone());

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
            let path = entry.path();
            if path_resolves_into_workspace_trash(root, &path)
                || path_resolves_through_workspace_names(root, &path, &[".git"], &SKIP_DIRS)
            {
                continue;
            }
            // Resolve the REAL kind: file_type() reports a symlink as a symlink
            // (is_dir() == false), so a symlinked directory would otherwise be
            // recorded as a bogus "file" that fails to open. Follow the link.
            let is_dir = if file_type.is_symlink() {
                match std::fs::metadata(&path) {
                    Ok(meta) => meta.is_dir(),
                    Err(_) => continue, // broken symlink — skip
                }
            } else {
                file_type.is_dir()
            };
            if is_dir {
                // Canonicalize before descending so a tree reachable via a
                // symlink (or two paths) is walked at most once.
                match path.canonicalize() {
                    Ok(canon) => {
                        if !canon.starts_with(&root_canonical) {
                            continue;
                        }
                        if !visited.insert(canon) {
                            continue;
                        }
                    }
                    Err(_) => continue,
                }
                stack.push(path);
            } else {
                if files.len() >= max {
                    break;
                }
                let Ok(canon) = path.canonicalize() else {
                    continue;
                };
                if !canon.starts_with(&root_canonical) {
                    continue;
                }
                files.push(path.to_string_lossy().to_string());
            }
        }
    }

    files.sort();
    Ok(files)
}

/// List workspace files (absolute paths) under `root` for quick-open, capped at
/// 5000 entries.
#[tauri::command]
pub fn list_workspace_files(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
) -> Result<Vec<String>, String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    list_files(&root, 5000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn path_ends_with(path: &str, suffix: &[&str]) -> bool {
        let mut suffix_path = PathBuf::new();
        for part in suffix {
            suffix_path.push(part);
        }
        Path::new(path).ends_with(suffix_path)
    }

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

        assert!(files.iter().any(|f| path_ends_with(f, &["src", "a.rs"])));
        assert!(files.iter().any(|f| path_ends_with(f, &["src", "b.rs"])));
        assert!(!files.iter().any(|f| f.contains("node_modules")));
        assert!(!files.iter().any(|f| f.contains(".git")));
    }

    #[test]
    fn excludes_lyceum_trash() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".lyceum-trash")).unwrap();
        fs::write(root.join("keep.txt"), b"x").unwrap();
        fs::write(root.join(".lyceum-trash").join("deleted.txt"), b"x").unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files.iter().any(|f| f.ends_with("keep.txt")));
        assert!(!files.iter().any(|f| f.contains(".lyceum-trash")));
    }

    #[test]
    fn regular_file_named_like_a_heavy_directory_remains_visible() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("target"), b"ordinary file").unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert_eq!(files, [root.join("target").to_string_lossy().to_string()]);
    }

    #[test]
    fn includes_nested_trash_named_directories() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let nested = root.join("docs").join(".lyceum-trash");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("visible.txt"), b"visible").unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files
            .iter()
            .any(|path| path_ends_with(path, &["docs", ".lyceum-trash", "visible.txt"])));
    }

    #[test]
    fn excludes_a_case_aliased_root_trash_entry_when_the_filesystem_aliases_it() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper = root.join(".LYCEUM-TRASH");
        fs::create_dir(&upper).unwrap();
        fs::write(upper.join("internal.txt"), b"internal").unwrap();
        if !root.join(".lyceum-trash").exists() {
            return;
        }

        let files = list_files(root, 5000).expect("walk");

        assert!(files.is_empty());
    }

    #[test]
    fn excludes_the_reserved_root_trash_name_even_when_it_is_a_file() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join(".lyceum-trash"), b"must stay internal").unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files.is_empty());
    }

    #[test]
    fn excludes_gitdir_pointer_files_before_kind_dispatch() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join(".git"), b"gitdir: ../metadata").unwrap();

        assert!(list_files(root, 5000).unwrap().is_empty());
    }

    #[test]
    fn case_aliased_git_and_heavy_directories_follow_filesystem_identity() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper_git = root.join(".GIT");
        let upper_modules = root.join("NODE_MODULES");
        fs::create_dir(&upper_git).unwrap();
        fs::create_dir(&upper_modules).unwrap();
        fs::write(upper_git.join("config"), b"git metadata").unwrap();
        fs::write(upper_modules.join("dependency.js"), b"dependency").unwrap();
        let aliases = root.join(".git").exists();

        let files = list_files(root, 5000).unwrap();

        if aliases {
            assert!(files.is_empty());
        } else {
            assert_eq!(files.len(), 2);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_alias_to_git_metadata_is_not_listed() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("secret"), b"metadata").unwrap();
        symlink(".git", root.join("git-link")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules").join("dependency.js"),
            b"dependency",
        )
        .unwrap();
        symlink("node_modules", root.join("deps-link")).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::create_dir(root.join("nested").join(".git")).unwrap();
        fs::write(
            root.join("nested").join(".git").join("cross-parent-secret"),
            b"metadata",
        )
        .unwrap();
        symlink("nested/.git", root.join("nested-git-link")).unwrap();
        fs::create_dir(root.join("nested").join("node_modules")).unwrap();
        fs::write(
            root.join("nested")
                .join("node_modules")
                .join("cross-parent-dependency.js"),
            b"dependency",
        )
        .unwrap();
        symlink("nested/node_modules", root.join("nested-deps-link")).unwrap();

        assert!(list_files(root, 5000).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn file_symlinks_into_git_and_heavy_directories_are_not_listed() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("config"), b"metadata").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules").join("dependency.js"),
            b"dependency",
        )
        .unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        symlink("../.git/config", root.join("docs").join("config-link")).unwrap();
        symlink(
            "../node_modules/dependency.js",
            root.join("docs").join("dependency-link"),
        )
        .unwrap();

        assert!(list_files(root, 5000).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn aliases_into_root_workspace_trash_are_not_listed() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".lyceum-trash")).unwrap();
        fs::write(root.join(".lyceum-trash").join("deleted.txt"), b"deleted").unwrap();
        symlink(".lyceum-trash", root.join("trash-link")).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        symlink(
            "../.lyceum-trash/deleted.txt",
            root.join("docs").join("deleted-link"),
        )
        .unwrap();

        assert!(list_files(root, 5000).unwrap().is_empty());
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
    fn symlinked_directory_is_descended_not_listed_as_a_file() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("inner.txt"), b"x").unwrap();
        // A symlink to the real dir must not appear as a file; its contents
        // should be reachable, and the file must not be double-listed.
        std::os::unix::fs::symlink(&real, root.join("link")).unwrap();

        let files = list_files(root, 5000).expect("walk");

        // The symlink path itself is never recorded as a file entry.
        assert!(!files.iter().any(|f| f.ends_with("/link")));
        // The file under the real dir is found exactly once.
        let inner: Vec<_> = files.iter().filter(|f| f.ends_with("inner.txt")).collect();
        assert_eq!(inner.len(), 1, "inner.txt should be listed exactly once");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cycle_does_not_hang() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("f.txt"), b"x").unwrap();
        // sub/loop -> root, forming a cycle. The visited-canonical guard must
        // terminate the walk rather than recursing forever.
        std::os::unix::fs::symlink(root, sub.join("loop")).unwrap();

        let files = list_files(root, 5000).expect("walk terminates");
        assert!(files.iter().any(|f| f.ends_with("f.txt")));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_outside_root_is_not_listed() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        fs::write(outside.path().join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("outside-link")).unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_file_outside_root_is_not_listed() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, b"x").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("secret-link.txt")).unwrap();

        let files = list_files(root, 5000).expect("walk");

        assert!(files.is_empty());
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
