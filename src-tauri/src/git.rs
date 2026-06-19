// Git status decorations for the file explorer (VS Code-style).
//
// `git_status` shells out to `git` once per refresh and returns a map of
// absolute path -> status string (modified / added / untracked / deleted /
// renamed / conflict), plus the owning repository root for each changed file.
// The frontend colors tree rows from this map and can distinguish the opened
// workspace repository from nested repositories under it.
//
// The pure parsing logic lives in `parse_porcelain_z` / `classify` so it can be
// unit-tested with `cargo test` (no git binary or Tauri runtime needed); the
// `#[tauri::command]` wrapper is thin and best-effort (any failure degrades to
// "not a repo" rather than surfacing an error to the UI).

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::path_access::{self, PathAccessManager};

/// Result of a workspace git-status query. `files` maps absolute paths to a
/// status string the frontend understands.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    /// True when the workspace lives inside or contains at least one git work tree.
    pub is_repo: bool,
    /// Top-level repository containing the opened workspace root, when any.
    pub root_repo: Option<String>,
    /// Repository roots queried for this workspace.
    pub repo_roots: Vec<String>,
    /// Absolute path -> status ("modified" | "added" | "untracked" |
    /// "deleted" | "renamed" | "conflict").
    pub files: HashMap<String, String>,
    /// Absolute path -> owning repository top-level path.
    pub file_repos: HashMap<String, String>,
}

/// Map a porcelain two-letter status (X = index, Y = work tree) to the small
/// vocabulary the frontend colors by. Conflicts take precedence, then new
/// (added/untracked), then deletion, then modification.
fn classify(x: char, y: char) -> &'static str {
    if x == '?' && y == '?' {
        return "untracked";
    }
    if x == '!' && y == '!' {
        return "ignored";
    }
    // Unmerged / conflict states: any 'U', or the symmetric add/delete pairs.
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return "conflict";
    }
    if x == 'R' || y == 'R' {
        return "renamed";
    }
    if x == 'A' || y == 'A' || x == 'C' || y == 'C' {
        return "added";
    }
    if x == 'D' || y == 'D' {
        return "deleted";
    }
    // M (modified), T (type change), and anything else tracked -> modified.
    "modified"
}

/// Parse the output of `git status --porcelain -z` into (relative path, status)
/// pairs. Records are NUL-separated; each is `XY<space><path>`. For rename/copy
/// entries git appends the *source* path as a second NUL field (with `-z` the
/// field order is `to\0from`), which we consume and ignore — the destination
/// path is the one shown in the tree. Ignored entries are dropped.
pub fn parse_porcelain_z(out: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(tok) = tokens.next() {
        // Need at least "XY " plus one path char.
        if tok.len() < 4 {
            continue;
        }
        let bytes = tok.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &tok[3..];
        let is_rename = x == 'R' || y == 'R' || x == 'C' || y == 'C';
        if is_rename {
            // Consume (and discard) the paired source path.
            let _ = tokens.next();
        }
        let status = classify(x, y);
        if status == "ignored" || path.is_empty() {
            continue;
        }
        result.push((path.to_string(), status.to_string()));
    }
    result
}

/// Resolve the `git` executable, honoring PATH plus the same GUI-app fallback
/// locations the Julia/LaTeX resolvers use (a bundled macOS app inherits a
/// minimal PATH that often omits /usr/bin).
fn git_program() -> OsString {
    let path = env::var_os("PATH");
    let home = env::var_os("HOME");
    let search = crate::julia::augmented_path(path.as_deref(), home.as_deref());
    crate::julia::find_program_in_path("git", &search)
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| OsString::from("git"))
}

