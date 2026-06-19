// File content read/write operations exposed to the frontend for the editor (M3).
//
// Reads load a file into the editor; saves write it back atomically (temp file +
// fsync + rename) so a crash, power loss, or full disk during Cmd+S can never
// leave the user's document truncated or half-written. Errors are mapped to
// strings that include the offending path so the frontend can surface a message.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, State};

use crate::path_access::{self, PathAccessManager};

/// Monotonic counter making temp-file names unique within this process.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Largest file the text editor will open. Beyond this a read is refused with a
/// clear error instead of slurping gigabytes into the webview.
const MAX_TEXT_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Largest file `read_file_bytes` will load (PDFs can be large, but a stray
/// multi-GB artifact must not be materialized in memory twice over IPC).
const MAX_BINARY_FILE_SIZE: u64 = 512 * 1024 * 1024;

/// Render a byte count for error messages, e.g. "123.4 MiB".
fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// Read a file to a string. Valid UTF-8 is returned as-is; a file that is not
/// valid UTF-8 (e.g. Latin-1 / legacy encoding) is decoded lossily so it can
/// still be opened and viewed rather than failing the open outright. Files
/// above `MAX_TEXT_FILE_SIZE` are refused (stat'd before reading) so a huge
/// log/dataset cannot wedge the editor.
#[tauri::command]
pub fn read_file(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    path: String,
) -> Result<String, String> {
    let path_ref = Path::new(&path);
    let canonical = path_access::ensure_existing_file_allowed(&app, &window, &access, path_ref)?;
    read_file_impl(&canonical)
}

fn read_file_impl(path: &Path) -> Result<String, String> {
    let display = path.display().to_string();
    let meta = std::fs::metadata(path).map_err(|e| format!("{display}: {e}"))?;
    if meta.len() > MAX_TEXT_FILE_SIZE {
        return Err(format!(
            "{display}: file too large to open ({}, limit {})",
            human_size(meta.len()),
            human_size(MAX_TEXT_FILE_SIZE)
        ));
    }
    if !meta.is_file() {
        return Err(format!("not a regular file: {display}"));
    }
    // Read the bytes once and decode in place: the lossy fallback reuses the
    // already-read buffer instead of reading the file a second time.
    let bytes = std::fs::read(path).map_err(|e| format!("{display}: {e}"))?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(e) => Ok(String::from_utf8_lossy(e.as_bytes()).into_owned()),
    }
}

/// Write a string to a file (creating parent dirs as needed). The write is
/// atomic: contents go to a sibling temp file that is flushed and fsynced, then
/// renamed over the target, so the on-disk file is always either the complete
/// old or the complete new version — never a truncated mix.
#[tauri::command]
pub fn write_file(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    path: String,
    content: String,
) -> Result<(), String> {
    let target =
        path_access::ensure_write_target_allowed(&app, &window, &access, Path::new(&path))?;
    write_file_impl(&target, &content).map_err(|e| format!("{path}: {e}"))
}

fn write_file_impl(path_ref: &Path, content: &str) -> Result<(), String> {
    // Refuse to clobber a file whose CURRENT on-disk bytes are not valid UTF-8.
    // `read_file` decodes such a file lossily (every invalid byte became U+FFFD)
    // so it can be viewed, but writing the editor's UTF-8 buffer back would
    // silently and irreversibly corrupt the original encoding / binary content.
    // A brand-new file (read errors) and an already-UTF-8 file are unaffected, so
    // normal editing and the first save of a UTF-8 file proceed as before.
    // `std::fs::read` follows symlinks, matching `read_file`.
    if let Ok(meta) = std::fs::metadata(path_ref) {
        if !meta.is_file() {
            return Err(format!("not a regular file: {}", path_ref.display()));
        }
    }
    if let Ok(existing) = std::fs::read(path_ref) {
        if std::str::from_utf8(&existing).is_err() {
            return Err(format!(
                "{}: refusing to save — the file is not valid UTF-8, and saving would corrupt its contents",
                path_ref.display()
            ));
        }
    }
    if let Some(parent) = path_ref.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }
    write_atomic(path_ref, content.as_bytes()).map_err(|e| e.to_string())
}

