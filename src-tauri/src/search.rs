// Workspace content search (case-insensitive substring) for the find-in-files
// feature. The pure walk + match logic lives in `search_in_dir` so it can be
// unit-tested with `cargo test` (no Tauri runtime needed). The
// `#[tauri::command]` wrapper is thin. Skipped directories (.git, node_modules,
// etc.) are never descended into, mirroring `walk.rs`.

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".vite"];

/// Files larger than this are skipped, so a single huge file (a multi-GB log or
/// dataset that happens to be valid UTF-8) cannot be slurped wholesale into a
/// heap String. Mirrors the bound `lsp.rs` places on a single message.
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;

/// Case-insensitive substring search returning the `[start, end)` byte span of
/// the match in the ORIGINAL `haystack` (never in a lowercased copy), so both
/// offsets land on char boundaries. `end` is where a non-overlapping next search
/// should resume: it is the byte offset just past the LAST original char that
/// contributed to the match, which matters when case folding is not length-
/// preserving (e.g. 'İ' lowercases to two chars). `needle_lower` must already be
/// lowercased. The common all-ASCII path allocates nothing; the Unicode path
/// allocates only the per-window comparison string. Returns `None` if not found.
fn find_ci(haystack: &str, needle_lower: &str) -> Option<(usize, usize)> {
    if needle_lower.is_empty() {
        return Some((0, 0));
    }
    if haystack.is_ascii() && needle_lower.is_ascii() {
        let hay = haystack.as_bytes();
        let needle = needle_lower.as_bytes();
        let start = hay
            .windows(needle.len())
            .position(|w| w.eq_ignore_ascii_case(needle))?;
        // ASCII case folding is 1:1 in length, so the original span is exactly
        // the needle's length.
        return Some((start, start + needle.len()));
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
    let start_char = lowered[..match_byte].chars().count();
    let start = origin[start_char];
    // End: the lowered match ends at `match_byte + needle_lower.len()`. Map that
    // back to the byte offset just past the LAST original char that contributed,
    // so a match that consumes only part of a char's lowercase expansion (e.g.
    // needle "i" matching the "i" of 'İ' -> "i\u{0307}") still advances past the
    // whole 'İ' rather than re-matching or stalling.
    let end_char = lowered[..match_byte + needle_lower.len()].chars().count();
    let last_src_byte = origin[end_char - 1];
    let end = haystack[last_src_byte..]
        .chars()
        .next()
        .map(|c| last_src_byte + c.len_utf8())
        .unwrap_or(haystack.len());
    Some((start, end))
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

    let needle = query.to_lowercase();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    // Canonical paths of directories already walked. Guards against descending
    // the same tree twice and against symlink cycles (mirrors walk.rs).
    let mut visited: HashSet<std::path::PathBuf> = HashSet::new();
    if let Ok(canon) = root.canonicalize() {
        visited.insert(canon);
    }

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
                let name = entry.file_name().to_string_lossy().to_string();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                // Canonicalize before descending so a tree reachable via a
                // symlink (or two paths) is searched at most once.
                match path.canonicalize() {
                    Ok(canon) => {
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
            let Ok(meta) = std::fs::metadata(&path) else {
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
            let contents = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let path_str = path.to_string_lossy().to_string();

            for (index, raw_line) in contents.lines().enumerate() {
                if matches.len() >= max {
                    break;
                }
                // Snippet is cloned once per matching line, not once per match.
                let snippet = line_snippet(raw_line);
                // Report EVERY occurrence on the line (not just the first),
                // advancing past each match, while still respecting the cap.
                let mut search_from = 0usize;
                while matches.len() < max && search_from < raw_line.len() {
                    let Some((found, found_end)) = find_ci(&raw_line[search_from..], &needle)
                    else {
                        break;
                    };
                    // `byte_offset` indexes the original line on a char boundary.
                    let byte_offset = search_from + found;
                    // Column is measured in UTF-16 code units, because Monaco (the
                    // frontend editor that consumes this column) measures columns
                    // in UTF-16 units. Counting chars (Unicode scalars) would place
                    // the cursor too far left by one per preceding astral character.
                    let column = raw_line[..byte_offset].encode_utf16().count() as u32 + 1;
                    matches.push(SearchMatch {
                        path: path_str.clone(),
                        line: index as u32 + 1,
                        column,
                        text: snippet.clone(),
                    });
                    // Advance to the END of the matched span in the ORIGINAL line
                    // (returned by find_ci). The `.max(byte_offset + 1)` floor
                    // guarantees forward progress even for a zero-width edge case.
                    search_from = (search_from + found_end).max(byte_offset + 1);
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
