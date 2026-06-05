// File content read/write operations exposed to the frontend for the editor (M3).
//
// Reads load a file into the editor; saves write it back atomically (temp file +
// fsync + rename) so a crash, power loss, or full disk during Cmd+S can never
// leave the user's document truncated or half-written. Errors are mapped to
// strings that include the offending path so the frontend can surface a message.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter making temp-file names unique within this process.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Read a file to a string. Valid UTF-8 is returned as-is; a file that is not
/// valid UTF-8 (e.g. Latin-1 / legacy encoding) is decoded lossily so it can
/// still be opened and viewed rather than failing the open outright.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// Write a string to a file (creating parent dirs as needed). The write is
/// atomic: contents go to a sibling temp file that is flushed and fsynced, then
/// renamed over the target, so the on-disk file is always either the complete
/// old or the complete new version — never a truncated mix.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let path_ref = Path::new(&path);
    if let Some(parent) = path_ref.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }
    write_atomic(path_ref, content.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

/// Atomically replace `path` with `bytes` via a same-directory temp file + fsync
/// + rename. The temp file is removed on any failure so no partial files leak.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lyceum-file");
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(
        ".{file_name}.lyceum-tmp.{}.{seq}",
        std::process::id()
    ));

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

/// Resolve a file path inside the app config dir (settings/keybindings persistence, M10).
#[tauri::command]
pub fn app_config_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name).to_string_lossy().to_string())
}

/// Read a file's raw bytes (used by the PDF viewer, M6).
fn read_file_bytes_impl(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

/// Read a file's raw bytes as a binary IPC `Response` (`InvokeResponseBody::Raw`)
/// so the bytes travel as an `ArrayBuffer` — not a JSON `number[]` that would be
/// materialized once as boxed numbers and copied again into a `Uint8Array`.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read_file_bytes_impl(&path)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_round_trips_content() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("note.txt").to_string_lossy().to_string();
        let content = "hello\nworld\n";

        write_file(path.clone(), content.to_string()).expect("write file");
        let read = read_file(path).expect("read file");
        assert_eq!(read, content);
    }

    #[test]
    fn read_file_on_nonexistent_path_returns_err() {
        let result = read_file("/this/path/should/not/exist/lyceum.txt".to_string());
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
        write_file(path.clone(), "{}".to_string()).expect("write nested file");
        assert_eq!(read_file(path).expect("read nested file"), "{}");
    }

    #[test]
    fn read_file_bytes_round_trips() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("data.bin").to_string_lossy().to_string();
        let bytes = vec![0u8, 1, 2, 253, 254, 255];
        std::fs::write(&path, &bytes).unwrap();
        // Test the inner helper; the command wraps it in a binary IPC Response.
        assert_eq!(read_file_bytes_impl(&path).expect("read bytes"), bytes);
    }

    #[test]
    fn write_file_atomically_overwrites_existing_content() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("doc.txt").to_string_lossy().to_string();
        write_file(path.clone(), "old contents".to_string()).expect("initial write");
        write_file(path.clone(), "new".to_string()).expect("overwrite");
        assert_eq!(read_file(path).expect("read"), "new");
        // No temp files should be left behind in the directory.
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
        let read = read_file(path).expect("lossy read should succeed");
        assert!(read.starts_with("hi"));
    }

    #[test]
    fn write_file_creates_new_file_with_matching_contents() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("created.txt").to_string_lossy().to_string();
        assert!(read_file(path.clone()).is_err());

        let content = "fresh contents";
        write_file(path.clone(), content.to_string()).expect("write file");
        let read = read_file(path).expect("read file");
        assert_eq!(read, content);
    }
}