/// Run git with `args` in `cwd`, returning stdout on success (exit 0) or None
/// on any failure (git missing, non-zero exit, spawn error).
fn run_git(program: &OsString, cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn repo_top_level(program: &OsString, cwd: &Path) -> Option<PathBuf> {
    let top = run_git(program, cwd, &["rev-parse", "--show-toplevel"])?;
    // Trim ONLY the trailing line terminator git appends — not all whitespace, or
    // a repo whose top-level directory name legitimately ends in a space would be
    // turned into a nonexistent path, silently dropping every git decoration.
    let trimmed = top.trim_end_matches(['\n', '\r']);
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn has_git_marker(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn is_skipped_walk_dir(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|s| s.to_str()),
        Some(".git" | ".lyceum-trash" | "node_modules" | "target" | "dist" | ".vite")
    )
}

fn discover_git_markers(root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if has_git_marker(&dir) {
            roots.push(dir.clone());
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if is_skipped_walk_dir(&path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
            }
        }
    }

    roots.sort();
    roots
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// Return git status for the workspace as absolute-path -> status. Best-effort:
/// when `root` is not inside or containing a git work tree (or git is unavailable) this
/// returns `{ is_repo: false, files: {} }` rather than an error.
#[tauri::command]
pub fn git_status(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
) -> GitStatusDto {
    let empty = || GitStatusDto {
        is_repo: false,
        root_repo: None,
        repo_roots: Vec::new(),
        files: HashMap::new(),
        file_repos: HashMap::new(),
    };
    // Canonicalize the root, mirroring walk.rs/search.rs/workspace_watch.rs.
    // `git rev-parse --show-toplevel` always returns a canonical, symlink-free
    // path, so `top_path.join(rel)` is canonical; if `root_path` still contained
    // a symlinked component (e.g. macOS `/tmp` -> `/private/tmp`) then
    // `path_is_within` would reject every file and ALL decorations would silently
    // drop. Canonicalizing here makes both sides agree. (The workspace-open flow
    // also canonicalizes the root so the Explorer tree's keys match these.)
    let root_path =
        match path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root)) {
            Ok(path) => path,
            Err(_) => return empty(),
        };
    let root_path = root_path.as_path();
    if !root_path.is_dir() {
        return empty();
    }
    let program = git_program();
    let root_repo = repo_top_level(&program, root_path);

    // Query the repository containing the opened root, plus any nested
    // repositories that have their own .git marker under the workspace.
    let mut seen = HashSet::new();
    let mut repo_roots = Vec::<PathBuf>::new();
    if let Some(top) = &root_repo {
        seen.insert(path_string(top));
        repo_roots.push(top.clone());
    }
    for marker_root in discover_git_markers(root_path) {
        if let Some(top) = repo_top_level(&program, &marker_root) {
            let key = path_string(&top);
            if seen.insert(key) {
                repo_roots.push(top);
            }
        }
    }
    if repo_roots.is_empty() {
        return empty();
    }
    repo_roots.sort_by_key(|p| p.components().count());

    let mut files = HashMap::new();
    let mut file_repos = HashMap::new();
    for top_path in &repo_roots {
        let out = match run_git(
            &program,
            top_path,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
        ) {
            Some(s) => s,
            None => continue,
        };
        let repo = path_string(top_path);
        for (rel, status) in parse_porcelain_z(&out) {
            let abs = top_path.join(&rel);
            if !path_is_within(&abs, root_path) {
                continue;
            }
            let path = path_string(&abs);
            files.insert(path.clone(), status);
            file_repos.insert(path, repo.clone());
        }
    }
    GitStatusDto {
        is_repo: true,
        root_repo: root_repo.map(|p| path_string(&p)),
        repo_roots: repo_roots.iter().map(|p| path_string(p)).collect(),
        files,
        file_repos,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_states() {
        assert_eq!(classify('?', '?'), "untracked");
        assert_eq!(classify('!', '!'), "ignored");
        assert_eq!(classify(' ', 'M'), "modified");
        assert_eq!(classify('M', ' '), "modified");
        assert_eq!(classify('M', 'M'), "modified");
        assert_eq!(classify('A', ' '), "added");
        assert_eq!(classify(' ', 'D'), "deleted");
        assert_eq!(classify('R', ' '), "renamed");
        assert_eq!(classify('U', 'U'), "conflict");
        assert_eq!(classify('A', 'A'), "conflict");
        assert_eq!(classify('D', 'D'), "conflict");
        assert_eq!(classify('T', ' '), "modified");
    }

    #[test]
    fn parses_ordinary_entries() {
        // " M file.rs\0?? new.txt\0M  staged.rs\0"
        let out = " M file.rs\0?? new.txt\0M  staged.rs\0";
        let got = parse_porcelain_z(out);
        assert_eq!(
            got,
            vec![
                ("file.rs".to_string(), "modified".to_string()),
                ("new.txt".to_string(), "untracked".to_string()),
                ("staged.rs".to_string(), "modified".to_string()),
            ]
        );
    }

    #[test]
    fn rename_consumes_source_path_and_keeps_destination() {
        // With -z a rename is "R  dest\0src\0"; only the destination is decorated.
        let out = "R  new_name.rs\0old_name.rs\0 M other.rs\0";
        let got = parse_porcelain_z(out);
        assert_eq!(
            got,
            vec![
                ("new_name.rs".to_string(), "renamed".to_string()),
                ("other.rs".to_string(), "modified".to_string()),
            ]
        );
    }

    #[test]
    fn drops_ignored_and_trailing_empty_records() {
        let out = "!! target/\0 M keep.rs\0";
        let got = parse_porcelain_z(out);
        assert_eq!(got, vec![("keep.rs".to_string(), "modified".to_string())]);
    }

    #[test]
    fn paths_with_spaces_are_preserved() {
        let out = "?? a file with spaces.txt\0";
        let got = parse_porcelain_z(out);
        assert_eq!(
            got,
            vec![(
                "a file with spaces.txt".to_string(),
                "untracked".to_string()
            )]
        );
    }

    #[test]
    fn discovers_nested_git_markers_and_skips_heavy_dirs() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("pkg")).unwrap();
        fs::write(
            root.join("pkg").join(".git"),
            b"gitdir: ../.git/modules/pkg",
        )
        .unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::create_dir(root.join("node_modules").join("dep")).unwrap();
        fs::create_dir(root.join("node_modules").join("dep").join(".git")).unwrap();

        let roots = discover_git_markers(root);

        assert!(roots.iter().any(|p| p == root));
        assert!(roots.iter().any(|p| p == &root.join("pkg")));
        assert!(!roots
            .iter()
            .any(|p| p == &root.join("node_modules").join("dep")));
    }
}
