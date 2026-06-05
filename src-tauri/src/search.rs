// Workspace content search (case-insensitive substring) for the find-in-files
// feature. The pure walk + match logic lives in `search_in_dir` so it can be
// unit-tested with `cargo test` (no Tauri runtime needed). The
// `#[tauri::command]` wrapper is thin. Skipped directories (.git, node_modules,
// etc.) are never descended into, mirroring `walk.rs`.

use serde::Serialize;
use std::path::Path;

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".vite"];

/// Files larger than this are skipped, so a single huge file (a multi-GB log or
/// dataset that happens to be valid UTF-8) cannot be slurped wholesale into a
/// heap String. Mirrors the bound `lsp.rs` places on a single message.
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;

/// Case-insensitive substring search returning the byte offset of the match in
/// the ORIGINAL `haystack` (never in a lowercased copy), so the offset always
/// lands on a char boundary. `needle_lower` must already be lowercased. The
/// common all-ASCII path allocates nothing; the Unicode path allocates only the
/// per-window comparison string. Returns `None` if not found.
fn find_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    if needle_lower.is_empty() {
        return Some(0);
    }
    if haystack.is_ascii() && needle_lower.is_ascii() {
        let hay = haystack.as_bytes();
        let needle = needle_lower.as_bytes();
        return hay
            .windows(needle.len())
            .position(|w| w.eq_ignore_ascii_case(needle));
    }
    // Unicode fallback: lowercase the whole haystack once, recording for each
    // produced char the byte offset of the ORIGINAL char it came from. A fixed
    // char-count window (the previous approach) is wrong because case folding is
    // not 1:1 in char count — e.g. 'İ' (U+0130) lowercases to the two chars
    // "i\u{0307}", so a 1-char window could never equal a 1-char needle and the
    // match was silently dropped. We search the lowercased copy and map the match
    // back to a valid char-boundary byte offset in the original via the table.
    let mut lowered = String::with_capacity(haystack.len());
    // origin[i] = byte offset in `haystack` of the source char for lowered char i.
    let mut origin: Vec<usize> = Vec::new();
    for (byte_idx, ch) in haystack.char_indices() {
        for lc in ch.to_lowercase() {
            origin.push(byte_idx);
            lowered.push(lc);
        }
    }
    let match_byte = lowered.find(needle_lower)?;
    // Convert the byte offset within `lowered` to a char index, then map back to
    // the original char's byte offset (always a valid char boundary in `haystack`).
    let char_index = lowered[..match_byte].chars().count();
    Some(origin[char_index])
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

    let needle = query.to_lowercase();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];

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
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
                continue;
            }

            if matches.len() >= max {
                break;
            }

            let path = entry.path();
            // Skip files too large to read into memory safely. Stat the RESOLVED
            // target (`fs::metadata` follows symlinks) rather than `entry.metadata()`
            // (which reports the symlink's own tiny size) — otherwise a symlink to a
            // multi-GB file would pass the cap and then be slurped by read_to_string,
            // which DOES follow the link. Skip outright if the target can't be stat'd.
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
            let contents = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let path_str = path.to_string_lossy().to_string();

            for (index, raw_line) in contents.lines().enumerate() {
                if matches.len() >= max {
                    break;
                }
                if let Some(byte_offset) = find_ci(raw_line, &needle) {
                    // `byte_offset` indexes the original line on a char boundary.
                    let column = raw_line[..byte_offset].chars().count() as u32 + 1;
                    matches.push(SearchMatch {
                        path: path_str.clone(),
                        line: index as u32 + 1,
                        column,
                        text: raw_line.to_string(),
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
pub fn search_workspace(root: String, query: String) -> Result<Vec<SearchMatch>, String> {
    search_in_dir(Path::new(&root), &query, 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        assert!(m.path.ends_with("src/a.txt"));
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

    #[test]
    fn skips_files_larger_than_cap() {
        // find_ci/search must never load an oversized file; verify via the cap.
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
