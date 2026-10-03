// File-list access to the OS pasteboard, for Explorer copy/paste integration.
//
// The Explorer keeps its own in-app clipboard state (needed for cut semantics,
// which the OS pasteboard has no notion of), but the system board is the source
// of truth for files copied outside Lyceum (Finder etc.) and for making Lyceum
// copies pasteable into other apps and other Lyceum windows.
//
// `changeCount` is NSPasteboard's monotonic generation counter. The frontend
// remembers the count produced by its own write; a later read with the same
// count means the board still holds our entries (so the internal copy/cut op
// applies), while a different count means something else overwrote it.

use serde::Serialize;

/// One filesystem path on the pasteboard, mirroring the frontend `DirEntry`
/// fields that paste validity checks need.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileList {
    pub entries: Vec<ClipboardFileEntry>,
    /// Pasteboard generation at read time (`NSPasteboard.changeCount`), or -1
    /// where pasteboard access is unavailable.
    pub change_count: i64,
}

/// Read the filesystem paths currently on the general pasteboard.
#[tauri::command]
pub fn clipboard_file_paths() -> ClipboardFileList {
    imp::read_general()
}

/// Replace the general pasteboard contents with file URLs for `paths`.
/// Returns the new pasteboard generation (`changeCount`).
#[tauri::command]
pub fn set_clipboard_file_paths(paths: Vec<String>) -> i64 {
    imp::write_general(&paths)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{ClipboardFileEntry, ClipboardFileList};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use std::path::Path;

    pub(super) fn read_general() -> ClipboardFileList {
        read_board(&NSPasteboard::generalPasteboard())
    }

    pub(super) fn write_general(paths: &[String]) -> i64 {
        write_board(&NSPasteboard::generalPasteboard(), paths)
    }

    fn entry(path: String) -> ClipboardFileEntry {
        ClipboardFileEntry {
            is_dir: Path::new(&path).is_dir(),
            path,
        }
    }

    pub(super) fn read_board(pasteboard: &NSPasteboard) -> ClipboardFileList {
        let mut entries = Vec::new();
        // Modern representation: one pasteboard item per file, each carrying a
        // `public.file-url` string. This is what Finder writes.
        if let Some(items) = pasteboard.pasteboardItems() {
            for item in items.iter() {
                // SAFETY: linker-initialized framework constant.
                let file_url_type = unsafe { NSPasteboardTypeFileURL };
                let Some(url_string) = item.stringForType(file_url_type) else {
                    continue;
                };
                // `path()` exists for relative URLs too, so require an actual
                // file URL — a malformed `public.file-url` item must not turn
                // into a bogus relative path entry.
                let Some(path) = NSURL::URLWithString(&url_string)
                    .filter(|url| url.isFileURL())
                    .and_then(|url| url.path())
                else {
                    continue;
                };
                entries.push(entry(path.to_string()));
            }
        }
        // Older file managers may only publish the legacy NSFilenamesPboardType
        // (a property-list array of raw path strings).
        if entries.is_empty() {
            entries = legacy_filenames(pasteboard);
        }
        ClipboardFileList {
            entries,
            change_count: pasteboard.changeCount() as i64,
        }
    }

    #[allow(deprecated)] // read-only compatibility with writers that predate file-url items
    fn legacy_filenames(pasteboard: &NSPasteboard) -> Vec<ClipboardFileEntry> {
        // SAFETY: linker-initialized framework constant.
        let filenames_type = unsafe { objc2_app_kit::NSFilenamesPboardType };
        let Some(list) = pasteboard.propertyListForType(filenames_type) else {
            return Vec::new();
        };
        let Some(paths) = list.downcast_ref::<NSArray>() else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        for obj in paths.iter() {
            if let Some(path) = obj.downcast_ref::<NSString>() {
                entries.push(entry(path.to_string()));
            }
        }
        entries
    }

    pub(super) fn write_board(pasteboard: &NSPasteboard, paths: &[String]) -> i64 {
        let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
            .iter()
            .map(|path| {
                ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(path)))
            })
            .collect();
        let objects = NSArray::from_retained_slice(&urls);
        pasteboard.clearContents();
        pasteboard.writeObjects(&objects);
        pasteboard.changeCount() as i64
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::ClipboardFileList;

    pub(super) fn read_general() -> ClipboardFileList {
        ClipboardFileList {
            entries: Vec::new(),
            change_count: -1,
        }
    }

    pub(super) fn write_general(_paths: &[String]) -> i64 {
        -1
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::imp::{read_board, write_board};
    use objc2_app_kit::NSPasteboard;

    // A uniquely-named board keeps tests off the user's real clipboard.
    fn test_board() -> objc2::rc::Retained<NSPasteboard> {
        NSPasteboard::pasteboardWithUniqueName()
    }

    #[test]
    fn write_then_read_round_trips_paths() {
        let board = test_board();
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a file.txt");
        let dir = tmp.path().join("sub dir");
        std::fs::write(&file, "x").unwrap();
        std::fs::create_dir(&dir).unwrap();
        let paths = vec![
            file.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(),
        ];
        write_board(&board, &paths);
        let list = read_board(&board);
        assert_eq!(
            list.entries
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            paths
        );
        assert!(!list.entries[0].is_dir);
        assert!(list.entries[1].is_dir);
        assert!(list.change_count > 0);
    }

    #[test]
    fn read_empty_board_has_no_entries() {
        let list = read_board(&test_board());
        assert!(list.entries.is_empty());
    }

    #[test]
    #[allow(deprecated)]
    fn legacy_filenames_type_is_readable() {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::NSFilenamesPboardType;
        use objc2_foundation::{NSArray, NSString};

        let board = test_board();
        // SAFETY: linker-initialized framework constant; `types` is an array of
        // pasteboard-type strings, and `plist_obj` is the property-list shape
        // (array of path strings) NSFilenamesPboardType requires.
        unsafe {
            let types = NSArray::from_slice(&[NSFilenamesPboardType]);
            board.declareTypes_owner(&types, None);
            let plist = NSArray::from_slice(&[&*NSString::from_str("/tmp/legacy-path")]);
            let plist_obj = Retained::cast_unchecked::<AnyObject>(plist);
            board.setPropertyList_forType(&plist_obj, NSFilenamesPboardType);
        }
        let list = read_board(&board);
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].path, "/tmp/legacy-path");
    }

    #[test]
    fn change_count_advances_on_each_write() {
        let board = test_board();
        let first = write_board(&board, &["/tmp/a".to_string()]);
        let second = write_board(&board, &["/tmp/b".to_string()]);
        assert!(second > first);
    }
}
