// Workspace content search (case-insensitive substring) for the find-in-files
// feature. The pure walk + match logic lives in `search_in_dir` so it can be
// unit-tested with `cargo test` (no Tauri runtime needed). The
// `#[tauri::command]` wrapper is thin. Skipped directories (.git, node_modules,
// etc.) are never descended into, mirroring `walk.rs`.

use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::path_access::{self, PathAccessManager};
use crate::workspace_paths::{
    path_resolves_into_workspace_trash, path_resolves_through_workspace_names,
};

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".vite"];

/// Files larger than this are skipped, so a single huge file (a multi-GB log or
/// dataset that happens to be valid UTF-8) cannot be slurped wholesale into a
/// heap String. Mirrors the bound `lsp.rs` places on a single message.
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;

/// Byte offsets (each a char boundary in `line`) of up to `limit` non-overlapping
/// case-insensitive matches of `needle_lower`, which must already be lowercased,
/// in order. The line is case-folded AT MOST ONCE (the Unicode path), so a line
/// with k matches costs O(line_len), not O(line_len * k) — re-folding the shrinking
/// suffix per match froze the synchronous search command for tens of seconds on a
/// multi-megabyte single non-ASCII line. The all-ASCII path allocates nothing.
fn match_offsets(line: &str, needle_lower: &str, limit: usize) -> Vec<usize> {
    let mut starts = Vec::new();
    if needle_lower.is_empty() || limit == 0 {
        return starts;
    }
    if line.is_ascii() && needle_lower.is_ascii() {
        let hay = line.as_bytes();
        let needle = needle_lower.as_bytes();
        if needle.len() > hay.len() {
            return starts;
        }
        let mut i = 0usize;
        while i + needle.len() <= hay.len() {
            if hay[i..i + needle.len()].eq_ignore_ascii_case(needle) {
                starts.push(i);
                if starts.len() >= limit {
                    return starts;
                }
                i += needle.len(); // non-overlapping
            } else {
                i += 1;
            }
        }
        return starts;
    }
    // Unicode: fold the whole line ONCE. `origin[b]` = byte offset in `line` of the
    // source char that produced lowered byte `b` (always a valid `line` char
    // boundary). Case folding is not 1:1 in length — e.g. 'İ' (U+0130) lowercases
    // to "i\u{0307}" — so a fixed char-window scan would silently drop matches; we
    // scan the lowercased copy and map positions back through `origin`.
    let mut lowered = String::with_capacity(line.len());
    let mut origin: Vec<usize> = Vec::with_capacity(line.len());
    for (byte_idx, ch) in line.char_indices() {
        for lc in ch.to_lowercase() {
            for _ in 0..lc.len_utf8() {
                origin.push(byte_idx);
            }
            lowered.push(lc);
        }
    }
    let needle_len = needle_lower.len();
    let mut cursor = 0usize; // byte offset within `lowered`
    while let Some(rel) = lowered[cursor..].find(needle_lower) {
        let mb = cursor + rel;
        starts.push(origin[mb]);
        if starts.len() >= limit {
            break;
        }
        // Advance past the matched needle AND the remainder of the last contributing
        // original char's lowercase expansion, so a partial-expansion match (needle
        // "i" vs 'İ' -> "i\u{0307}") still skips the whole 'İ'. `origin` is
        // non-decreasing, so this walks only that one char's bytes — O(line_len)
        // total across the loop.
        let last_src = origin[mb + needle_len - 1];
        cursor = mb + needle_len;
        while cursor < origin.len() && origin[cursor] == last_src {
            cursor += 1;
        }
    }
    starts
}

/// Largest per-match line snippet returned to the frontend, in bytes. A match on
/// a multi-megabyte single line (e.g. a minified bundle) must not clone the whole
/// line once per match — that is gigabytes of Strings and IPC payload. The search
/// UI only needs a snippet to display, so the stored `text` is truncated on a
/// char boundary. Column/line are still computed against the full line.
const MAX_LINE_SNIPPET: usize = 2000;

/// Truncate `line` to at most `MAX_LINE_SNIPPET` bytes on a UTF-8 char boundary.
fn line_snippet(line: &str) -> String {
    if line.len() <= MAX_LINE_SNIPPET {
        return line.to_string();
    }
    let mut end = MAX_LINE_SNIPPET;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].to_string()
}

