// Workspace content search (case-insensitive substring) for the find-in-files
// feature. The pure walk + match logic lives in `search_in_dir` so it can be
// unit-tested with `cargo test` (no Tauri runtime needed). The
// `#[tauri::command]` wrapper is thin. Skipped directories (.git, node_modules,
// etc.) are never descended into, mirroring `walk.rs`.

use serde::Serialize;
use std::path::Path;

/// Directory names that are skipped entirely (not descended into).
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".vite"];

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

        let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in read {
            let entry = entry.map_err(|e| e.to_string())?;
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
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
            let contents = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let path_str = path.to_string_lossy().to_string();

            for (index, raw_line) in contents.lines().enumerate() {
                if matches.len() >= max {
                    break;
                }
                if let Some(byte_offset) = raw_line.to_lowercase().find(&needle) {
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
}