/// Atomically replace `path` with `bytes` via a same-directory temp file + fsync
/// + rename. The temp file is removed on any failure so no partial files leak.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // If `path` is a symlink, write through to its real target. `std::fs::rename`
    // does NOT follow a final-component symlink — renaming over the link would
    // replace (destroy) the link entry with a fresh regular file and leave the
    // real target's old content stale. Resolving first means we rename over the
    // resolved file in its own directory, preserving the link. A broken link
    // (canonicalize fails) falls back to the path as-is.
    let resolved = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path).ok(),
        _ => None,
    };
    let path = resolved.as_deref().unwrap_or(path);
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lyceum-file");
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    // The temp component is `.{file_name}{suffix}`. Clamp the embedded name so the
    // whole component stays within the 255-byte per-component limit used by
    // APFS/ext4/NTFS — otherwise a legal but near-max-length filename overflows
    // NAME_MAX and the save is refused. The temp name only needs to be unique in
    // `parent` (pid+seq guarantee that), not a faithful copy of the original.
    // ponytail: 255 is the standard component limit; a filesystem with a smaller
    // one would already constrain the original name too.
    const NAME_MAX: usize = 255;
    let suffix = format!(".lyceum-tmp.{}.{seq}", std::process::id());
    let budget = NAME_MAX.saturating_sub(1 + suffix.len()); // 1 for the leading '.'
    let mut keep = file_name.len().min(budget);
    while keep > 0 && !file_name.is_char_boundary(keep) {
        keep -= 1; // don't split a UTF-8 codepoint
    }
    let tmp = parent.join(format!(".{}{suffix}", &file_name[..keep]));

    // Write fully, flush, and fsync the temp file before swapping it in.
    let write_result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // Preserve the existing file's permissions across the replace.
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Resolve a path to its canonical, symlink-free absolute form. Best-effort: a
/// path that cannot be canonicalized (does not exist, permission denied) is
/// returned unchanged. The workspace-open flow uses this so the tree listing,
/// git decorations, search, and the watcher all key off ONE canonical root —
/// otherwise a root reached through a symlinked component (e.g. macOS `/tmp` ->
/// `/private/tmp`) makes git's canonical paths disagree with the tree's paths
/// and every decoration silently drops.
#[tauri::command]
pub fn canonicalize_path(path: String) -> String {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

/// Resolve a file path inside the app config dir (settings/keybindings persistence, M10).
#[tauri::command]
pub fn app_config_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    config_child_path(&dir, &name).map(|path| path.to_string_lossy().to_string())
}

fn config_child_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(file_name)), None) if !file_name.is_empty() => {
            Ok(dir.join(file_name))
        }
        _ => Err(format!("invalid config file name: {name}")),
    }
}

/// Read a file's raw bytes (used by the PDF viewer, M6). Files above
/// `MAX_BINARY_FILE_SIZE` are refused (stat'd before reading).
fn read_file_bytes_impl(path: &Path) -> Result<Vec<u8>, String> {
    let display = path.display();
    let meta = std::fs::metadata(path).map_err(|e| format!("{display}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {display}"));
    }
    if meta.len() > MAX_BINARY_FILE_SIZE {
        return Err(format!(
            "{display}: file too large to open ({}, limit {})",
            human_size(meta.len()),
            human_size(MAX_BINARY_FILE_SIZE)
        ));
    }
    std::fs::read(path).map_err(|e| format!("{display}: {e}"))
}