/// A single matching line within a workspace file. Line and column are 1-based;
/// `text` is the matching line with any trailing newline trimmed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

/// Recursively search files under `root` for lines containing `query`
/// (case-insensitive substring), skipping a fixed set of directories. Files
/// that cannot be read or are not valid UTF-8 are skipped silently. Stops once
/// `max` matches have been collected, then sorts by path then line. An empty
/// query returns an empty vec.
pub fn search_in_dir(root: &Path, query: &str, max: usize) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("{}: {e}", root.display()))?;
    if !root_canonical.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    // Fold the needle char-by-char (NOT String::to_lowercase, which applies
    // context-sensitive rules like the Greek final-sigma) so it uses the IDENTICAL
    // fold as the haystack in match_offsets — otherwise a word ending in capital
    // sigma (Σ -> ς vs σ) would never match. ASCII folding is identical either way.
    let needle: String = query.chars().flat_map(|c| c.to_lowercase()).collect();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    // Canonical paths of directories already walked. Guards against descending
    // the same tree twice and against symlink cycles (mirrors walk.rs).
    let mut visited: HashSet<PathBuf> = HashSet::new();
    visited.insert(root_canonical.clone());

    while let Some(dir) = stack.pop() {
        if matches.len() >= max {
            break;
        }

        // Best-effort: an unreadable subdirectory (permission denied, removed
        // mid-walk) must not abort the whole search and blank the results panel.
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
            // (is_dir() == false), so a symlinked directory would otherwise fall
            // into the file branch and its subtree would be silently skipped.
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
                // symlink (or two paths) is searched at most once.
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
                continue;
            }

            if matches.len() >= max {
                break;
            }

            // Skip files too large to read into memory safely. Stat the RESOLVED
            // target (`fs::metadata` follows symlinks) rather than `entry.metadata()`
            // (which reports the symlink's own tiny size) — otherwise a symlink to a
            // multi-GB file would pass the cap and then be slurped by read_to_string,
            // which DOES follow the link. Skip outright if the target can't be stat'd.
            let Ok(canonical_file) = path.canonicalize() else {
                continue;
            };
            if !canonical_file.starts_with(&root_canonical) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&canonical_file) else {
                continue;
            };
            // Only read regular files. A non-regular entry — a FIFO/named pipe,
            // socket, or device — reports len()==0 (passing the size cap) and a
            // blocking `read_to_string` on a FIFO with no writer would hang this
            // synchronous command forever, leaking a Tauri worker thread and
            // wedging the search UI on "Searching…". `metadata` already followed
            // any symlink, so this also reflects the real target's kind.
            if !meta.is_file() {
                continue;
            }
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
            // Re-enforce the cap while reading. The file can grow after metadata()
            // above; read_to_string alone would then allocate until EOF and defeat
            // the explicit 16 MiB resource bound.
            let mut contents = String::new();
            let contents = match std::fs::File::open(&canonical_file).and_then(|file| {
                file.take(MAX_FILE_SIZE.saturating_add(1))
                    .read_to_string(&mut contents)?;
                if contents.len() as u64 > MAX_FILE_SIZE {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::FileTooLarge,
                        "file grew beyond workspace-search size limit",
                    ));
                }
                Ok(contents)
            }) {
                Ok(contents) => contents,
                Err(_) => continue,
            };
            let path_str = path.to_string_lossy().to_string();

            for (index, raw_line) in contents.lines().enumerate() {
                if matches.len() >= max {
                    break;
                }
                // Snippet is cloned once per matching line, not once per match.
                let snippet = line_snippet(raw_line);
                // Report EVERY occurrence on the line (not just the first), folding
                // the line at most once (see match_offsets) and capping at the
                // remaining global budget. `match_offsets` returns ascending,
                // char-boundary byte offsets, so the UTF-16 column count below is
                // accumulated incrementally — keeping the whole line O(line_len).
                let mut prev_byte = 0usize;
                let mut prev_utf16 = 0u32;
                for byte_offset in match_offsets(raw_line, &needle, max - matches.len()) {
                    // Column is measured in UTF-16 code units, because Monaco (the
                    // frontend editor that consumes this column) measures columns
                    // in UTF-16 units. Counting chars (Unicode scalars) would place
                    // the cursor too far left by one per preceding astral character.
                    prev_utf16 += raw_line[prev_byte..byte_offset].encode_utf16().count() as u32;
                    prev_byte = byte_offset;
                    matches.push(SearchMatch {
                        path: path_str.clone(),
                        line: index as u32 + 1,
                        column: prev_utf16 + 1,
                        text: snippet.clone(),
                    });
                }
            }
        }
    }

    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(matches)
}

