// Git status decorations for the file explorer (VS Code-style).
//
// `git_status` shells out to `git` once per refresh and returns a map of
// absolute path -> status string (modified / added / untracked / deleted /
// renamed / conflict). The frontend colors tree rows from this map (modified =
// orange, new/untracked = green, deleted/conflict = red) and rolls the status
// up to parent folders.
//
// The pure parsing logic lives in `parse_porcelain_z` / `classify` so it can be
// unit-tested with `cargo test` (no git binary or Tauri runtime needed); the
// `#[tauri::command]` wrapper is thin and best-effort (any failure degrades to
// "not a repo" rather than surfacing an error to the UI).

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

/// Result of a workspace git-status query. `files` maps absolute paths to a
/// status string the frontend understands.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    /// True when the workspace lives inside a git work tree.
    pub is_repo: bool,
    /// Absolute path -> status ("modified" | "added" | "untracked" |
    /// "deleted" | "renamed" | "conflict").
    pub files: HashMap<String, String>,
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
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Return git status for the workspace as absolute-path -> status. Best-effort:
/// when `root` is not inside a git work tree (or git is unavailable) this
/// returns `{ is_repo: false, files: {} }` rather than an error.
#[tauri::command]
pub fn git_status(root: String) -> GitStatusDto {
    let empty = || GitStatusDto {
        is_repo: false,
        files: HashMap::new(),
    };
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return empty();
    }
    let program = git_program();

    // The repo top-level anchors the relative paths git prints; the workspace
    // may be opened at a subdirectory of the repo.
    let top = match run_git(&program, root_path, &["rev-parse", "--show-toplevel"]) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return empty(),
    };
    let top_path = Path::new(&top);

    let out = match run_git(
        &program,
        root_path,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    ) {
        Some(s) => s,
        // Inside a repo but status failed: report repo with no decorations.
        None => {
            return GitStatusDto {
                is_repo: true,
                files: HashMap::new(),
            }
        }
    };

    let mut files = HashMap::new();
    for (rel, status) in parse_porcelain_z(&out) {
        let abs = top_path.join(&rel);
        files.insert(abs.to_string_lossy().into_owned(), status);
    }
    GitStatusDto {
        is_repo: true,
        files,
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
}