/// Read a file's raw bytes as a binary IPC `Response` (`InvokeResponseBody::Raw`)
/// so the bytes travel as an `ArrayBuffer` — not a JSON `number[]` that would be
/// materialized once as boxed numbers and copied again into a `Uint8Array`.
#[tauri::command]
pub fn read_file_bytes(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let canonical =
        path_access::ensure_existing_file_allowed(&app, &window, &access, Path::new(&path))?;
    Ok(tauri::ipc::Response::new(read_file_bytes_impl(&canonical)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_round_trips_content() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("note.txt").to_string_lossy().to_string();
        let content = "hello\nworld\n";

        write_file_impl(Path::new(&path), content).expect("write file");
        let read = read_file_impl(Path::new(&path)).expect("read file");
        assert_eq!(read, content);
    }

    #[test]
    fn read_file_on_nonexistent_path_returns_err() {
        let result = read_file_impl(Path::new("/this/path/should/not/exist/lyceum.txt"));
        assert!(result.is_err());
    }

    #[test]
    fn write_file_creates_missing_parent_dirs() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp
            .path()
            .join("nested/sub/dir/config.json")
            .to_string_lossy()
            .to_string();
        write_file_impl(Path::new(&path), "{}").expect("write nested file");
        assert_eq!(
            read_file_impl(Path::new(&path)).expect("read nested file"),
            "{}"
        );
    }

    #[test]
    fn read_file_bytes_round_trips() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("data.bin");
        let bytes = vec![0u8, 1, 2, 253, 254, 255];
        std::fs::write(&path, &bytes).unwrap();
        // Test the inner helper; the command wraps it in a binary IPC Response.
        assert_eq!(read_file_bytes_impl(&path).expect("read bytes"), bytes);
    }

    #[test]
    fn write_file_atomically_overwrites_existing_content() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("doc.txt").to_string_lossy().to_string();
        write_file_impl(Path::new(&path), "old contents").expect("initial write");
        write_file_impl(Path::new(&path), "new").expect("overwrite");
        assert_eq!(read_file_impl(Path::new(&path)).expect("read"), "new");
        // No temp files should be left behind in the directory.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("lyceum-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file leaked: {leftovers:?}");
    }

    // Non-Windows: this exercises the per-component NAME_MAX (255-byte) clamp. On
    // Windows the binding limit is MAX_PATH (260 for the whole path), so a 254-byte
    // name in a temp dir can't be created at all — a different constraint than the
    // clamp targets. The clamp itself still applies on every platform.
    #[cfg(not(windows))]
    #[test]
    fn write_file_atomically_handles_near_max_length_names() {
        // A legal 254-byte filename: the derived temp name must be clamped to stay
        // within NAME_MAX, or File::create fails with ENAMETOOLONG and the save is
        // wrongly refused for a perfectly valid file.
        let tmp = tempfile::tempdir().expect("create temp dir");
        let name = format!("{}.txt", "a".repeat(250)); // 254 bytes
        let path = tmp.path().join(&name);
        write_file_impl(&path, "content").expect("write long-named file");
        assert_eq!(read_file_impl(&path).expect("read back"), "content");
        // And no temp file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("lyceum-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file leaked: {leftovers:?}");
    }

    #[test]
    fn read_file_decodes_non_utf8_lossily() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("latin1.txt").to_string_lossy().to_string();
        // 0xFF is not valid UTF-8; lossy decode should not error.
        std::fs::write(&path, [b'h', b'i', 0xFF]).unwrap();
        let read = read_file_impl(Path::new(&path)).expect("lossy read should succeed");
        assert!(read.starts_with("hi"));
    }

    #[test]
    fn write_file_refuses_to_overwrite_non_utf8_file() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("latin1.txt").to_string_lossy().to_string();
        // A file that is not valid UTF-8 (Latin-1 'é' = 0xE9). read_file would
        // decode it lossily; saving the editor buffer back must be refused so the
        // original bytes are not destroyed.
        std::fs::write(&path, [b'h', b'i', 0xE9]).unwrap();
        let err = write_file_impl(Path::new(&path), "hi\u{FFFD}").unwrap_err();
        assert!(err.contains("not valid UTF-8"), "got: {err}");
        // The original bytes are untouched.
        assert_eq!(std::fs::read(&path).unwrap(), [b'h', b'i', 0xE9]);
    }

    #[test]
    fn config_child_path_accepts_simple_file_names_only() {
        let root = Path::new("/app/config");

        assert_eq!(
            config_child_path(root, "settings.json").unwrap(),
            root.join("settings.json")
        );
        assert!(config_child_path(root, "../settings.json").is_err());
        assert!(config_child_path(root, "nested/settings.json").is_err());
        assert!(config_child_path(root, "/tmp/settings.json").is_err());
        assert!(config_child_path(root, "").is_err());
    }

    #[test]
    fn write_file_allows_overwriting_utf8_and_creating_new() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        // Overwriting an existing valid-UTF-8 file is allowed.
        let utf8 = tmp.path().join("ok.txt").to_string_lossy().to_string();
        write_file_impl(Path::new(&utf8), "first").expect("create");
        write_file_impl(Path::new(&utf8), "second").expect("overwrite utf8");
        assert_eq!(read_file_impl(Path::new(&utf8)).expect("read"), "second");
    }

    #[cfg(unix)]
    #[test]
    fn write_file_through_symlink_preserves_link_and_updates_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let target = tmp.path().join("real.txt");
        let link = tmp.path().join("link.txt");
        std::fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();

        // Saving through the symlink must write the real target's content and
        // leave the symlink intact — not replace the link with a regular file.
        write_file_impl(&link, "new").expect("write via link");

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "symlink was destroyed by the save"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "new");
    }

    #[test]
    fn write_file_creates_new_file_with_matching_contents() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("created.txt").to_string_lossy().to_string();
        assert!(read_file_impl(Path::new(&path)).is_err());

        let content = "fresh contents";
        write_file_impl(Path::new(&path), content).expect("write file");
        let read = read_file_impl(Path::new(&path)).expect("read file");
        assert_eq!(read, content);
    }
}