/// Search workspace file contents under `root` for `query`, capped at 1000
/// matches.
#[tauri::command]
pub fn search_workspace(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    search_in_dir(&root, &query, 1000)
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
    fn finds_substring_with_path_line_and_column() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("src").join("a.txt"),
            b"hello world\nthe quick fox\nanother line\n",
        )
        .unwrap();

        let matches = search_in_dir(root, "quick", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert!(path_ends_with(&m.path, &["src", "a.txt"]));
        assert_eq!(m.line, 2);
        assert_eq!(m.column, 5);
        assert_eq!(m.text, "the quick fox");
    }

    #[test]
    fn search_is_case_insensitive() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("b.txt"), b"a FOO bar\n").unwrap();

        let matches = search_in_dir(root, "foo", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[0].column, 3);
        assert_eq!(matches[0].text, "a FOO bar");
    }

    #[test]
    fn excludes_node_modules() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("keep.txt"), b"target line\n").unwrap();
        fs::write(root.join("node_modules").join("dep.txt"), b"target line\n").unwrap();

        let matches = search_in_dir(root, "target", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("keep.txt"));
        assert!(!matches.iter().any(|m| m.path.contains("node_modules")));
    }

    #[test]
    fn regular_file_named_like_a_heavy_directory_remains_searchable() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("target"), b"ordinary searchable file").unwrap();

        let matches = search_in_dir(root, "searchable", 100).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("target"));
    }

    #[test]
    fn excludes_lyceum_trash() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".lyceum-trash")).unwrap();
        fs::write(root.join("keep.txt"), b"target line\n").unwrap();
        fs::write(
            root.join(".lyceum-trash").join("deleted.txt"),
            b"target line\n",
        )
        .unwrap();

        let matches = search_in_dir(root, "target", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("keep.txt"));
        assert!(!matches.iter().any(|m| m.path.contains(".lyceum-trash")));
    }

    #[test]
    fn searches_nested_trash_named_directories() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let nested = root.join("docs").join(".lyceum-trash");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("visible.txt"), b"find nested content").unwrap();

        let matches = search_in_dir(root, "nested content", 100).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(Path::new(&matches[0].path)
            .ends_with(Path::new("docs").join(".lyceum-trash").join("visible.txt")));
    }

    #[test]
    fn excludes_a_case_aliased_root_trash_entry_when_the_filesystem_aliases_it() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper = root.join(".LYCEUM-TRASH");
        fs::create_dir(&upper).unwrap();
        fs::write(upper.join("internal.txt"), b"secret needle").unwrap();
        if !root.join(".lyceum-trash").exists() {
            return;
        }

        let matches = search_in_dir(root, "secret needle", 100).expect("search");

        assert!(matches.is_empty());
    }

    #[test]
    fn excludes_the_reserved_root_trash_name_even_when_it_is_a_file() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join(".lyceum-trash"), b"secret needle").unwrap();

        let matches = search_in_dir(root, "secret needle", 100).expect("search");

        assert!(matches.is_empty());
    }

    #[test]
    fn excludes_gitdir_pointer_files_before_kind_dispatch() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join(".git"), b"secret needle").unwrap();

        assert!(search_in_dir(root, "secret needle", 100)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn case_aliased_git_and_heavy_directories_follow_filesystem_identity() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper_git = root.join(".GIT");
        let upper_modules = root.join("NODE_MODULES");
        fs::create_dir(&upper_git).unwrap();
        fs::create_dir(&upper_modules).unwrap();
        fs::write(upper_git.join("metadata.txt"), b"secret needle").unwrap();
        fs::write(upper_modules.join("dependency.txt"), b"secret needle").unwrap();
        let aliases = root.join(".git").exists();

        let matches = search_in_dir(root, "secret needle", 100).unwrap();

        if aliases {
            assert!(matches.is_empty());
        } else {
            assert_eq!(matches.len(), 2);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_alias_to_git_metadata_is_not_searched() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("secret"), b"secret needle").unwrap();
        symlink(".git", root.join("git-link")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules").join("dependency.txt"),
            b"secret needle",
        )
        .unwrap();
        symlink("node_modules", root.join("deps-link")).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::create_dir(root.join("nested").join(".git")).unwrap();
        fs::write(
            root.join("nested").join(".git").join("cross-parent-secret"),
            b"secret needle",
        )
        .unwrap();
        symlink("nested/.git", root.join("nested-git-link")).unwrap();
        fs::create_dir(root.join("nested").join("node_modules")).unwrap();
        fs::write(
            root.join("nested")
                .join("node_modules")
                .join("cross-parent-dependency.txt"),
            b"secret needle",
        )
        .unwrap();
        symlink("nested/node_modules", root.join("nested-deps-link")).unwrap();

        assert!(search_in_dir(root, "secret needle", 100)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn file_symlinks_into_git_and_heavy_directories_are_not_searched() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("config"), b"secret needle").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules").join("dependency.js"),
            b"secret needle",
        )
        .unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        symlink("../.git/config", root.join("docs").join("config-link")).unwrap();
        symlink(
            "../node_modules/dependency.js",
            root.join("docs").join("dependency-link"),
        )
        .unwrap();

        assert!(search_in_dir(root, "secret needle", 100)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn aliases_into_root_workspace_trash_are_not_searched() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(".lyceum-trash")).unwrap();
        fs::write(
            root.join(".lyceum-trash").join("deleted.txt"),
            b"secret needle",
        )
        .unwrap();
        symlink(".lyceum-trash", root.join("trash-link")).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        symlink(
            "../.lyceum-trash/deleted.txt",
            root.join("docs").join("deleted-link"),
        )
        .unwrap();

        assert!(search_in_dir(root, "secret needle", 100)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn empty_query_returns_empty() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("c.txt"), b"anything\n").unwrap();

        let matches = search_in_dir(root, "", 1000).expect("search");

        assert!(matches.is_empty());
    }

    #[test]
    fn results_sorted_by_path_then_line() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("z.txt"), b"hit\nno\nhit\n").unwrap();
        fs::write(root.join("a.txt"), b"hit\n").unwrap();

        let matches = search_in_dir(root, "hit", 1000).expect("search");

        let mut sorted = matches.clone();
        sorted.sort_by(|x, y| x.path.cmp(&y.path).then(x.line.cmp(&y.line)));
        assert_eq!(matches, sorted);
        assert_eq!(matches.len(), 3);
    }

    #[test]
    fn respects_max_cap() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("d.txt"), b"hit\nhit\nhit\nhit\n").unwrap();

        let matches = search_in_dir(root, "hit", 2).expect("search");

        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn non_ascii_line_reports_correct_char_column_without_panic() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // 'ẞ' (U+1E9E, 3 bytes) lowercases to 'ß' (2 bytes); a byte offset from a
        // lowercased copy would be wrong and could slice mid-char. The column is
        // the 1-based CHARACTER position of the match in the original line.
        fs::write(root.join("u.txt"), "AẞBxy\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "xy", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].column, 4); // chars: A(1) ẞ(2) B(3) x(4)
        assert_eq!(matches[0].text, "AẞBxy");
    }

    #[test]
    fn unicode_length_changing_case_fold_is_matched() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // 'İ' (U+0130) lowercases to the 2-char sequence "i\u{0307}"; searching the
        // natural lowercase 'i' must still match it. The previous fixed char-count
        // window dropped this match. Column is the 1-based char position.
        fs::write(root.join("t.txt"), "aİb\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "i", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].column, 2); // chars: a(1) İ(2)
        assert_eq!(matches[0].text, "aİb");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_oversized_file_is_skipped() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("small.txt"), b"needle here\n").unwrap();
        // An oversized target reached via a symlink whose OWN metadata reports a
        // tiny size. The size cap must follow the link and skip it, not slurp the
        // multi-GB target into memory.
        let big_target = root.join("big_target.dat");
        let mut big = vec![b'x'; (MAX_FILE_SIZE as usize) + 16];
        big.extend_from_slice(b"\nneedle\n");
        fs::write(&big_target, &big).unwrap();
        symlink(&big_target, root.join("link.txt")).unwrap();

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        // Only the small real file matches; both the oversized file and the
        // symlink that resolves to it are skipped by the cap.
        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("small.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_outside_root_is_not_searched() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        fs::write(outside.path().join("secret.txt"), b"needle\n").unwrap();
        symlink(outside.path(), root.join("outside-link")).unwrap();

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        assert!(matches.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_file_outside_root_is_not_searched() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, b"needle\n").unwrap();
        symlink(&secret, root.join("secret-link.txt")).unwrap();

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        assert!(matches.is_empty());
    }

    #[test]
    fn astral_char_before_match_yields_utf16_column() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // Two 😀 (U+1F600) each count as 1 char but 2 UTF-16 units. Monaco uses
        // UTF-16 columns, so the reported column must be 5 (4 units + 1), not 3.
        fs::write(root.join("a.txt"), "😀😀foo\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "foo", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].column, 5);
    }

    #[test]
    fn adjacent_length_changing_matches_are_not_dropped() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // Two 'İ' (U+0130), each lowercasing to the 2-char "i\u{0307}". Searching
        // for that 2-char needle must find BOTH; the old advance walked 2 ORIGINAL
        // chars per match and skipped the second 'İ'.
        fs::write(root.join("t.txt"), "İİ\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "i\u{0307}", 1000).expect("search");

        assert_eq!(matches.len(), 2, "second adjacent match was dropped");
        assert_eq!(matches[0].column, 1);
        assert_eq!(matches[1].column, 2);
    }

    #[test]
    fn multiple_matches_on_a_non_ascii_line_all_reported() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // A non-ASCII line (forces the fold path) with the needle repeated. The
        // line is folded ONCE and every occurrence is reported with the correct
        // UTF-16 column — replacing the per-match re-fold of the shrinking suffix
        // that was O(line_len * matches) and froze the search on large inputs.
        fs::write(root.join("c.txt"), "数x数x数x\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "x", 1000).expect("search");

        assert_eq!(matches.len(), 3);
        // chars: 数(1) x(2) 数(3) x(4) 数(5) x(6); each 数 is one UTF-16 unit.
        assert_eq!(matches[0].column, 2);
        assert_eq!(matches[1].column, 4);
        assert_eq!(matches[2].column, 6);
    }

    #[test]
    fn final_sigma_query_matches_word_ending_in_capital_sigma() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // "ΟΔΟΣ".to_lowercase() is "οδος" (context-sensitive final ς), but the
        // haystack folds char-by-char to "οδοσ" (σ). Folding the needle the same
        // char-by-char way makes the query match; otherwise the match is dropped.
        fs::write(root.join("g.txt"), "ΟΔΟΣ\n".as_bytes()).unwrap();

        let matches = search_in_dir(root, "ΟΔΟΣ", 1000).expect("search");

        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn very_long_line_match_text_is_truncated_on_char_boundary() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // A single line far longer than the snippet cap with a match early on.
        let mut line = String::from("needle");
        line.push_str(&"x".repeat(MAX_LINE_SNIPPET * 4));
        fs::write(root.join("big.txt"), format!("{line}\n")).unwrap();

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].text.len() <= MAX_LINE_SNIPPET);
        // Truncation must not break a char boundary (no panic / valid UTF-8).
        assert!(matches[0].text.is_char_boundary(matches[0].text.len()));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_is_skipped_and_does_not_hang_search() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("real.txt"), b"needle here\n").unwrap();
        // A named pipe with no writer: reading it would block forever. The search
        // must skip it (is_file() == false) and return promptly with only the
        // regular-file match. If this test ever hangs, the FIFO guard regressed.
        let fifo = root.join("pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("real.txt"));
    }

    #[test]
    fn skips_files_larger_than_cap() {
        // search must never load an oversized file; verify via the cap.
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        // One small matching file and one oversized file (> MAX_FILE_SIZE) that
        // also contains the needle but must be skipped.
        fs::write(root.join("small.txt"), b"needle here\n").unwrap();
        let big = vec![b'x'; (MAX_FILE_SIZE as usize) + 16];
        let mut big = big;
        big.extend_from_slice(b"\nneedle\n");
        fs::write(root.join("big.txt"), &big).unwrap();

        let matches = search_in_dir(root, "needle", 1000).expect("search");

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("small.txt"));
    }
}
