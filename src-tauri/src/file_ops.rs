// File content read/write operations exposed to the frontend for the editor (M3).
//
// These are thin wrappers over `std::fs` for loading a file into the editor and
// saving it back. Errors are mapped to strings that include the offending path
// so the frontend can surface a useful message.

/// Read a UTF-8 file to a string.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write a string to a file (creating parent dirs + creating/truncating).
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

/// Resolve a file path inside the app config dir (settings/keybindings persistence, M10).
#[tauri::command]
pub fn app_config_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name).to_string_lossy().to_string())
}

/// Read a file's raw bytes (used by the PDF viewer, M6).
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("{path}: {e}"))
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
        assert_eq!(read_file_bytes(path).expect("read bytes"), bytes);
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
