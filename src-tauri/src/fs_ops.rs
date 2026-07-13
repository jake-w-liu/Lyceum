// Filesystem operations exposed to the frontend for the file explorer (M2).
//
// The pure listing logic lives in `read_dir_entries` so it can be unit-tested
// with `cargo test` (no Tauri runtime needed). The `#[tauri::command]` wrappers
// are thin. Directory reads are explicit, on-demand (lazy) reads — no recursive
// walking or background indexing (a v1 non-goal).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::path_access::{self, PathAccessManager};
use crate::workspace_paths::{
    path_resolves_into_workspace_trash, path_starts_with_workspace_trash,
    path_would_be_workspace_trash, LYCEUM_TRASH_DIR,
};

static TRASH_BATCH_SEQ: AtomicU64 = AtomicU64::new(0);
static ROLLBACK_STAGE_SEQ: AtomicU64 = AtomicU64::new(0);
static COPY_STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// A single entry in a directory listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    /// File or directory name (final path component).
    pub name: String,
    /// Absolute path to the entry.
    pub path: String,
    /// True if the entry is a directory.
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemDto {
    pub original_path: String,
    pub trashed_path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchDto {
    pub id: String,
    pub items: Vec<TrashItemDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MovedPathDto {
    pub from: String,
    pub to: String,
    pub is_dir: bool,
    pub replaced: bool,
    pub replaced_path: Option<String>,
    pub cleanup_warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceEntryTarget {
    path: PathBuf,
    is_dir: bool,
}

/// Identity of an entry created or moved by the current operation. Rollback
/// must check identity, not just the pathname: another actor can remove our
/// entry and create a different one at the same path before a later batch item
/// fails. Acting on that replacement would delete or relocate data we do not
/// own.
#[cfg(unix)]
#[derive(Debug)]
struct EntryIdentity {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    mode: u32,
    // Keep the inode allocated while the rollback token is live. This closes
    // the otherwise-theoretical unlink + inode-reuse hole in a dev/inode token.
    handle: std::sync::Mutex<Option<std::fs::File>>,
}

#[cfg(unix)]
impl EntryIdentity {
    fn capture_with_pin(path: &Path, pin: bool) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let metadata = std::fs::symlink_metadata(path)?;
        let handle = if pin {
            Some(open_unix_entry_without_following(path, &metadata)?)
        } else {
            None
        };
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.size(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            mode: metadata.mode(),
            handle: std::sync::Mutex::new(handle),
        })
    }

    fn still_at(&self, path: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;

        std::fs::symlink_metadata(path)
            .map(|metadata| {
                metadata.dev() == self.device
                    && metadata.ino() == self.inode
                    && metadata.size() == self.size
                    && metadata.mtime() == self.modified_seconds
                    && metadata.mtime_nsec() == self.modified_nanoseconds
                    && metadata.mode() == self.mode
            })
            .unwrap_or(false)
    }

    fn release_pin(&self) {
        if let Ok(mut handle) = self.handle.lock() {
            *handle = None;
        }
    }

    #[cfg(test)]
    fn is_pinned(&self) -> bool {
        self.handle
            .lock()
            .map(|handle| handle.is_some())
            .unwrap_or(false)
    }
}

#[cfg(unix)]
fn open_unix_entry_without_following(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let _ = metadata;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW)
            .open(path)
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let flags = if metadata.file_type().is_symlink() {
            libc::O_EVTONLY | libc::O_SYMLINK
        } else {
            libc::O_EVTONLY
        };
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "cannot pin a filesystem entry on this Unix platform",
        ))
    }
}

/// Windows does not expose stable file IDs through stable `MetadataExt`. Open
/// the entry itself (including directory/reparse-point entries), retain that
/// handle, and query the kernel's volume + file-index tuple.
#[cfg(windows)]
#[derive(Debug)]
struct EntryIdentity {
    volume: u32,
    index: u64,
    size: u64,
    attributes: u32,
    last_write: u64,
    handle: std::sync::Mutex<Option<std::fs::File>>,
}

#[cfg(windows)]
impl EntryIdentity {
    fn capture_with_pin(path: &Path, pin: bool) -> std::io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

        let handle = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let (volume, index, size, attributes, last_write) = windows_file_identity(&handle)?;
        Ok(Self {
            volume,
            index,
            size,
            attributes,
            last_write,
            handle: std::sync::Mutex::new(pin.then_some(handle)),
        })
    }

    fn still_at(&self, path: &Path) -> bool {
        Self::capture_with_pin(path, true)
            .map(|current| {
                current.volume == self.volume
                    && current.index == self.index
                    && current.size == self.size
                    && current.attributes == self.attributes
                    && current.last_write == self.last_write
            })
            .unwrap_or(false)
    }

    fn release_pin(&self) {
        if let Ok(mut handle) = self.handle.lock() {
            *handle = None;
        }
    }

    #[cfg(test)]
    fn is_pinned(&self) -> bool {
        self.handle
            .lock()
            .map(|handle| handle.is_some())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct WindowsFileTime {
    dwLowDateTime: u32,
    dwHighDateTime: u32,
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct ByHandleFileInformation {
    dwFileAttributes: u32,
    ftCreationTime: WindowsFileTime,
    ftLastAccessTime: WindowsFileTime,
    ftLastWriteTime: WindowsFileTime,
    dwVolumeSerialNumber: u32,
    nFileSizeHigh: u32,
    nFileSizeLow: u32,
    nNumberOfLinks: u32,
    nFileIndexHigh: u32,
    nFileIndexLow: u32,
}

#[cfg(windows)]
fn windows_file_identity(file: &std::fs::File) -> std::io::Result<(u32, u64, u64, u32, u64)> {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
    // SAFETY: `file` owns a valid kernel handle and `information` points to
    // writable storage of the exact BY_HANDLE_FILE_INFORMATION layout.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful GetFileInformationByHandle initializes every field.
    let information = unsafe { information.assume_init() };
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
    let last_write = (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
        | u64::from(information.ftLastWriteTime.dwLowDateTime);
    Ok((
        information.dwVolumeSerialNumber,
        index,
        size,
        information.dwFileAttributes,
        last_write,
    ))
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug)]
struct EntryIdentity;

#[cfg(not(any(unix, windows)))]
impl EntryIdentity {
    fn capture_with_pin(_path: &Path, _pin: bool) -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "filesystem identity tokens are unavailable on this platform",
        ))
    }

    fn still_at(&self, _path: &Path) -> bool {
        false
    }

    fn release_pin(&self) {}

    #[cfg(test)]
    fn is_pinned(&self) -> bool {
        false
    }
}

#[derive(Debug)]
struct OwnedEntry {
    path: PathBuf,
    tree: Option<Vec<OwnedTreeNode>>,
}

#[derive(Debug)]
struct OwnedTreeNode {
    relative: PathBuf,
    identity: EntryIdentity,
}

impl OwnedEntry {
    fn try_capture(path: PathBuf) -> std::io::Result<Self> {
        let mut tree = Vec::new();
        capture_owned_tree(&path, Path::new(""), &mut tree)?;
        Ok(Self {
            path,
            tree: Some(tree),
        })
    }

    #[cfg(test)]
    fn capture(path: PathBuf) -> Self {
        Self::try_capture(path).expect("capture owned entry tree")
    }

    fn is_still_owned_at(&self, path: &Path) -> bool {
        let Some(tree) = self.tree.as_ref() else {
            return false;
        };
        let mut current_paths = HashSet::new();
        if collect_tree_paths(path, Path::new(""), &mut current_paths).is_err()
            || current_paths.len() != tree.len()
        {
            return false;
        }
        tree.iter().all(|node| {
            current_paths.contains(&node.relative)
                && node
                    .identity
                    .still_at(&if node.relative.as_os_str().is_empty() {
                        path.to_path_buf()
                    } else {
                        path.join(&node.relative)
                    })
        })
    }

    fn release_root_pin(&self) {
        if let Some(root) = self.tree.as_ref().and_then(|tree| {
            tree.iter()
                .find(|node| node.relative.as_os_str().is_empty())
        }) {
            root.identity.release_pin();
        }
    }
}

fn capture_owned_tree(
    path: &Path,
    relative: &Path,
    out: &mut Vec<OwnedTreeNode>,
) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    out.push(OwnedTreeNode {
        relative: relative.to_path_buf(),
        // Pin only the root. Descendant IDs/fingerprints are verified after the
        // root is atomically quarantined; retaining one descriptor per node
        // would exhaust RLIMIT_NOFILE on ordinary large project trees.
        identity: EntryIdentity::capture_with_pin(path, relative.as_os_str().is_empty())?,
    });
    if metadata.file_type().is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            capture_owned_tree(&entry.path(), &relative.join(entry.file_name()), out)?;
        }
    }
    Ok(())
}

fn collect_tree_paths(
    path: &Path,
    relative: &Path,
    out: &mut HashSet<PathBuf>,
) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    out.insert(relative.to_path_buf());
    if metadata.file_type().is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            collect_tree_paths(&entry.path(), &relative.join(entry.file_name()), out)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct CompletedMove {
    destination: OwnedEntry,
    source: PathBuf,
}

impl CompletedMove {
    #[cfg(test)]
    fn capture(destination: PathBuf, source: PathBuf) -> Self {
        Self {
            destination: OwnedEntry::capture(destination),
            source,
        }
    }
}

/// List the immediate children of `dir`, directories first then files, each
/// group sorted case-insensitively by name. Returns an error string on failure.
#[cfg(test)]
pub fn read_dir_entries(dir: &Path) -> Result<Vec<DirEntryDto>, String> {
    read_dir_entries_for_workspace(dir, dir)
}

fn read_dir_entries_for_workspace(
    dir: &Path,
    workspace_root: &Path,
) -> Result<Vec<DirEntryDto>, String> {
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }

    let mut entries: Vec<DirEntryDto> = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_trash_entry_for_workspace(workspace_root, &entry.path(), &name) {
            continue;
        }
        let path = entry.path();
        // Resolve the REAL kind: file_type() reports a symlink as a symlink
        // (is_dir() == false), so a symlinked directory would otherwise render
        // as a bogus, unopenable "file". Follow the link (mirrors walk.rs);
        // a broken symlink is listed as a file.
        let is_dir = if file_type.is_symlink() {
            std::fs::metadata(&path)
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };
        entries.push(DirEntryDto {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
        });
    }

    // Directories before files, then case-insensitive name order.
    // `sort_by_cached_key` lowercases each name once (O(n)) rather than on every
    // comparison (O(n log n) temporary Strings).
    entries.sort_by_cached_key(|e| (std::cmp::Reverse(e.is_dir), e.name.to_lowercase()));

    Ok(entries)
}

/// Read the immediate children of a directory path. Used by the file explorer
/// to lazily expand folders.
#[tauri::command]
pub fn read_directory(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    path: String,
) -> Result<Vec<DirEntryDto>, String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    let dir = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&path))?;
    if !dir.starts_with(&root) {
        return Err(format!(
            "directory is outside workspace root: {}",
            dir.display()
        ));
    }
    read_dir_entries_for_workspace(&dir, &root)
}

/// Create an empty file at `path`. Errors if it already exists. Parent
/// directories are created as needed.
#[tauri::command]
pub fn create_file(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    path: String,
) -> Result<(), String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    let target =
        path_access::ensure_write_target_allowed(&app, &window, &access, Path::new(&path))?;
    create_file_in_workspace_impl(&root, &target)
}

fn create_file_in_workspace_impl(root: &Path, target: &Path) -> Result<(), String> {
    validate_workspace_mutation_destination(root, target)?;
    create_file_impl(target)
}

fn create_file_impl(target: &Path) -> Result<(), String> {
    if path_entry_exists(target) {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map(|_| ())
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("already exists: {}", target.display())
            } else {
                format!("{}: {e}", target.display())
            }
        })
}

/// Create a directory (and any missing parents) at `path`. Errors if the leaf
/// already exists, mirroring `create_file` — otherwise `create_dir_all` silently
/// succeeds on an existing directory and the Explorer reports a duplicate-named
/// "New Folder" as freshly created, misleading the user into the existing dir.
#[tauri::command]
pub fn create_directory(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    path: String,
) -> Result<(), String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    let target =
        path_access::ensure_write_target_allowed(&app, &window, &access, Path::new(&path))?;
    create_directory_in_workspace_impl(&root, &target)
}

fn create_directory_in_workspace_impl(root: &Path, target: &Path) -> Result<(), String> {
    validate_workspace_mutation_destination(root, target)?;
    create_directory_impl(target)
}

fn create_directory_impl(target: &Path) -> Result<(), String> {
    if path_entry_exists(target) {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    // Claim the leaf atomically. `create_dir_all(target)` would silently succeed
    // if another actor created it after the preflight check above.
    std::fs::create_dir(target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("already exists: {}", target.display())
        } else {
            format!("{}: {e}", target.display())
        }
    })
}

/// Rename/move `from` to `to`. Errors if the destination already exists.
#[tauri::command]
pub fn rename_path(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    path_access::ensure_existing_allowed(&app, &window, &access, Path::new(&from))?;
    path_access::ensure_write_target_allowed(&app, &window, &access, Path::new(&to))?;
    // Validation may canonicalize an existing case-only destination back to
    // the source's disk spelling. Preserve the requested final spelling for
    // rename_case_only while still normalizing lexical traversal segments.
    let to = absolute_lexical_path(Path::new(&to));
    let from = existing_workspace_entry_target(&from)?.path;
    rename_path_in_workspace_impl(&root, &from, &to)
}

fn rename_path_in_workspace_impl(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    validate_workspace_move_target(root, from)?;
    validate_workspace_mutation_destination(root, to)?;
    rename_path_impl(from, to)
}

fn rename_path_impl(from_path: &Path, to_path: &Path) -> Result<(), String> {
    if path_entry_exists(to_path) {
        // A case-only rename on a case-insensitive filesystem (macOS/Windows):
        // `to` resolves to the SAME on-disk entry as `from`, so the destination-
        // exists guard would wrongly reject e.g. `Readme.md` -> `readme.md`.
        // Detect that exact case and rename through a temp name so the case
        // change still applies.
        if is_case_only_rename(from_path, to_path) {
            return rename_case_only(from_path, to_path);
        }
        return Err(format!("already exists: {}", to_path.display()));
    }
    move_entry(from_path, to_path)
        .map_err(|e| format!("{} -> {}: {e}", from_path.display(), to_path.display()))
}

/// True when `from` and `to` differ only in the letter case of the final
/// component and refer to the same on-disk entry (case-insensitive filesystem).
fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    if from == to {
        return false;
    }
    let (Some(from_name), Some(to_name)) = (from.file_name(), to.file_name()) else {
        return false;
    };
    if from.parent() != to.parent() {
        return false;
    }
    if from_name.to_string_lossy().to_lowercase() != to_name.to_string_lossy().to_lowercase() {
        return false;
    }
    // Confirm they really point at one entry (so we never temp-dance two distinct
    // files). On a case-insensitive FS both canonicalize to the same real path.
    match (std::fs::canonicalize(from), std::fs::canonicalize(to)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

static CASE_RENAME_SEQ: AtomicU64 = AtomicU64::new(0);

/// Apply a case-only rename via a unique intermediate name in the same directory,
/// so a case-insensitive filesystem doesn't treat source == destination.
fn rename_case_only(from: &Path, to: &Path) -> Result<(), String> {
    let parent = to.parent().filter(|p| !p.as_os_str().is_empty());
    let seq = CASE_RENAME_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".lyceum-case-rename.{}.{seq}", std::process::id());
    let tmp = match parent {
        Some(p) => p.join(tmp_name),
        None => PathBuf::from(tmp_name),
    };
    rename_noreplace(from, &tmp)
        .map_err(|e| format!("{} -> {}: {e}", from.display(), tmp.display()))?;
    if let Err(e) = rename_noreplace(&tmp, to) {
        // Roll back so the file isn't stranded under the temp name.
        let _ = rename_noreplace(&tmp, from);
        return Err(format!("{} -> {}: {e}", from.display(), to.display()));
    }
    Ok(())
}

/// Move one or more workspace paths into an existing destination directory.
// Tauri injects app/window/state before the five serialized command fields.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn move_paths(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    paths: Vec<String>,
    destination_dir: String,
    replace_existing: Option<bool>,
    expected_conflict_paths: Option<Vec<String>>,
) -> Result<Vec<MovedPathDto>, String> {
    let root_path =
        path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    move_paths_impl_with_replace(
        &root_path,
        paths,
        Path::new(&destination_dir),
        replace_existing.unwrap_or(false),
        expected_conflict_paths.as_deref(),
    )
}

/// Copy one or more source paths — which may live OUTSIDE the workspace (e.g.
/// files dropped from the OS file manager) — into an existing destination
/// directory under the workspace root.
// Tauri injects app/window/state before the five serialized command fields.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn copy_paths(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    paths: Vec<String>,
    destination_dir: String,
    replace_existing: Option<bool>,
    expected_conflict_paths: Option<Vec<String>>,
) -> Result<Vec<MovedPathDto>, String> {
    let root_path =
        path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    copy_paths_impl_with_replace(
        &root_path,
        paths,
        Path::new(&destination_dir),
        replace_existing.unwrap_or(false),
        expected_conflict_paths.as_deref(),
    )
}

#[tauri::command]
pub fn move_paths_to_trash(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    paths: Vec<String>,
) -> Result<TrashBatchDto, String> {
    let root_path =
        path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    move_paths_to_trash_impl(&root_path, paths)
}

#[tauri::command]
pub fn restore_trash_batch(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    items: Vec<TrashItemDto>,
) -> Result<(), String> {
    let root_path =
        path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    restore_trash_batch_impl(&root_path, items)
}

#[tauri::command]
pub fn redo_trash_batch(
    app: AppHandle,
    window: tauri::Window,
    access: State<'_, PathAccessManager>,
    root: String,
    items: Vec<TrashItemDto>,
) -> Result<(), String> {
    let root_path =
        path_access::ensure_existing_dir_allowed(&app, &window, &access, Path::new(&root))?;
    redo_trash_batch_impl(&root_path, items)
}

fn move_paths_to_trash_impl(root: &Path, paths: Vec<String>) -> Result<TrashBatchDto, String> {
    let requested_root = root.to_path_buf();
    let root = canonical_dir(root)?;
    let targets = normalize_delete_targets(&root, paths)?;
    if targets.is_empty() {
        return Err("no paths to delete".to_string());
    }

    let id = unique_trash_batch_id();
    let (trash_root, created_trash_root) = ensure_safe_trash_root(&root)?;
    let batch_dir = trash_root.join(&id);
    if let Err(error) = std::fs::create_dir(&batch_dir) {
        if created_trash_root {
            let _ = std::fs::remove_dir(&trash_root);
        }
        return Err(format!("{}: {error}", batch_dir.display()));
    }

    let mut items = Vec::with_capacity(targets.len());
    // Completed moves (trashed_dest, original_source); on any failure these are
    // rolled back so a partial multi-file delete cannot silently lose files
    // into the hidden trash dir with no Undo affordance.
    let mut done: Vec<CompletedMove> = Vec::new();
    for target in targets {
        let rel = match target.path.strip_prefix(&root) {
            Ok(rel) => rel,
            Err(e) => {
                rollback_moves(&done);
                let _ = std::fs::remove_dir_all(&batch_dir);
                if created_trash_root {
                    let _ = std::fs::remove_dir(&trash_root);
                }
                return Err(format!("{}: {e}", target.path.display()));
            }
        };
        let destination = batch_dir.join(rel);
        if let Some(parent) = destination.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                let _ = std::fs::remove_dir_all(&batch_dir);
                if created_trash_root {
                    let _ = std::fs::remove_dir(&trash_root);
                }
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        let destination_ownership = match move_entry_owned(&target.path, &destination) {
            Ok(ownership) => ownership,
            Err(e) => {
                rollback_moves(&done);
                // move_entry_owned may have deliberately KEPT a complete copy at
                // `destination` (a cross-device DIRECTORY whose non-atomic
                // remove_dir_all of the source partially failed — the source is
                // then incomplete and this copy is the only complete one). Wiping
                // batch_dir would destroy it -> permanent data loss.
                if std::fs::symlink_metadata(&destination).is_err() {
                    let _ = std::fs::remove_dir_all(&batch_dir);
                    if created_trash_root {
                        let _ = std::fs::remove_dir(&trash_root);
                    }
                }
                return Err(format!(
                    "{} -> {}: {e}",
                    target.path.display(),
                    destination.display()
                ));
            }
        };
        done.push(CompletedMove {
            destination: destination_ownership,
            source: target.path.clone(),
        });
        items.push(TrashItemDto {
            original_path: path_for_requested_root(&root, &requested_root, &target.path),
            trashed_path: path_for_requested_root(&root, &requested_root, &destination),
            is_dir: target.is_dir,
        });
    }

    Ok(TrashBatchDto { id, items })
}

/// Return Lyceum's hidden trash directory only when the path is a real
/// directory entry under the workspace. Following a workspace-provided symlink
/// here would move deleted/replaced data outside the authorized root and make it
/// impossible for the validated restore path to recover it.
fn ensure_safe_trash_root(root: &Path) -> Result<(PathBuf, bool), String> {
    let requested = root.join(LYCEUM_TRASH_DIR);
    let trash_root = if path_entry_exists(&requested) {
        existing_entry_path_with_disk_case(&requested)
    } else {
        requested
    };
    match std::fs::symlink_metadata(&trash_root) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "Lyceum trash path is not a safe directory: {}",
                    trash_root.display()
                ));
            }
            Ok((trash_root, false))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&trash_root) {
                Ok(()) => Ok((trash_root, true)),
                // Another actor may have won the creation race. Re-validate the
                // actual entry rather than treating an attacker-created symlink
                // as a directory on retry.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = std::fs::symlink_metadata(&trash_root)
                        .map_err(|e| format!("{}: {e}", trash_root.display()))?;
                    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                        Ok((trash_root, false))
                    } else {
                        Err(format!(
                            "Lyceum trash path is not a safe directory: {}",
                            trash_root.display()
                        ))
                    }
                }
                Err(error) => Err(format!("{}: {error}", trash_root.display())),
            }
        }
        Err(error) => Err(format!("{}: {error}", trash_root.display())),
    }
}

#[derive(Debug)]
struct ReplacementBackup {
    /// Destination spelling requested by the incoming source name.
    destination: PathBuf,
    /// Actual on-disk spelling of the entry that was displaced.
    original: PathBuf,
    backup: PathBuf,
    ownership: Option<OwnedEntry>,
    original_permissions: Option<std::fs::Permissions>,
}

#[derive(Debug)]
struct ReplacementStage {
    directory: PathBuf,
    trash_root: PathBuf,
    created_trash_root: bool,
    backups: Vec<ReplacementBackup>,
}

impl ReplacementStage {
    fn replaced_path_for(&self, destination: &Path) -> Option<&Path> {
        self.backups
            .iter()
            .find(|item| item.destination == destination)
            .map(|item| item.original.as_path())
    }
}

/// Move every pre-existing destination out of the way before the transfer
/// starts. The originals remain recoverable until the full batch succeeds, so
/// a failed file/directory copy or move never destroys the entries the user
/// chose to replace.
fn stage_existing_destinations(
    root: &Path,
    planned: &[(PathBuf, PathBuf, bool, bool)],
) -> Result<Option<ReplacementStage>, String> {
    if !planned.iter().any(|(_, _, _, exists)| *exists) {
        return Ok(None);
    }

    let (trash_root, created_trash_root) = ensure_safe_trash_root(root)?;

    let directory = trash_root.join(format!(".replace-{}", unique_trash_batch_id()));
    if let Err(error) = std::fs::create_dir(&directory) {
        if created_trash_root {
            let _ = std::fs::remove_dir(&trash_root);
        }
        return Err(format!("{}: {error}", directory.display()));
    }
    let mut stage = ReplacementStage {
        directory,
        trash_root,
        created_trash_root,
        backups: Vec::new(),
    };

    for (index, (_, destination, _, existed_during_plan)) in planned.iter().enumerate() {
        if !*existed_during_plan || !path_entry_exists(destination) {
            continue;
        }
        let original = existing_entry_path_with_disk_case(destination);
        let backup = stage.directory.join(index.to_string());
        let metadata = match std::fs::symlink_metadata(&original) {
            Ok(metadata) => metadata,
            Err(error) => {
                rollback_replacement_stage(Some(&stage));
                return Err(format!("{}: {error}", original.display()));
            }
        };
        let original_permissions = if metadata.file_type().is_symlink() {
            None
        } else {
            let permissions = metadata.permissions();
            if let Err(error) = make_path_owner_writable(&original, &metadata) {
                rollback_replacement_stage(Some(&stage));
                return Err(format!(
                    "could not prepare existing destination {}: {error}",
                    original.display()
                ));
            }
            Some(permissions)
        };
        stage.backups.push(ReplacementBackup {
            destination: destination.clone(),
            original: original.clone(),
            backup: backup.clone(),
            ownership: None,
            original_permissions,
        });
        match move_entry_owned(&original, &backup) {
            Ok(ownership) => {
                if let Some(staged) = stage.backups.last_mut() {
                    staged.ownership = Some(ownership);
                }
            }
            Err(error) => {
                rollback_replacement_stage(Some(&stage));
                return Err(format!(
                    "could not stage existing destination {}: {error}",
                    original.display()
                ));
            }
        }
    }

    Ok(Some(stage))
}

/// Restore staged originals after a failed transfer. Never overwrite an entry
/// that appeared concurrently: if a destination is occupied, retain its backup
/// in the hidden staging directory rather than risking either copy.
fn rollback_replacement_stage(stage: Option<&ReplacementStage>) {
    let Some(stage) = stage else {
        return;
    };
    for item in stage.backups.iter().rev() {
        let permission_target = match item.ownership.as_ref() {
            Some(ownership) if ownership.is_still_owned_at(&item.original) => Some(&item.original),
            Some(ownership) if !path_entry_exists(&item.original) => {
                match quarantine_owned_entry(ownership) {
                    Ok(quarantined) => {
                        if move_entry(&quarantined, &item.original).is_ok() {
                            Some(&item.original)
                        } else {
                            restore_quarantined_entry(&quarantined, &item.backup);
                            ownership
                                .is_still_owned_at(&item.backup)
                                .then_some(&item.backup)
                        }
                    }
                    Err(_) => None,
                }
            }
            Some(ownership) => {
                // A concurrent entry appeared at the original path. Keep its
                // permissions untouched and restore only our retained backup.
                ownership
                    .is_still_owned_at(&item.backup)
                    .then_some(&item.backup)
            }
            None if path_entry_exists(&item.original) => {
                // Ownership capture failed before staging moved anything; undo
                // the preparatory chmod on the still-present original.
                Some(&item.original)
            }
            None => None,
        };
        if let (Some(path), Some(permissions)) = (permission_target, &item.original_permissions) {
            let _ = std::fs::set_permissions(path, permissions.clone());
        }
    }
    // Only empty directories are removed here. Any backup that could not be
    // restored remains recoverable instead of being deleted during cleanup.
    let _ = std::fs::remove_dir(&stage.directory);
    if stage.created_trash_root {
        let _ = std::fs::remove_dir(&stage.trash_root);
    }
}

/// The transfer committed; the displaced originals can now be discarded.
fn discard_replacement_stage(stage: Option<&ReplacementStage>) -> Result<(), String> {
    let Some(stage) = stage else {
        return Ok(());
    };
    let cleanup_error = |error: &dyn std::fmt::Display| {
        format!(
            "replacement succeeded, but old items remain at {}: {error}",
            stage.directory.display()
        )
    };
    for item in stage.backups.iter().rev() {
        let ownership = item
            .ownership
            .as_ref()
            .ok_or_else(|| cleanup_error(&"missing backup ownership token"))?;
        let quarantined =
            quarantine_owned_entry(ownership).map_err(|error| cleanup_error(&error))?;
        if let Err(error) = remove_owned_copy(&quarantined) {
            restore_quarantined_entry(&quarantined, &item.backup);
            return Err(cleanup_error(&error));
        }
    }
    // Remove only an empty stage directory. Any concurrent extra entry remains
    // recoverable and turns into a cleanup warning instead of being deleted.
    std::fs::remove_dir(&stage.directory).map_err(|error| cleanup_error(&error))?;
    if stage.created_trash_root {
        let _ = std::fs::remove_dir(&stage.trash_root);
    }
    Ok(())
}

/// Grant the owner enough permission to delete a staged tree. Directory
/// replacement can legitimately stage a read-only directory; removal must not
/// follow symlinks or mutate their targets.
fn make_tree_removable(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        make_path_owner_writable(path, &metadata)?;
        for entry in std::fs::read_dir(path)? {
            make_tree_removable(&entry?.path())?;
        }
    } else {
        make_path_owner_writable(path, &metadata)?;
    }
    Ok(())
}

#[cfg(unix)]
fn make_path_owner_writable(path: &Path, metadata: &std::fs::Metadata) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let required = if metadata.is_dir() { 0o700 } else { 0o600 };
    if mode & required != required {
        permissions.set_mode(mode | required);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(windows)]
fn make_path_owner_writable(path: &Path, metadata: &std::fs::Metadata) -> std::io::Result<()> {
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn make_path_owner_writable(_path: &Path, _metadata: &std::fs::Metadata) -> std::io::Result<()> {
    Ok(())
}

fn existing_entry_path_with_disk_case(path: &Path) -> PathBuf {
    let (Some(parent), Some(requested_name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    let Ok(read) = std::fs::read_dir(parent) else {
        return path.to_path_buf();
    };
    let candidates: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    if let Some(exact) = candidates
        .iter()
        .find(|candidate| candidate.file_name() == Some(requested_name))
    {
        return exact.clone();
    }
    if let Some(same) = candidates
        .iter()
        .find(|candidate| same_filesystem_entry(candidate, path))
    {
        return same.clone();
    }
    // Fallback for platforms where file identity is unavailable and a broken
    // symlink cannot be canonicalized. This branch is reached only after
    // symlink_metadata(path) proved that the requested spelling resolves.
    let requested = requested_name.to_string_lossy();
    candidates
        .into_iter()
        .find(|candidate| {
            candidate
                .file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case(&requested))
                .unwrap_or(false)
        })
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(unix)]
fn same_filesystem_entry(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let (Ok(left), Ok(right)) = (
        std::fs::symlink_metadata(left),
        std::fs::symlink_metadata(right),
    ) else {
        return false;
    };
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_filesystem_entry(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn destination_conflict_error(paths: &[String]) -> String {
    // String serialization cannot fail, but keep a non-structured fallback so
    // an impossible serializer failure still reports the underlying problem.
    let encoded = serde_json::to_string(paths).unwrap_or_else(|_| "[]".to_string());
    format!("destination conflict: already exists: {encoded}")
}

fn conflict_paths_are_approved(current: &[String], approved: &[String]) -> bool {
    let approved: HashSet<&String> = approved.iter().collect();
    current.iter().all(|path| approved.contains(path))
}

fn reject_sources_inside_replaced_destinations(
    planned: &[(PathBuf, PathBuf, bool, bool)],
) -> Result<(), String> {
    // Resolve the actual on-disk spelling for both sides before the lexical
    // containment check. On a case-insensitive filesystem, a planned
    // destination such as `Container` can resolve to an existing `container`;
    // comparing the requested spellings would miss a source nested in the
    // entry that replacement staging is about to move out of the way.
    let replaced_destinations: Vec<PathBuf> = planned
        .iter()
        .filter(|(_, _, _, exists)| *exists)
        .map(|(_, destination, _, _)| existing_entry_path_with_disk_case(destination))
        .collect();
    for (source, _, _, _) in planned {
        let comparable_source =
            existing_entry_path_with_disk_case(&canonical_entry_path_without_following(source));
        if let Some(destination) = replaced_destinations
            .iter()
            .find(|destination| comparable_source.starts_with(destination.as_path()))
        {
            return Err(format!(
                "source is inside a destination that would be replaced: {} inside {}",
                source.display(),
                destination.display()
            ));
        }
    }
    Ok(())
}

fn canonical_entry_path_without_following(path: &Path) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    parent
        .canonicalize()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
fn move_paths_impl(
    root: &Path,
    paths: Vec<String>,
    destination_dir: &Path,
) -> Result<Vec<MovedPathDto>, String> {
    move_paths_impl_with_replace(root, paths, destination_dir, false, None)
}

fn move_paths_impl_with_replace(
    root: &Path,
    paths: Vec<String>,
    destination_dir: &Path,
    replace_existing: bool,
    expected_conflict_paths: Option<&[String]>,
) -> Result<Vec<MovedPathDto>, String> {
    let requested_root = root.to_path_buf();
    let root = canonical_dir(root)?;
    let destination = destination_dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", destination_dir.display()))?;
    validate_move_destination(&root, &destination)?;
    let targets = normalize_move_targets(&root, paths)?;

    let mut planned = Vec::new();
    let mut destinations = HashSet::new();
    let mut conflicts = Vec::new();
    for target in targets {
        let parent = target
            .path
            .parent()
            .ok_or_else(|| format!("invalid move path: {}", target.path.display()))?;
        if parent == destination {
            continue;
        }
        if target.is_dir && destination.starts_with(&target.path) {
            return Err(format!(
                "cannot move a folder into itself: {} -> {}",
                target.path.display(),
                destination.display()
            ));
        }
        let name = target
            .path
            .file_name()
            .ok_or_else(|| format!("cannot determine file name for {}", target.path.display()))?;
        let to = destination.join(name);
        reject_workspace_trash_destination(&root, &to)?;
        if !destinations.insert(to.clone()) {
            return Err(format!(
                "multiple moved items would overwrite {}",
                to.display()
            ));
        }
        let replaced = path_entry_exists(&to);
        if replaced {
            let existing = existing_entry_path_with_disk_case(&to);
            conflicts.push(path_for_requested_root(&root, &requested_root, &existing));
        }
        planned.push((target.path.clone(), to, target.is_dir, replaced));
    }

    reject_sources_inside_replaced_destinations(&planned)?;

    if replace_existing {
        if !conflict_paths_are_approved(&conflicts, expected_conflict_paths.unwrap_or(&[])) {
            return Err(destination_conflict_error(&conflicts));
        }
    } else if !conflicts.is_empty() {
        return Err(destination_conflict_error(&conflicts));
    }

    let replacement_stage = if replace_existing {
        stage_existing_destinations(&root, &planned)?
    } else {
        None
    };

    let mut moved = Vec::with_capacity(planned.len());
    let mut done: Vec<CompletedMove> = Vec::new();
    for (from, to, is_dir, _had_conflict) in planned {
        // Re-check existence right before the move. The planning loop above ran
        // path_entry_exists BEFORE any move, so an earlier move in THIS batch may
        // have created `to`; and on a case-insensitive filesystem (macOS/Windows)
        // two destinations differing only in case (note.txt vs NOTE.txt) fold to
        // the same on-disk entry, which the byte-exact dedup HashSet misses.
        // Without this re-check the second rename would SILENTLY overwrite the
        // first (data loss). path_entry_exists reflects the FS's real case
        // behavior, so it neither false-rejects on a case-sensitive FS nor misses
        // a collision on a case-insensitive one.
        if path_entry_exists(&to) {
            let batch_collision = done
                .iter()
                .any(|item| same_filesystem_entry(&item.destination.path, &to));
            rollback_moves(&done);
            rollback_replacement_stage(replacement_stage.as_ref());
            if batch_collision {
                return Err(format!(
                    "multiple moved items would overwrite {}",
                    to.display()
                ));
            }
            let existing = existing_entry_path_with_disk_case(&to);
            let conflict = path_for_requested_root(&root, &requested_root, &existing);
            return Err(destination_conflict_error(&[conflict]));
        }
        let destination_ownership = match move_entry_owned(&from, &to) {
            Ok(ownership) => ownership,
            Err(e) => {
                rollback_moves(&done);
                rollback_replacement_stage(replacement_stage.as_ref());
                return Err(format!("{} -> {}: {e}", from.display(), to.display()));
            }
        };
        done.push(CompletedMove {
            destination: destination_ownership,
            source: from.clone(),
        });
        if path_starts_with_trash(&root, &to) {
            rollback_moves(&done);
            rollback_replacement_stage(replacement_stage.as_ref());
            return Err(format!(
                "refusing to create a Lyceum trash alias: {}",
                to.display()
            ));
        }
        let replaced_path = replacement_stage
            .as_ref()
            .and_then(|stage| stage.replaced_path_for(&to))
            .map(|path| path_for_requested_root(&root, &requested_root, path));
        moved.push(MovedPathDto {
            from: path_for_requested_root(&root, &requested_root, &from),
            to: path_for_requested_root(&root, &requested_root, &to),
            is_dir,
            replaced: replaced_path.is_some(),
            replaced_path,
            cleanup_warning: None,
        });
    }
    if let Err(warning) = discard_replacement_stage(replacement_stage.as_ref()) {
        if let Some(first) = moved.first_mut() {
            first.cleanup_warning = Some(warning);
        }
    }
    Ok(moved)
}

#[cfg(test)]
fn copy_paths_impl(
    root: &Path,
    paths: Vec<String>,
    destination_dir: &Path,
) -> Result<Vec<MovedPathDto>, String> {
    copy_paths_impl_with_replace(root, paths, destination_dir, false, None)
}

fn copy_paths_impl_with_replace(
    root: &Path,
    paths: Vec<String>,
    destination_dir: &Path,
    replace_existing: bool,
    expected_conflict_paths: Option<&[String]>,
) -> Result<Vec<MovedPathDto>, String> {
    let requested_root = root.to_path_buf();
    let root = canonical_dir(root)?;
    let destination = destination_dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", destination_dir.display()))?;
    validate_move_destination(&root, &destination)?;

    // Plan: resolve every source and its destination name, rejecting collisions
    // and duplicate destinations BEFORE copying anything, so an invalid drop
    // leaves the workspace untouched.
    let mut planned: Vec<(PathBuf, PathBuf, bool, bool)> = Vec::new();
    let mut destinations = HashSet::new();
    let mut conflicts = Vec::new();
    for raw in paths {
        let source = absolute_lexical_path(Path::new(&raw));
        let source_meta =
            std::fs::symlink_metadata(&source).map_err(|e| format!("{}: {e}", source.display()))?;
        let source_file_type = source_meta.file_type();
        let is_dir = if source_file_type.is_symlink() {
            std::fs::metadata(&source)
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
        } else {
            source_file_type.is_dir()
        };
        // Copying a folder into itself or its own descendant would recurse
        // forever as the copy keeps re-reading what it just wrote. Resolve
        // ancestor symlinks and case aliases for a REAL directory source; the
        // destination itself exists and is already canonical. Do not resolve a
        // final symlink entry because copy_recursive preserves that link rather
        // than traversing its directory target.
        let canonical_directory_source = if source_file_type.is_dir() {
            Some(
                source
                    .canonicalize()
                    .map_err(|e| format!("{}: {e}", source.display()))?,
            )
        } else {
            None
        };
        if canonical_directory_source
            .as_ref()
            .is_some_and(|source| destination.starts_with(source))
        {
            return Err(format!(
                "cannot copy a folder into itself: {} -> {}",
                source.display(),
                destination.display()
            ));
        }
        let name = source
            .file_name()
            .ok_or_else(|| format!("cannot determine file name for {}", source.display()))?;
        let to = destination.join(name);
        reject_workspace_trash_destination(&root, &to)?;
        if path_entry_exists(&to) && same_filesystem_entry(&source, &to) {
            return Err(format!(
                "source and destination are the same filesystem entry: {}",
                source.display()
            ));
        }
        if !destinations.insert(to.clone()) {
            return Err(format!("multiple items would overwrite {}", to.display()));
        }
        let replaced = path_entry_exists(&to);
        if replaced {
            let existing = existing_entry_path_with_disk_case(&to);
            conflicts.push(path_for_requested_root(&root, &requested_root, &existing));
        }
        planned.push((source, to, is_dir, replaced));
    }

    reject_sources_inside_replaced_destinations(&planned)?;

    if replace_existing {
        if !conflict_paths_are_approved(&conflicts, expected_conflict_paths.unwrap_or(&[])) {
            return Err(destination_conflict_error(&conflicts));
        }
    } else if !conflicts.is_empty() {
        return Err(destination_conflict_error(&conflicts));
    }

    let replacement_stage = if replace_existing {
        stage_existing_destinations(&root, &planned)?
    } else {
        None
    };

    let mut copied = Vec::with_capacity(planned.len());
    // Destinations created so far; on any failure they're removed so a partial
    // multi-item import leaves nothing stray behind. The sources are external
    // and never touched, so removing the copies is always safe.
    let mut done: Vec<OwnedEntry> = Vec::new();
    for (from, to, is_dir, _had_conflict) in planned {
        // Re-check right before copying: an earlier copy in THIS batch, or a
        // case-insensitive FS folding two names together (note.txt vs NOTE.txt),
        // may have created `to` after the planning loop's check.
        if path_entry_exists(&to) {
            let batch_collision = done
                .iter()
                .any(|destination| same_filesystem_entry(&destination.path, &to));
            rollback_copies(&done);
            rollback_replacement_stage(replacement_stage.as_ref());
            if batch_collision {
                return Err(format!("multiple items would overwrite {}", to.display()));
            }
            let existing = existing_entry_path_with_disk_case(&to);
            let conflict = path_for_requested_root(&root, &requested_root, &existing);
            return Err(destination_conflict_error(&[conflict]));
        }
        let owned_copy = match copy_entry_owned(&from, &to) {
            Ok(owned_copy) => owned_copy,
            Err(e) => {
                rollback_copies(&done);
                rollback_replacement_stage(replacement_stage.as_ref());
                return Err(format!("{} -> {}: {e}", from.display(), to.display()));
            }
        };
        done.push(owned_copy);
        if path_starts_with_trash(&root, &to) {
            rollback_copies(&done);
            rollback_replacement_stage(replacement_stage.as_ref());
            return Err(format!(
                "refusing to create a Lyceum trash alias: {}",
                to.display()
            ));
        }
        let replaced_path = replacement_stage
            .as_ref()
            .and_then(|stage| stage.replaced_path_for(&to))
            .map(|path| path_for_requested_root(&root, &requested_root, path));
        copied.push(MovedPathDto {
            from: from.to_string_lossy().to_string(),
            to: path_for_requested_root(&root, &requested_root, &to),
            is_dir,
            replaced: replaced_path.is_some(),
            replaced_path,
            cleanup_warning: None,
        });
    }
    if let Err(warning) = discard_replacement_stage(replacement_stage.as_ref()) {
        if let Some(first) = copied.first_mut() {
            first.cleanup_warning = Some(warning);
        }
    }
    Ok(copied)
}

/// Remove already-copied destinations to undo a partially-failed import.
fn rollback_copies(done: &[OwnedEntry]) {
    rollback_copies_with_hook(done, |_owned, _quarantined| {});
}

fn rollback_copies_with_hook(
    done: &[OwnedEntry],
    mut after_quarantine: impl FnMut(&OwnedEntry, &Path),
) {
    for dest in done.iter().rev() {
        let Ok(quarantined) = quarantine_owned_entry(dest) else {
            continue;
        };
        after_quarantine(dest, &quarantined);
        if let Err(_error) = remove_owned_copy(&quarantined) {
            restore_quarantined_entry(&quarantined, &dest.path);
        }
    }
}

/// Atomically move the current pathname into a unique sibling before checking
/// ownership. If another actor replaced the path before this rename, the token
/// fails at the quarantine name and the entry is restored rather than deleted
/// or moved as ours. A new entry created at the original name after quarantine
/// is never touched by rollback.
fn quarantine_owned_entry(owned: &OwnedEntry) -> std::io::Result<PathBuf> {
    if owned.tree.is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "rollback ownership could not be captured",
        ));
    }
    let parent = owned
        .path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    const MAX_ATTEMPTS: usize = 128;
    for _ in 0..MAX_ATTEMPTS {
        let sequence = ROLLBACK_STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
        let quarantined = parent.join(format!(
            ".lyceum-rollback.{}.{sequence}",
            std::process::id()
        ));
        match rename_noreplace(&owned.path, &quarantined) {
            Ok(()) => {
                if owned.is_still_owned_at(&quarantined) {
                    // The root descriptor prevents inode reuse until the
                    // atomically quarantined tree has been verified. Its job is
                    // complete after this check, so do not retain it while the
                    // verified tree is made removable and deleted.
                    owned.release_root_pin();
                    return Ok(quarantined);
                }
                restore_quarantined_entry(&quarantined, &owned.path);
                return Err(std::io::Error::other(
                    "rollback path no longer contains the owned entry tree",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not claim a unique rollback quarantine path",
    ))
}

fn restore_quarantined_entry(quarantined: &Path, original: &Path) {
    // No-replace restoration protects an entry that appeared at `original`
    // while rollback inspected the quarantine. If occupied, retain the
    // quarantined data under its unique recovery name instead of overwriting.
    let _ = rename_noreplace(quarantined, original);
}

fn remove_owned_copy(path: &Path) -> std::io::Result<()> {
    // A completed copied directory already has the source's permissions. If that
    // source was read-only, a later batch failure cannot traverse/unlink it until
    // owner write/execute bits are restored. This path is owned by the current
    // copy (its root was claimed with create_dir/create_new), so preparing it for
    // rollback cannot affect a pre-existing destination.
    make_tree_removable(path)?;
    remove_entry(path)
}

fn restore_trash_batch_impl(root: &Path, items: Vec<TrashItemDto>) -> Result<(), String> {
    let requested_root = root.to_path_buf();
    let root = canonical_dir(root)?;
    for item in &items {
        let original = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.original_path),
        );
        let trashed = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.trashed_path),
        );
        validate_restore_pair(&root, &original, &trashed)?;
        if !path_entry_exists(&trashed) {
            return Err(format!(
                "restore source no longer exists: {}",
                trashed.display()
            ));
        }
        if path_entry_exists(&original) {
            return Err(format!(
                "restore destination already exists: {}",
                original.display()
            ));
        }
    }
    let mut done: Vec<CompletedMove> = Vec::new();
    for item in &items {
        let original = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.original_path),
        );
        let trashed = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.trashed_path),
        );
        if let Some(parent) = original.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        if let Err(e) = validate_restore_pair(&root, &original, &trashed) {
            rollback_moves(&done);
            return Err(e);
        }
        if !path_entry_exists(&trashed) {
            rollback_moves(&done);
            return Err(format!(
                "restore source no longer exists: {}",
                trashed.display()
            ));
        }
        if path_entry_exists(&original) {
            rollback_moves(&done);
            return Err(format!(
                "restore destination already exists: {}",
                original.display()
            ));
        }
        let destination_ownership = match move_entry_owned(&trashed, &original) {
            Ok(ownership) => ownership,
            Err(e) => {
                rollback_moves(&done);
                return Err(format!(
                    "{} -> {}: {e}",
                    trashed.display(),
                    original.display()
                ));
            }
        };
        done.push(CompletedMove {
            destination: destination_ownership,
            source: trashed.clone(),
        });
        cleanup_empty_trash_ancestors(&root, &trashed);
    }
    Ok(())
}

fn redo_trash_batch_impl(root: &Path, items: Vec<TrashItemDto>) -> Result<(), String> {
    let requested_root = root.to_path_buf();
    let root = canonical_dir(root)?;
    for item in &items {
        let original = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.original_path),
        );
        let trashed = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.trashed_path),
        );
        validate_restore_pair(&root, &original, &trashed)?;
        if !path_entry_exists(&original) {
            return Err(format!(
                "redo source does not exist: {}",
                original.display()
            ));
        }
        if path_entry_exists(&trashed) {
            return Err(format!(
                "redo destination already exists: {}",
                trashed.display()
            ));
        }
    }
    let mut done: Vec<CompletedMove> = Vec::new();
    for item in &items {
        let original = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.original_path),
        );
        let trashed = workspace_path_for_canonical_root(
            &root,
            &requested_root,
            Path::new(&item.trashed_path),
        );
        if let Some(parent) = trashed.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                rollback_moves(&done);
                return Err(format!("{}: {e}", parent.display()));
            }
        }
        if let Err(e) = validate_restore_pair(&root, &original, &trashed) {
            rollback_moves(&done);
            return Err(e);
        }
        if !path_entry_exists(&original) {
            rollback_moves(&done);
            return Err(format!(
                "redo source does not exist: {}",
                original.display()
            ));
        }
        if path_entry_exists(&trashed) {
            rollback_moves(&done);
            return Err(format!(
                "redo destination already exists: {}",
                trashed.display()
            ));
        }
        let destination_ownership = match move_entry_owned(&original, &trashed) {
            Ok(ownership) => ownership,
            Err(e) => {
                rollback_moves(&done);
                return Err(format!(
                    "{} -> {}: {e}",
                    original.display(),
                    trashed.display()
                ));
            }
        };
        done.push(CompletedMove {
            destination: destination_ownership,
            source: original.clone(),
        });
    }
    Ok(())
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    Ok(path)
}

fn path_entry_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// True when an io error is a cross-filesystem rename (EXDEV on unix,
/// ERROR_NOT_SAME_DEVICE on Windows). Such renames must fall back to copy+delete.
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(18)
    }
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = e;
        false
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source path contains NUL")
    })?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path contains NUL",
        )
    })?;
    // SAFETY: both pointers are valid NUL-terminated path strings for the
    // duration of the call. RENAME_EXCL asks the kernel to fail atomically if
    // the destination entry already exists.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source path contains NUL")
    })?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path contains NUL",
        )
    })?;
    // SAFETY: the C strings remain alive for the call; renameat2 does not retain
    // either pointer. RENAME_NOREPLACE makes the final existence check atomic.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    fn wide_path(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    let from = wide_path(from)?;
    let to = wide_path(to)?;
    // Zero flags deliberately omits MOVEFILE_REPLACE_EXISTING. MoveFileExW then
    // atomically fails with ERROR_ALREADY_EXISTS/ERROR_FILE_EXISTS if `to` is
    // occupied, unlike modern std::fs::rename which may replace it on Windows.
    // SAFETY: both vectors are live, NUL-terminated UTF-16 strings and the API
    // retains neither pointer after returning.
    let result = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android",
    windows
)))]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    let _ = (from, to);
    // No portable no-replace rename exists in std. Never fall back to a racy
    // check followed by std::fs::rename (which overwrites on Unix); signal the
    // caller to use the slower create_new/create_dir copy+delete path instead.
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable on this platform",
    ))
}

fn no_replace_rename_unavailable(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL))
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS | libc::ENOTSUP | libc::EINVAL)
        )
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = error;
        false
    }
}

/// Move `from` to `to`, preferring an atomic rename and falling back to a
/// recursive copy + delete when the two live on different filesystems (a
/// workspace that spans a mount point). Symlinks are recreated as symlinks
/// (the link itself moves, never its target), matching the rename semantics the
/// rest of the module relies on.
fn move_entry_owned(from: &Path, to: &Path) -> std::io::Result<OwnedEntry> {
    let mut source_ownership = OwnedEntry::try_capture(from.to_path_buf())?;
    match rename_noreplace(from, to) {
        Ok(()) => {
            source_ownership.path = to.to_path_buf();
            Ok(source_ownership)
        }
        Err(error) if is_cross_device(&error) || no_replace_rename_unavailable(&error) => {
            let destination_ownership = copy_entry_owned(from, to)?;
            if let Err(remove_error) = remove_entry(from) {
                let copied_is_dir = std::fs::symlink_metadata(to)
                    .map(|metadata| metadata.file_type().is_dir())
                    .unwrap_or(false);
                if !copied_is_dir {
                    rollback_copies(std::slice::from_ref(&destination_ownership));
                }
                return Err(remove_error);
            }
            Ok(destination_ownership)
        }
        Err(error) => Err(error),
    }
}

fn move_entry(from: &Path, to: &Path) -> std::io::Result<()> {
    match rename_noreplace(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) || no_replace_rename_unavailable(&e) => {
            // Publish a fully captured copy so cleanup after a source-removal
            // failure can prove destination ownership instead of deleting by
            // pathname alone.
            let destination_ownership = copy_entry_owned(from, to)?;
            // If the source can't be removed after a successful copy, the data
            // would otherwise exist at BOTH paths while the move reports failure
            // (callers' rollback only reverses moves already recorded as done,
            // never this half-finished one). Best-effort remove the fresh copy so
            // the cross-device path stays all-or-nothing like the rename path —
            // but ONLY when the source removal was ATOMIC (a single file or
            // symlink). For a directory, remove_entry uses remove_dir_all, which
            // is NON-atomic: a partial failure may have already deleted part of
            // `from`, leaving `to` as the ONLY copy of those files, so removing
            // `to` would lose them. Keep both in that case (the complete copy at
            // `to` stays recoverable) and surface the error.
            if let Err(remove_err) = remove_entry(from) {
                let copied_is_dir = std::fs::symlink_metadata(to)
                    .map(|m| m.file_type().is_dir())
                    .unwrap_or(false);
                cleanup_failed_cross_device_destination(
                    &destination_ownership,
                    copied_is_dir,
                    |_destination| {},
                );
                return Err(remove_err);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn cleanup_failed_cross_device_destination(
    destination: &OwnedEntry,
    copied_is_dir: bool,
    before_cleanup: impl FnOnce(&Path),
) {
    before_cleanup(&destination.path);
    if !copied_is_dir {
        rollback_copies(std::slice::from_ref(destination));
    }
}

/// Build a top-level copy under a unique sibling name, snapshot every owned
/// entry there, then publish it with an atomic no-replace rename. The snapshot
/// therefore exists before external actors can reach the requested destination,
/// closing the copy-complete-to-token-capture race.
fn copy_entry_owned(from: &Path, to: &Path) -> std::io::Result<OwnedEntry> {
    let parent = to
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    const MAX_ATTEMPTS: usize = 128;
    for _ in 0..MAX_ATTEMPTS {
        let sequence = COPY_STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
        let staging_directory =
            parent.join(format!(".lyceum-copy.{}.{sequence}", std::process::id()));
        match std::fs::create_dir(&staging_directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
        let staged = staging_directory.join("entry");
        if let Err(error) = copy_recursive(from, &staged) {
            let _ = remove_owned_copy(&staging_directory);
            return Err(error);
        }
        let mut owned = match OwnedEntry::try_capture(staged.clone()) {
            Ok(owned) => owned,
            Err(error) => {
                let _ = remove_owned_copy(&staging_directory);
                return Err(error);
            }
        };
        if let Err(error) = rename_noreplace(&staged, to) {
            let _ = remove_owned_copy(&staging_directory);
            return Err(error);
        }
        let _ = std::fs::remove_dir(&staging_directory);
        owned.path = to.to_path_buf();
        return Ok(owned);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not claim a unique copy staging path",
    ))
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(from)?;
        symlink_to(&target, to, copied_symlink_kind(from))
    } else if ft.is_dir() {
        // `create_dir` atomically claims the destination root; create_dir_all
        // would merge into a concurrently-created directory.
        std::fs::create_dir(to)?;
        let result = (|| {
            for entry in std::fs::read_dir(from)? {
                let entry = entry?;
                copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
            }
            std::fs::set_permissions(to, meta.permissions())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = remove_owned_copy(to);
        }
        result
    } else if ft.is_file() {
        let mut source = std::fs::File::open(from)?;
        let mut destination = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)?;
        let result = (|| {
            std::io::copy(&mut source, &mut destination)?;
            destination.sync_all()?;
            Ok(())
        })();
        drop(destination);
        if let Err(error) = result {
            let _ = std::fs::remove_file(to);
            return Err(error);
        }
        if let Err(error) = std::fs::set_permissions(to, meta.permissions()) {
            let _ = std::fs::remove_file(to);
            return Err(error);
        }
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            format!("unsupported filesystem entry: {}", from.display()),
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopiedSymlinkKind {
    File,
    Directory,
}

#[cfg(not(windows))]
fn copied_symlink_kind(source_link: &Path) -> CopiedSymlinkKind {
    // `metadata(source_link)` follows a relative link from the SOURCE link's
    // parent, which is the only correct basis for choosing Windows' distinct
    // symlink_file/symlink_dir APIs. A broken link has no discoverable target
    // kind through portable std APIs; preserve the historical file-link fallback.
    if std::fs::metadata(source_link)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        CopiedSymlinkKind::Directory
    } else {
        CopiedSymlinkKind::File
    }
}

#[cfg(windows)]
fn copied_symlink_kind(source_link: &Path) -> CopiedSymlinkKind {
    use std::os::windows::fs::FileTypeExt;

    let file_type = match std::fs::symlink_metadata(source_link) {
        Ok(metadata) => metadata.file_type(),
        Err(_) => return CopiedSymlinkKind::File,
    };
    if file_type.is_symlink_dir() {
        CopiedSymlinkKind::Directory
    } else {
        // Includes symlink_file and an explicitly documented conservative
        // fallback for an unrecognized reparse-point kind.
        CopiedSymlinkKind::File
    }
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;

        // A Windows directory symlink is a symlink (so generic is_dir() is
        // false) but DeleteFile/remove_file rejects its directory link kind.
        // RemoveDirectory removes the link entry itself and never its target.
        if meta.file_type().is_symlink_dir() {
            return std::fs::remove_dir(path);
        }
    }
    if meta.file_type().is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(unix)]
fn symlink_to(target: &Path, link: &Path, _kind: CopiedSymlinkKind) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink_to(target: &Path, link: &Path, kind: CopiedSymlinkKind) -> std::io::Result<()> {
    match kind {
        CopiedSymlinkKind::Directory => std::os::windows::fs::symlink_dir(target, link),
        CopiedSymlinkKind::File => std::os::windows::fs::symlink_file(target, link),
    }
}

#[cfg(not(any(unix, windows)))]
fn symlink_to(_target: &Path, _link: &Path, _kind: CopiedSymlinkKind) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks unsupported on this platform",
    ))
}

/// Reverse a sequence of completed moves `(dest, source)` by moving each
/// `dest` back to `source` (newest first). Best-effort cleanup used to keep
/// trash/restore/redo all-or-nothing on a mid-batch failure.
fn rollback_moves(done: &[CompletedMove]) {
    for item in done.iter().rev() {
        let Ok(quarantined) = quarantine_owned_entry(&item.destination) else {
            continue;
        };
        if let Some(parent) = item.source.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if move_entry(&quarantined, &item.source).is_err() {
            restore_quarantined_entry(&quarantined, &item.destination.path);
        }
    }
}

fn normalize_delete_targets(
    root: &Path,
    paths: Vec<String>,
) -> Result<Vec<WorkspaceEntryTarget>, String> {
    let mut targets: Vec<WorkspaceEntryTarget> = Vec::new();
    for raw in paths {
        let target = existing_workspace_entry_target(&raw)?;
        validate_workspace_target(root, &target.path)?;
        if !targets.iter().any(|entry| entry.path == target.path) {
            targets.push(target);
        }
    }
    targets.sort_by_key(|entry| entry.path.components().count());
    let mut top_level: Vec<WorkspaceEntryTarget> = Vec::new();
    for target in targets {
        if !top_level
            .iter()
            .any(|parent| target.path.starts_with(&parent.path))
        {
            top_level.push(target);
        }
    }
    Ok(top_level)
}

fn normalize_move_targets(
    root: &Path,
    paths: Vec<String>,
) -> Result<Vec<WorkspaceEntryTarget>, String> {
    let mut targets: Vec<WorkspaceEntryTarget> = Vec::new();
    for raw in paths {
        let target = existing_workspace_entry_target(&raw)?;
        validate_workspace_move_target(root, &target.path)?;
        if !targets.iter().any(|entry| entry.path == target.path) {
            targets.push(target);
        }
    }
    targets.sort_by_key(|entry| entry.path.components().count());
    let mut top_level: Vec<WorkspaceEntryTarget> = Vec::new();
    for target in targets {
        if !top_level
            .iter()
            .any(|parent| target.path.starts_with(&parent.path))
        {
            top_level.push(target);
        }
    }
    Ok(top_level)
}

fn existing_workspace_entry_target(raw: &str) -> Result<WorkspaceEntryTarget, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {raw}"));
    }
    let file_type = std::fs::symlink_metadata(path)
        .map_err(|e| format!("{raw}: {e}"))?
        .file_type();
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid path: {}", path.display()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", parent.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("cannot determine file name for {}", path.display()))?;
    Ok(WorkspaceEntryTarget {
        path: canonical_parent.join(file_name),
        is_dir: file_type.is_dir(),
    })
}

fn validate_workspace_target(root: &Path, target: &Path) -> Result<(), String> {
    if target == root {
        return Err("refusing to delete the workspace root".to_string());
    }
    if !target.starts_with(root) {
        return Err(format!("outside workspace: {}", target.display()));
    }
    if path_starts_with_trash(root, target) {
        return Err(format!(
            "refusing to delete Lyceum trash: {}",
            target.display()
        ));
    }
    Ok(())
}

fn validate_workspace_move_target(root: &Path, target: &Path) -> Result<(), String> {
    if target == root {
        return Err("refusing to move the workspace root".to_string());
    }
    if !target.starts_with(root) {
        return Err(format!("outside workspace: {}", target.display()));
    }
    if path_starts_with_trash(root, target) {
        return Err(format!(
            "refusing to move Lyceum trash: {}",
            target.display()
        ));
    }
    Ok(())
}

fn validate_move_destination(root: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_dir() {
        return Err(format!("not a directory: {}", destination.display()));
    }
    if !destination.starts_with(root) {
        return Err(format!(
            "move destination outside workspace: {}",
            destination.display()
        ));
    }
    if path_starts_with_trash(root, destination) {
        return Err(format!(
            "refusing to move into Lyceum trash: {}",
            destination.display()
        ));
    }
    Ok(())
}

fn validate_workspace_mutation_destination(root: &Path, target: &Path) -> Result<(), String> {
    let effective = canonicalize_existing_ancestors_preserving_final_name(target)?;
    validate_workspace_path_no_traversal(root, &effective, "workspace destination")?;
    reject_workspace_trash_destination(root, &effective)
}

/// Resolve every currently existing parent component, but keep the requested
/// leaf spelling. This closes parent-symlink boundary bypasses without turning
/// a case-only rename destination back into the source's current disk case.
fn canonicalize_existing_ancestors_preserving_final_name(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("cannot determine file name for {}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot determine parent for {}", path.display()))?;
    let mut existing = parent;
    while !path_entry_exists(existing) {
        existing = existing
            .parent()
            .ok_or_else(|| format!("no existing ancestor for {}", path.display()))?;
    }
    let canonical = existing
        .canonicalize()
        .map_err(|error| format!("{}: {error}", existing.display()))?;
    let missing = parent
        .strip_prefix(existing)
        .map_err(|error| format!("{}: {error}", parent.display()))?;
    Ok(canonical.join(missing).join(name))
}

fn reject_workspace_trash_destination(root: &Path, target: &Path) -> Result<(), String> {
    let reserved = path_would_be_workspace_trash(root, target).map_err(|error| {
        format!(
            "could not validate reserved workspace path {}: {error}",
            target.display()
        )
    })?;
    if reserved {
        return Err(format!(
            "refusing to create or replace Lyceum trash: {}",
            target.display()
        ));
    }
    Ok(())
}

fn validate_restore_pair(root: &Path, original: &Path, trashed: &Path) -> Result<(), String> {
    validate_workspace_path_no_traversal(root, original, "restore destination")?;
    validate_workspace_path_no_traversal(root, trashed, "trash item")?;
    let original_parent = original
        .parent()
        .ok_or_else(|| format!("invalid restore path: {}", original.display()))?;
    validate_existing_ancestor_inside(root, original_parent, "restore destination")?;
    if let Some(trashed_parent) = trashed.parent() {
        validate_existing_ancestor_inside(root, trashed_parent, "trash item")?;
    }
    if path_starts_with_trash(root, original) {
        return Err(format!(
            "restore destination is inside Lyceum trash: {}",
            original.display()
        ));
    }
    if !path_starts_with_trash(root, trashed) {
        return Err(format!(
            "trash item outside Lyceum trash: {}",
            trashed.display()
        ));
    }
    Ok(())
}

fn validate_existing_ancestor_inside(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if path_entry_exists(candidate) {
            let canonical = candidate
                .canonicalize()
                .map_err(|e| format!("{}: {e}", candidate.display()))?;
            if canonical.starts_with(root) {
                return Ok(());
            }
            return Err(format!(
                "{label} resolves outside workspace: {}",
                path.display()
            ));
        }
        current = candidate.parent();
    }
    Err(format!(
        "{label} has no existing workspace ancestor: {}",
        path.display()
    ))
}

fn validate_workspace_path_no_traversal(
    root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} is not absolute: {}", path.display()));
    }
    if !path.starts_with(root) {
        return Err(format!("{label} outside workspace: {}", path.display()));
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "{label} contains path traversal: {}",
            path.display()
        ));
    }
    Ok(())
}

fn path_starts_with_trash(root: &Path, path: &Path) -> bool {
    path_starts_with_workspace_trash(root, path)
}

fn is_trash_entry_for_workspace(root: &Path, entry: &Path, _name: &str) -> bool {
    path_resolves_into_workspace_trash(root, entry)
}

fn path_for_requested_root(canonical_root: &Path, requested_root: &Path, path: &Path) -> String {
    match path.strip_prefix(canonical_root) {
        Ok(relative) => requested_root.join(relative).to_string_lossy().to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

fn workspace_path_for_canonical_root(
    canonical_root: &Path,
    requested_root: &Path,
    path: &Path,
) -> PathBuf {
    if let Ok(relative) = path.strip_prefix(canonical_root) {
        return canonical_root.join(relative);
    }
    if let Ok(relative) = path.strip_prefix(requested_root) {
        return canonical_root.join(relative);
    }
    path.to_path_buf()
}

fn absolute_lexical_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn unique_trash_batch_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TRASH_BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", millis, std::process::id(), seq)
}

fn cleanup_empty_trash_ancestors(root: &Path, path: &Path) {
    let trash_root = root.join(LYCEUM_TRASH_DIR);
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == trash_root {
            break;
        }
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(any(unix, windows))]
    #[test]
    fn move_entry_never_overwrites_an_existing_destination() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source.txt");
        let destination = tmp.path().join("destination.txt");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"destination must survive").unwrap();

        let error = move_entry(&source, &destination)
            .expect_err("a no-replace move must reject an occupied destination");

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&destination).unwrap(), b"destination must survive");
    }

    #[test]
    fn windows_noreplace_source_uses_movefile_without_replace_flag() {
        // This host-independent guard covers the Windows-only cfg branch in
        // local macOS/Linux runs; Windows CI additionally executes the behavior
        // test above.
        let source = include_str!("fs_ops.rs").replace('\r', "");
        let start = source
            .find("#[cfg(windows)]\npub(crate) fn rename_noreplace")
            .expect("Windows no-replace branch");
        let end = source[start..]
            .find("#[cfg(not(any(")
            .map(|offset| start + offset)
            .expect("end of Windows branch");
        let implementation = &source[start..end];

        assert!(implementation.contains("MoveFileExW"));
        assert!(implementation.contains("to.as_ptr(), 0"));
        assert!(!implementation.contains("std::fs::rename(from, to)"));
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_never_follows_an_existing_destination_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source.txt");
        let outside = tmp.path().join("outside.txt");
        let destination = tmp.path().join("destination.txt");
        fs::write(&source, b"source").unwrap();
        fs::write(&outside, b"outside must survive").unwrap();
        symlink(&outside, &destination).unwrap();

        copy_recursive(&source, &destination)
            .expect_err("copy must atomically reject an occupied destination entry");

        assert_eq!(fs::read(&outside).unwrap(), b"outside must survive");
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn relative_directory_symlink_kind_is_resolved_from_source_parent() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let source_parent = tmp.path().join("source");
        fs::create_dir(&source_parent).unwrap();
        fs::create_dir(source_parent.join("target-directory")).unwrap();
        let source_link = source_parent.join("relative-link");
        symlink("target-directory", &source_link).unwrap();

        assert_eq!(
            copied_symlink_kind(&source_link),
            CopiedSymlinkKind::Directory
        );
    }

    #[test]
    fn windows_symlink_kind_source_reads_the_source_reparse_type() {
        let source = include_str!("fs_ops.rs").replace('\r', "");
        let start = source
            .find("#[cfg(windows)]\nfn copied_symlink_kind")
            .expect("Windows symlink-kind branch");
        let end = source[start..]
            .find("#[cfg(unix)]\nfn symlink_to")
            .map(|offset| start + offset)
            .expect("end of Windows symlink-kind branch");
        let implementation = &source[start..end];

        assert!(implementation.contains("FileTypeExt"));
        assert!(implementation.contains("symlink_metadata(source_link)"));
        assert!(implementation.contains("is_symlink_dir()"));
        assert!(!implementation.contains("metadata(target)"));
    }

    #[test]
    fn windows_directory_symlink_removal_source_uses_remove_directory() {
        // Host-independent coverage for the Windows-only branch. Windows CI's
        // runtime test below verifies the actual filesystem behavior whenever
        // the runner permits creating symlinks.
        let source = include_str!("fs_ops.rs").replace('\r', "");
        let start = source
            .find("fn remove_entry(path: &Path)")
            .expect("remove-entry implementation");
        let end = source[start..]
            .find("#[cfg(unix)]\nfn symlink_to")
            .map(|offset| start + offset)
            .expect("end of remove-entry implementation");
        let implementation = &source[start..end];

        assert!(implementation.contains("FileTypeExt"));
        assert!(implementation.contains("is_symlink_dir()"));
        assert!(implementation.contains("std::fs::remove_dir(path)"));
    }

    #[cfg(windows)]
    #[test]
    fn remove_entry_deletes_a_directory_symlink_without_touching_its_target() {
        use std::os::windows::fs::symlink_dir;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let target = tmp.path().join("target");
        let link = tmp.path().join("directory-link");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("kept.txt"), b"must survive").unwrap();
        if let Err(error) = symlink_dir(&target, &link) {
            // Developer Mode or SeCreateSymbolicLinkPrivilege may be absent on
            // a Windows CI host; the source guard remains mandatory coverage.
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create directory symlink: {error}");
        }

        remove_entry(&link).expect("remove directory link entry");

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(target.join("kept.txt")).unwrap(), b"must survive");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_rejects_non_regular_special_files() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::Duration;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source.fifo");
        let destination = tmp.path().join("fifo-copy");
        let source_c = CString::new(source.as_os_str().as_bytes()).unwrap();
        // SAFETY: source_c is a valid NUL-terminated path and mkfifo retains no
        // pointer after it returns.
        assert_eq!(unsafe { libc::mkfifo(source_c.as_ptr(), 0o600) }, 0);

        let source_for_copy = source.clone();
        let destination_for_copy = destination.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let _ = tx.send(copy_recursive(&source_for_copy, &destination_for_copy));
        });

        let result = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                // Old behavior reached std::fs::copy and blocked opening the FIFO.
                // Open its writer to release that owned test thread, then fail with
                // direct evidence that the copy path was not bounded.
                let writer = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&source)
                    .unwrap();
                drop(writer);
                let _ = rx.recv_timeout(Duration::from_secs(2));
                let _ = handle.join();
                panic!("copying a FIFO blocked instead of rejecting its file type");
            }
            Err(RecvTimeoutError::Disconnected) => panic!("copy worker disconnected"),
        };
        handle.join().unwrap();

        let error =
            result.expect_err("copying a device as if it were a regular file must be rejected");

        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_rollback_removes_a_completed_read_only_directory() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source");
        let destination = tmp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("child.txt"), b"content").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o555)).unwrap();

        copy_recursive(&source, &destination).expect("complete directory copy");
        let completed = OwnedEntry::capture(destination.clone());
        rollback_copies(std::slice::from_ref(&completed));

        // Restore source permissions for TempDir cleanup.
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            !destination.exists(),
            "rollback must not leave a partial copy"
        );
    }

    #[test]
    fn copy_rollback_does_not_delete_a_concurrent_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let destination = tmp.path().join("copied.txt");
        fs::write(&destination, b"owned copy").unwrap();
        let completed = OwnedEntry::capture(destination.clone());

        fs::remove_file(&destination).unwrap();
        fs::write(&destination, b"concurrent replacement").unwrap();
        rollback_copies(std::slice::from_ref(&completed));

        assert_eq!(
            fs::read(&destination).unwrap(),
            b"concurrent replacement",
            "rollback must not delete an entry that no longer has our identity"
        );
    }

    #[test]
    fn copy_rollback_quarantines_before_a_new_destination_can_appear() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let destination = tmp.path().join("copied.txt");
        fs::write(&destination, b"owned copy").unwrap();
        let completed = OwnedEntry::capture(destination.clone());

        rollback_copies_with_hook(std::slice::from_ref(&completed), |owned, _quarantined| {
            // This is the old check/use window: rollback has atomically moved
            // its owned entry away, then a concurrent actor claims the original.
            fs::write(&owned.path, b"concurrent destination").unwrap();
        });

        assert_eq!(fs::read(&destination).unwrap(), b"concurrent destination");
    }

    #[test]
    fn copy_rollback_preserves_a_directory_with_a_concurrent_child() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let destination = tmp.path().join("copied-directory");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("owned.txt"), b"owned").unwrap();
        let completed = OwnedEntry::capture(destination.clone());

        fs::write(destination.join("concurrent.txt"), b"must survive").unwrap();
        rollback_copies(std::slice::from_ref(&completed));

        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"must survive"
        );
        assert_eq!(fs::read(destination.join("owned.txt")).unwrap(), b"owned");
    }

    #[cfg(unix)]
    #[test]
    fn large_tree_ownership_token_pins_only_the_root_descriptor() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().join("large-tree");
        fs::create_dir(&root).unwrap();
        for index in 0..1_024 {
            fs::write(root.join(format!("file-{index}")), b"x").unwrap();
        }

        let owned = OwnedEntry::try_capture(root).expect("capture large tree");
        let tree = owned.tree.as_ref().expect("complete ownership tree");

        assert_eq!(tree.len(), 1_025);
        assert!(tree[0].identity.is_pinned());
        assert!(tree[1..].iter().all(|node| !node.identity.is_pinned()));
    }

    #[test]
    fn copy_rollback_preserves_a_file_modified_in_place() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let destination = tmp.path().join("copied.txt");
        fs::write(&destination, b"owned").unwrap();
        let completed = OwnedEntry::capture(destination.clone());

        fs::write(&destination, b"concurrent longer content").unwrap();
        rollback_copies(std::slice::from_ref(&completed));

        assert_eq!(
            fs::read(&destination).unwrap(),
            b"concurrent longer content"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_rollback_removes_only_the_owned_symlink_entry() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let target = tmp.path().join("target.txt");
        let destination = tmp.path().join("copied-link");
        fs::write(&target, b"target must survive").unwrap();
        symlink(&target, &destination).unwrap();
        let completed = OwnedEntry::capture(destination.clone());
        assert!(
            completed.tree.is_some(),
            "supported Unix targets must capture symlink identity"
        );

        rollback_copies(std::slice::from_ref(&completed));

        assert!(fs::symlink_metadata(&destination).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target must survive");
    }

    #[test]
    fn move_rollback_does_not_relocate_a_concurrent_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source.txt");
        let destination = tmp.path().join("moved.txt");
        fs::write(&destination, b"owned move").unwrap();
        let completed = CompletedMove::capture(destination.clone(), source.clone());

        fs::remove_file(&destination).unwrap();
        fs::write(&destination, b"concurrent replacement").unwrap();
        rollback_moves(std::slice::from_ref(&completed));

        assert!(
            !source.exists(),
            "unowned entry must not be moved to source"
        );
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"concurrent replacement",
            "rollback must leave the concurrent destination in place"
        );
    }

    #[test]
    fn move_rollback_preserves_a_directory_with_a_concurrent_child() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let source = tmp.path().join("source-directory");
        let destination = tmp.path().join("moved-directory");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("owned.txt"), b"owned").unwrap();
        let completed = CompletedMove::capture(destination.clone(), source.clone());

        fs::write(destination.join("concurrent.txt"), b"must survive").unwrap();
        rollback_moves(std::slice::from_ref(&completed));

        assert!(!source.exists());
        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"must survive"
        );
    }

    #[test]
    fn failed_cross_device_cleanup_preserves_a_concurrent_file_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let destination = tmp.path().join("copied.txt");
        fs::write(&destination, b"owned copy").unwrap();
        let owned = OwnedEntry::capture(destination.clone());

        cleanup_failed_cross_device_destination(&owned, false, |path| {
            fs::remove_file(path).unwrap();
            fs::write(path, b"concurrent replacement").unwrap();
        });

        assert_eq!(fs::read(&destination).unwrap(), b"concurrent replacement");
    }

    #[cfg(unix)]
    #[test]
    fn trash_rejects_a_symlinked_internal_trash_root() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        let source = root.join("keep.txt");
        fs::write(&source, b"must stay in workspace").unwrap();
        symlink(outside.path(), root.join(LYCEUM_TRASH_DIR)).unwrap();

        move_paths_to_trash_impl(root, vec![source.to_string_lossy().to_string()])
            .expect_err("trash must reject a symlinked internal storage root");

        assert_eq!(fs::read(&source).unwrap(), b"must stay in workspace");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn trash_case_alias_is_hidden_and_protected_only_when_it_is_the_same_entry() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper = root.join(".LYCEUM-TRASH");
        let requested = root.join(LYCEUM_TRASH_DIR);
        let destination = root.join("destination");
        fs::create_dir(&upper).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(upper.join("kept.txt"), b"internal").unwrap();

        let aliases_reserved_name = path_entry_exists(&requested);
        let names: Vec<String> = read_dir_entries(root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        if aliases_reserved_name {
            assert!(!names.iter().any(|name| name == ".LYCEUM-TRASH"));
            assert!(path_starts_with_trash(root, &upper.join("kept.txt")));
            assert_eq!(
                ensure_safe_trash_root(root).unwrap().0.file_name(),
                upper.file_name()
            );
            assert!(
                move_paths_to_trash_impl(root, vec![upper.to_string_lossy().to_string()]).is_err()
            );
            assert!(move_paths_impl(
                root,
                vec![upper.to_string_lossy().to_string()],
                &destination,
            )
            .is_err());
            assert_eq!(fs::read(upper.join("kept.txt")).unwrap(), b"internal");
        } else {
            // On a case-sensitive filesystem the uppercase directory is a
            // legitimate distinct entry and must remain visible/unprotected.
            assert!(names.iter().any(|name| name == ".LYCEUM-TRASH"));
            assert!(!path_starts_with_trash(root, &upper.join("kept.txt")));
        }
    }

    #[test]
    fn nested_trash_named_directory_remains_visible_outside_workspace_root() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let nested_parent = root.join("subdirectory");
        let nested_trash_name = nested_parent.join(LYCEUM_TRASH_DIR);
        fs::create_dir(&nested_parent).unwrap();
        fs::create_dir(&nested_trash_name).unwrap();
        fs::create_dir(root.join(LYCEUM_TRASH_DIR)).unwrap();

        let root_names: Vec<String> = read_dir_entries_for_workspace(root, root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        let nested_names: Vec<String> = read_dir_entries_for_workspace(&nested_parent, root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        assert!(!root_names.iter().any(|name| name == LYCEUM_TRASH_DIR));
        assert!(nested_names.iter().any(|name| name == LYCEUM_TRASH_DIR));
        assert!(!path_starts_with_trash(root, &nested_trash_name));
    }

    #[cfg(unix)]
    #[test]
    fn explorer_hides_aliases_into_root_trash_at_every_depth() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let trash = root.join(LYCEUM_TRASH_DIR);
        let docs = root.join("docs");
        let nested_visible = docs.join(LYCEUM_TRASH_DIR);
        fs::create_dir(&trash).unwrap();
        fs::write(trash.join("deleted.txt"), b"deleted").unwrap();
        fs::create_dir(&docs).unwrap();
        fs::create_dir(&nested_visible).unwrap();
        symlink(LYCEUM_TRASH_DIR, root.join("trash-link")).unwrap();
        symlink(
            format!("../{LYCEUM_TRASH_DIR}/deleted.txt"),
            docs.join("deleted-link"),
        )
        .unwrap();

        let root_names: Vec<String> = read_dir_entries_for_workspace(root, root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        let docs_names: Vec<String> = read_dir_entries_for_workspace(&docs, root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        assert!(!root_names.iter().any(|name| name == "trash-link"));
        assert!(!docs_names.iter().any(|name| name == "deleted-link"));
        assert!(docs_names.iter().any(|name| name == LYCEUM_TRASH_DIR));
    }

    #[test]
    fn create_and_rename_reserve_only_the_root_trash_identity() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().canonicalize().unwrap();
        let root = root.as_path();
        let exact_file = root.join(LYCEUM_TRASH_DIR);
        let exact_directory = root.join(LYCEUM_TRASH_DIR);

        assert!(create_file_in_workspace_impl(root, &exact_file).is_err());
        assert!(create_directory_in_workspace_impl(root, &exact_directory).is_err());
        assert!(!exact_file.exists());

        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_reserved_name = nested.join(LYCEUM_TRASH_DIR);
        create_file_in_workspace_impl(root, &nested_reserved_name)
            .expect("nested trash name remains ordinary user content");
        assert!(nested_reserved_name.exists());

        let source = nested.join("rename-source.txt");
        fs::write(&source, b"source").unwrap();
        assert!(rename_path_in_workspace_impl(root, &source, &exact_file).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
    }

    #[test]
    fn absent_trash_case_alias_create_and_rename_follow_directory_semantics() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().canonicalize().unwrap();
        let root = root.as_path();
        let alias = root.join(".LYCEUM-TRASH");
        let aliases_reserved = path_would_be_workspace_trash(root, &alias).unwrap();

        let create_result = create_file_in_workspace_impl(root, &alias);
        if aliases_reserved {
            assert!(create_result.is_err());
            assert!(!alias.exists());
        } else {
            create_result.expect("distinct uppercase name is valid on a sensitive directory");
            fs::remove_file(&alias).unwrap();
        }

        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        let source = nested.join("source.txt");
        fs::write(&source, b"source").unwrap();
        let rename_result = rename_path_in_workspace_impl(root, &source, &alias);
        if aliases_reserved {
            assert!(rename_result.is_err());
            assert_eq!(fs::read(&source).unwrap(), b"source");
        } else {
            rename_result.expect("distinct uppercase name is valid on a sensitive directory");
            assert_eq!(fs::read(&alias).unwrap(), b"source");
        }
    }

    #[test]
    fn copy_and_move_reject_an_absent_root_trash_case_alias_before_publish() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create outside dir");
        let external = outside.path().join(".LYCEUM-TRASH");
        fs::write(&external, b"external").unwrap();
        let alias = root.join(".LYCEUM-TRASH");
        let aliases_reserved = path_would_be_workspace_trash(root, &alias).unwrap();

        let copy_result = copy_paths_impl(root, vec![external.to_string_lossy().to_string()], root);
        if aliases_reserved {
            assert!(copy_result.is_err());
            assert!(!alias.exists());
            assert_eq!(fs::read(&external).unwrap(), b"external");
        } else {
            copy_result.expect("distinct uppercase copy is valid on a sensitive directory");
            assert_eq!(fs::read(&alias).unwrap(), b"external");
            fs::remove_file(&alias).unwrap();
        }

        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        let moved_source = nested.join(".LYCEUM-TRASH");
        fs::write(&moved_source, b"moved").unwrap();
        let move_result =
            move_paths_impl(root, vec![moved_source.to_string_lossy().to_string()], root);
        if aliases_reserved {
            assert!(move_result.is_err());
            assert_eq!(fs::read(&moved_source).unwrap(), b"moved");
            assert!(!alias.exists());
        } else {
            move_result.expect("distinct uppercase move is valid on a sensitive directory");
            assert_eq!(fs::read(&alias).unwrap(), b"moved");
        }
    }

    #[test]
    fn errors_on_non_directory() {
        let result = read_dir_entries(Path::new("/this/path/should/not/exist/lyceum"));
        assert!(result.is_err());
    }

    #[test]
    fn lists_entries_directories_first_then_alphabetical() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join("zeta_dir")).unwrap();
        fs::create_dir(root.join("Alpha_dir")).unwrap();
        fs::write(root.join("b_file.txt"), b"b").unwrap();
        fs::write(root.join("A_file.txt"), b"a").unwrap();

        let entries = read_dir_entries(root).expect("read dir");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories (case-insensitive sorted) first, then files.
        assert_eq!(
            names,
            vec!["Alpha_dir", "zeta_dir", "A_file.txt", "b_file.txt"]
        );

        let dirs: Vec<bool> = entries.iter().map(|e| e.is_dir).collect();
        assert_eq!(dirs, vec![true, true, false, false]);
    }

    #[test]
    fn entry_paths_are_absolute_children_of_root() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::write(root.join("note.md"), b"x").unwrap();

        let entries = read_dir_entries(root).expect("read dir");
        let entry = entries.iter().find(|e| e.name == "note.md").unwrap();
        assert!(entry.path.ends_with("note.md"));
        assert!(Path::new(&entry.path).is_absolute());
        assert!(!entry.is_dir);
    }

    #[test]
    fn empty_directory_yields_no_entries() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let entries = read_dir_entries(tmp.path()).expect("read dir");
        assert!(entries.is_empty());
    }

    #[test]
    fn lyceum_trash_directory_is_hidden_from_listings() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        fs::create_dir(root.join(LYCEUM_TRASH_DIR)).unwrap();
        fs::write(root.join("visible.txt"), b"x").unwrap();

        let entries = read_dir_entries(root).expect("read dir");

        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["visible.txt"]);
    }

    #[test]
    fn create_file_creates_empty_file_and_errors_when_exists() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("nested").join("new.txt");
        let path_str = path.to_string_lossy().to_string();

        create_file_impl(&path).expect("create file");
        assert!(path.is_file());
        assert_eq!(fs::read(&path).unwrap().len(), 0);

        let result = create_file_impl(Path::new(&path_str));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[test]
    fn create_directory_makes_nested_dirs() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let path = tmp.path().join("a").join("b").join("c");

        create_directory_impl(&path).expect("create directory");
        assert!(path.is_dir());
    }

    #[test]
    fn rename_path_moves_file_and_errors_if_destination_exists() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let from = tmp.path().join("from.txt");
        let to = tmp.path().join("to.txt");
        fs::write(&from, b"hello").unwrap();

        rename_path_impl(&from, &to).expect("rename file");
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"hello");

        let other = tmp.path().join("other.txt");
        fs::write(&other, b"x").unwrap();
        let result = rename_path_impl(&other, &to);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[cfg(unix)]
    #[test]
    fn rename_path_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let from = tmp.path().join("from.txt");
        let to = tmp.path().join("broken-link.txt");
        fs::write(&from, b"hello").unwrap();
        symlink(tmp.path().join("missing.txt"), &to).unwrap();
        assert!(!to.exists());

        let result = rename_path_impl(&from, &to);

        assert!(result.unwrap_err().contains("already exists"));
        assert_eq!(fs::read(&from).unwrap(), b"hello");
        assert!(std::fs::symlink_metadata(&to)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn create_directory_errors_when_directory_already_exists() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let dir = tmp.path().join("src");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("existing.txt"), b"x").unwrap();

        let result = create_directory_impl(&dir);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
        // The pre-existing directory and its contents are untouched.
        assert!(dir.join("existing.txt").is_file());
    }

    #[test]
    fn rename_path_supports_case_only_rename() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().canonicalize().unwrap();
        let dir = root.as_path();
        let from = dir.join("Readme.md");
        let to = dir.join("readme.md");
        fs::write(&from, b"data").unwrap();

        rename_path_in_workspace_impl(dir, &from, &to)
            .expect("root-aware case-only rename should succeed");

        // The on-disk entry now carries the new case (verified via the directory
        // listing, which is reliable on both case-sensitive and -insensitive FS).
        let names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"readme.md".to_string()), "names: {names:?}");
        assert!(
            !names.contains(&"Readme.md".to_string()),
            "names: {names:?}"
        );
        assert_eq!(fs::read(&to).unwrap(), b"data");
        // No temp file was stranded.
        assert!(!names.iter().any(|n| n.contains("lyceum-case-rename")));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_mutations_reject_root_trash_reached_through_a_parent_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().canonicalize().unwrap();
        let root = root.as_path();
        let alias = root.join("alias");
        symlink(root, &alias).unwrap();
        let hidden_target = alias.join(LYCEUM_TRASH_DIR);

        assert!(create_file_in_workspace_impl(root, &hidden_target).is_err());
        assert!(create_directory_in_workspace_impl(root, &hidden_target).is_err());
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());

        let source = root.join("source.txt");
        fs::write(&source, b"source").unwrap();
        assert!(rename_path_in_workspace_impl(root, &source, &hidden_target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_is_listed_as_a_directory() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let real = root.join("real-dir");
        fs::create_dir(&real).unwrap();
        symlink(&real, root.join("link-dir")).unwrap();
        // A broken symlink must still be listed, as a file.
        symlink(root.join("missing"), root.join("broken-link")).unwrap();

        let entries = read_dir_entries(root).expect("read dir");

        let link = entries.iter().find(|e| e.name == "link-dir").unwrap();
        assert!(link.is_dir, "symlinked dir must resolve to a directory");
        let broken = entries.iter().find(|e| e.name == "broken-link").unwrap();
        assert!(!broken.is_dir);
    }

    #[test]
    fn move_restore_and_redo_trash_batch_round_trips_files_and_directories() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let file = root.join("note.txt");
        let dir = root.join("folder");
        fs::write(&file, b"note").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("leaf.txt"), b"leaf").unwrap();

        let batch = move_paths_to_trash_impl(
            root,
            vec![
                file.to_string_lossy().to_string(),
                dir.to_string_lossy().to_string(),
            ],
        )
        .expect("move to trash");

        assert_eq!(batch.items.len(), 2);
        assert!(!file.exists());
        assert!(!dir.exists());
        for item in &batch.items {
            assert!(Path::new(&item.trashed_path).exists());
        }

        restore_trash_batch_impl(root, batch.items.clone()).expect("restore");
        assert_eq!(fs::read(&file).unwrap(), b"note");
        assert_eq!(fs::read(dir.join("sub").join("leaf.txt")).unwrap(), b"leaf");

        redo_trash_batch_impl(root, batch.items.clone()).expect("redo");
        assert!(!file.exists());
        assert!(!dir.exists());
        for item in &batch.items {
            assert!(Path::new(&item.trashed_path).exists());
        }
    }

    #[test]
    fn move_to_trash_deduplicates_nested_selections() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dir = root.join("folder");
        let leaf = dir.join("leaf.txt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&leaf, b"leaf").unwrap();

        let batch = move_paths_to_trash_impl(
            root,
            vec![
                dir.to_string_lossy().to_string(),
                leaf.to_string_lossy().to_string(),
            ],
        )
        .expect("move to trash");

        assert_eq!(batch.items.len(), 1);
        assert_eq!(Path::new(&batch.items[0].original_path), dir.as_path());
    }

    #[test]
    fn move_to_trash_rejects_root_and_outside_paths() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::NamedTempFile::new().expect("outside file");

        let root_result = move_paths_to_trash_impl(root, vec![root.to_string_lossy().to_string()]);
        assert!(root_result.unwrap_err().contains("workspace root"));

        let outside_result =
            move_paths_to_trash_impl(root, vec![outside.path().to_string_lossy().to_string()]);
        assert!(outside_result.unwrap_err().contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn move_to_trash_moves_symlink_itself_not_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let target = root.join("target.txt");
        let link = root.join("shortcut.txt");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();
        let expected_original = root.join("shortcut.txt");

        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash symlink entry");

        assert_eq!(batch.items.len(), 1);
        assert_eq!(
            Path::new(&batch.items[0].original_path),
            expected_original.as_path()
        );
        assert!(!batch.items[0].is_dir);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn move_to_trash_allows_workspace_symlink_to_outside_without_touching_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        let root = tmp.path();
        let link = root.join("outside-shortcut.txt");
        fs::write(outside.path(), b"outside").unwrap();
        symlink(outside.path(), &link).unwrap();

        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash external symlink entry");

        assert_eq!(batch.items.len(), 1);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(outside.path()).unwrap(), b"outside");
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_moves_files_into_destination_directory() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let src = root.join("note.txt");
        let dst = root.join("folder");
        fs::write(&src, b"note").unwrap();
        fs::create_dir(&dst).unwrap();
        let expected_from = src.to_string_lossy().to_string();
        let expected_to = dst.join("note.txt").to_string_lossy().to_string();

        let moved = move_paths_impl(root, vec![src.to_string_lossy().to_string()], &dst)
            .expect("move file");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert_eq!(moved[0].to, expected_to);
        assert!(!src.exists());
        assert_eq!(fs::read(dst.join("note.txt")).unwrap(), b"note");
    }

    #[test]
    fn move_paths_replaces_files_and_directories_as_one_batch() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let destination = root.join("destination");
        let source_file = root.join("note.txt");
        let source_dir = root.join("folder");
        fs::create_dir(&destination).unwrap();
        fs::write(&source_file, b"new note").unwrap();
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("new-only.txt"), b"new directory").unwrap();
        fs::write(destination.join("note.txt"), b"old note").unwrap();
        fs::create_dir(destination.join("folder")).unwrap();
        fs::write(destination.join("folder/old-only.txt"), b"old directory").unwrap();
        let expected_conflicts = vec![
            destination.join("note.txt").to_string_lossy().to_string(),
            destination.join("folder").to_string_lossy().to_string(),
        ];

        let moved = move_paths_impl_with_replace(
            root,
            vec![
                source_file.to_string_lossy().to_string(),
                source_dir.to_string_lossy().to_string(),
            ],
            &destination,
            true,
            Some(&expected_conflicts),
        )
        .expect("replace move batch");

        assert_eq!(moved.len(), 2);
        assert!(moved.iter().all(|item| item.replaced));
        assert!(!source_file.exists());
        assert!(!source_dir.exists());
        assert_eq!(fs::read(destination.join("note.txt")).unwrap(), b"new note");
        assert_eq!(
            fs::read(destination.join("folder/new-only.txt")).unwrap(),
            b"new directory"
        );
        assert!(!destination.join("folder/old-only.txt").exists());
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn move_paths_rejects_a_source_nested_in_a_replaced_destination() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let incoming_parent = root.join("incoming");
        let incoming_dir = incoming_parent.join("container");
        let existing_dir = root.join("container");
        let nested_source = existing_dir.join("old.txt");
        fs::create_dir_all(&incoming_dir).unwrap();
        fs::write(incoming_dir.join("new.txt"), b"NEW").unwrap();
        fs::create_dir(&existing_dir).unwrap();
        fs::write(&nested_source, b"OLD").unwrap();

        let error = move_paths_impl(
            root,
            vec![
                incoming_dir.to_string_lossy().to_string(),
                nested_source.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("nested source must not be staged inside its destination");

        assert!(error.contains("source is inside"), "{error}");
        assert_eq!(fs::read(&nested_source).unwrap(), b"OLD");
        assert_eq!(fs::read(incoming_dir.join("new.txt")).unwrap(), b"NEW");
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn copy_paths_imports_external_files_and_keeps_the_source() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("folder");
        fs::create_dir(&dst).unwrap();
        // Source lives OUTSIDE the workspace, like a file dropped from Finder.
        let outside = tempfile::tempdir().expect("create temp dir");
        let src = outside.path().join("note.txt");
        fs::write(&src, b"note").unwrap();

        let copied = copy_paths_impl(root, vec![src.to_string_lossy().to_string()], &dst)
            .expect("copy file");

        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0].to, dst.join("note.txt").to_string_lossy());
        assert_eq!(fs::read(dst.join("note.txt")).unwrap(), b"note");
        assert!(src.exists(), "source must be left untouched");
    }

    #[cfg(unix)]
    #[test]
    fn copy_paths_preserves_workspace_symlink_entries() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("folder");
        let target = root.join("target.txt");
        let link = root.join("shortcut.txt");
        fs::create_dir(&dst).unwrap();
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();

        let copied = copy_paths_impl(root, vec![link.to_string_lossy().to_string()], &dst)
            .expect("copy symlink entry");

        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0].from, link.to_string_lossy().to_string());
        assert_eq!(copied[0].to, dst.join("shortcut.txt").to_string_lossy());
        assert!(std::fs::symlink_metadata(dst.join("shortcut.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn copy_paths_preserves_external_symlink_entries() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("folder");
        fs::create_dir(&dst).unwrap();
        let outside = tempfile::tempdir().expect("create temp dir");
        let target = outside.path().join("target.txt");
        let link = outside.path().join("shortcut.txt");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();

        let copied = copy_paths_impl(root, vec![link.to_string_lossy().to_string()], &dst)
            .expect("copy external symlink entry");

        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0].from, link.to_string_lossy().to_string());
        assert_eq!(copied[0].to, dst.join("shortcut.txt").to_string_lossy());
        assert!(std::fs::symlink_metadata(dst.join("shortcut.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn copy_paths_rejects_collision_and_rolls_back_the_batch() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create temp dir");
        let good = outside.path().join("fresh.txt");
        let clash = outside.path().join("taken.txt");
        fs::write(&good, b"good").unwrap();
        fs::write(&clash, b"new").unwrap();
        // A file named `taken.txt` already exists at the destination.
        fs::write(root.join("taken.txt"), b"old").unwrap();

        let err = copy_paths_impl(
            root,
            vec![
                good.to_string_lossy().to_string(),
                clash.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("collision must fail the whole import");
        assert!(err.contains("already exists"), "{err}");
        // Pre-collision check rejects before copying, so nothing strays in.
        assert!(!root.join("fresh.txt").exists(), "batch must roll back");
        assert_eq!(fs::read(root.join("taken.txt")).unwrap(), b"old");
    }

    #[test]
    fn copy_paths_reports_every_existing_destination_without_mutating() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let first = outside.path().join("first.txt");
        let second = outside.path().join("second.txt");
        fs::write(&first, b"new first").unwrap();
        fs::write(&second, b"new second").unwrap();
        fs::write(root.join("first.txt"), b"old first").unwrap();
        fs::write(root.join("second.txt"), b"old second").unwrap();

        let error = copy_paths_impl(
            root,
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("both conflicts must be reported before copying");
        let encoded = error
            .strip_prefix("destination conflict: already exists: ")
            .expect("structured conflict prefix");
        let conflicts: Vec<String> = serde_json::from_str(encoded).expect("conflict paths JSON");

        assert_eq!(
            conflicts,
            vec![
                root.join("first.txt").to_string_lossy().to_string(),
                root.join("second.txt").to_string_lossy().to_string(),
            ]
        );
        assert_eq!(fs::read(root.join("first.txt")).unwrap(), b"old first");
        assert_eq!(fs::read(root.join("second.txt")).unwrap(), b"old second");
        assert_eq!(fs::read(&first).unwrap(), b"new first");
        assert_eq!(fs::read(&second).unwrap(), b"new second");
    }

    #[test]
    fn replace_copy_rejects_a_stale_approved_conflict_set_without_mutating() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let first = outside.path().join("first.txt");
        let appeared_later = outside.path().join("appeared-later.txt");
        fs::write(&first, b"new first").unwrap();
        fs::write(&appeared_later, b"new later").unwrap();
        fs::write(root.join("first.txt"), b"old first").unwrap();
        // Simulates a destination created after the frontend approved only the
        // first preflight conflict but before its overwrite retry arrived.
        fs::write(root.join("appeared-later.txt"), b"unapproved later").unwrap();
        let stale_approval = vec![root.join("first.txt").to_string_lossy().to_string()];

        let error = copy_paths_impl_with_replace(
            root,
            vec![
                first.to_string_lossy().to_string(),
                appeared_later.to_string_lossy().to_string(),
            ],
            root,
            true,
            Some(&stale_approval),
        )
        .expect_err("changed conflict set must require fresh approval");
        let encoded = error
            .strip_prefix("destination conflict: already exists: ")
            .expect("fresh structured conflict");
        let conflicts: Vec<String> = serde_json::from_str(encoded).unwrap();

        assert_eq!(conflicts.len(), 2);
        assert!(conflicts
            .iter()
            .any(|path| path.ends_with("appeared-later.txt")));
        assert_eq!(fs::read(root.join("first.txt")).unwrap(), b"old first");
        assert_eq!(
            fs::read(root.join("appeared-later.txt")).unwrap(),
            b"unapproved later"
        );
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn copy_paths_rejects_a_source_nested_in_a_replaced_destination() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let incoming_dir = outside.path().join("container");
        let existing_dir = root.join("container");
        let nested_source = existing_dir.join("old.txt");
        fs::create_dir(&incoming_dir).unwrap();
        fs::write(incoming_dir.join("new.txt"), b"NEW").unwrap();
        fs::create_dir(&existing_dir).unwrap();
        fs::write(&nested_source, b"OLD").unwrap();

        let error = copy_paths_impl(
            root,
            vec![
                incoming_dir.to_string_lossy().to_string(),
                nested_source.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("nested source must not be staged inside its destination");

        assert!(error.contains("source is inside"), "{error}");
        assert_eq!(fs::read(&nested_source).unwrap(), b"OLD");
        assert_eq!(fs::read(incoming_dir.join("new.txt")).unwrap(), b"NEW");
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn copy_paths_rejects_case_folded_nested_source_before_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let probe = root.join("LyceumCaseProbe");
        fs::write(&probe, b"probe").unwrap();
        let case_insensitive = path_entry_exists(&root.join("lyceumcaseprobe"));
        fs::remove_file(&probe).unwrap();
        if !case_insensitive {
            return;
        }

        let outside = tempfile::tempdir().expect("create external dir");
        let incoming_dir = outside.path().join("Container");
        let existing_dir = root.join("container");
        let nested_source = existing_dir.join("old.txt");
        fs::create_dir(&incoming_dir).unwrap();
        fs::write(incoming_dir.join("old.txt"), b"NEW").unwrap();
        fs::create_dir(&existing_dir).unwrap();
        fs::write(&nested_source, b"OLD").unwrap();
        let expected_conflicts = vec![existing_dir.to_string_lossy().to_string()];

        let error = copy_paths_impl_with_replace(
            root,
            vec![
                incoming_dir.to_string_lossy().to_string(),
                nested_source.to_string_lossy().to_string(),
            ],
            root,
            true,
            Some(&expected_conflicts),
        )
        .expect_err("case-folded nested source must be rejected before staging");

        assert!(error.contains("source is inside"), "{error}");
        assert_eq!(fs::read(&nested_source).unwrap(), b"OLD");
        assert_eq!(fs::read(incoming_dir.join("old.txt")).unwrap(), b"NEW");
        assert!(!root.join("old.txt").exists());
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn replacement_rollback_does_not_move_a_concurrent_backup_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let incoming = root.join("incoming.txt");
        let destination = root.join("destination.txt");
        fs::write(&incoming, b"incoming").unwrap();
        fs::write(&destination, b"original").unwrap();
        let planned = vec![(incoming, destination.clone(), false, true)];
        let stage = stage_existing_destinations(root, &planned)
            .unwrap()
            .expect("replacement stage");
        let backup = stage.backups[0].backup.clone();

        fs::remove_file(&backup).unwrap();
        fs::write(&backup, b"concurrent backup replacement").unwrap();
        rollback_replacement_stage(Some(&stage));

        assert!(!destination.exists());
        assert_eq!(fs::read(&backup).unwrap(), b"concurrent backup replacement");
    }

    #[test]
    fn replacement_discard_preserves_a_concurrently_changed_backup() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let incoming = root.join("incoming.txt");
        let destination = root.join("destination.txt");
        fs::write(&incoming, b"incoming").unwrap();
        fs::write(&destination, b"original").unwrap();
        let planned = vec![(incoming, destination, false, true)];
        let stage = stage_existing_destinations(root, &planned)
            .unwrap()
            .expect("replacement stage");
        let backup = stage.backups[0].backup.clone();

        fs::write(&backup, b"concurrent longer backup contents").unwrap();
        let error = discard_replacement_stage(Some(&stage))
            .expect_err("changed backup must remain recoverable");

        assert!(error.contains("old items remain"));
        assert_eq!(
            fs::read(&backup).unwrap(),
            b"concurrent longer backup contents"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_paths_rejects_nested_source_reached_through_symlinked_parent() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let incoming_dir = outside.path().join("container");
        let existing_dir = root.join("container");
        let alias = outside.path().join("alias");
        fs::create_dir(&incoming_dir).unwrap();
        fs::write(incoming_dir.join("new.txt"), b"NEW").unwrap();
        fs::create_dir(&existing_dir).unwrap();
        fs::write(existing_dir.join("old.txt"), b"OLD").unwrap();
        symlink(&existing_dir, &alias).unwrap();
        let aliased_source = alias.join("old.txt");

        let error = copy_paths_impl(
            root,
            vec![
                incoming_dir.to_string_lossy().to_string(),
                aliased_source.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("canonical parent must expose the nested-source dependency");

        assert!(error.contains("source is inside"), "{error}");
        assert_eq!(fs::read(existing_dir.join("old.txt")).unwrap(), b"OLD");
        assert_eq!(fs::read(incoming_dir.join("new.txt")).unwrap(), b"NEW");
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_rejects_self_descendant_reached_through_a_symlinked_ancestor_before_staging() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().join("workspace");
        let source = root.join("source");
        let destination = source.join("nested");
        fs::create_dir_all(&destination).unwrap();
        let alias_parent = tmp.path().join("workspace-alias");
        symlink(&root, &alias_parent).unwrap();
        let aliased_source = alias_parent.join("source");

        let error = copy_paths_impl(
            &root,
            vec![aliased_source.to_string_lossy().to_string()],
            &destination,
        )
        .expect_err("canonical directory ancestry must reject the recursive copy");

        assert!(error.contains("into itself"), "{error}");
        assert!(fs::read_dir(&destination).unwrap().next().is_none());
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn copy_rejects_a_case_aliased_self_descendant_before_staging() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let source = root.join("SourceDirectory");
        let destination = source.join("nested");
        fs::create_dir_all(&destination).unwrap();
        let aliased_source = root.join("sourcedirectory");
        if !path_entry_exists(&aliased_source) {
            return;
        }

        let error = copy_paths_impl(
            root,
            vec![aliased_source.to_string_lossy().to_string()],
            &destination,
        )
        .expect_err("case-aliased directory ancestry must reject the recursive copy");

        assert!(error.contains("into itself"), "{error}");
        assert!(fs::read_dir(&destination).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn copy_into_a_symlink_target_descendant_still_copies_the_final_link_entry() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().join("workspace");
        let target = root.join("target");
        let destination = target.join("nested");
        fs::create_dir_all(&destination).unwrap();
        let link = tmp.path().join("target-link");
        symlink(&target, &link).unwrap();

        let copied = copy_paths_impl(
            &root,
            vec![link.to_string_lossy().to_string()],
            &destination,
        )
        .expect("the final symlink entry is copied without traversing its target");

        assert_eq!(copied.len(), 1);
        assert!(fs::symlink_metadata(destination.join("target-link"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn copy_paths_replaces_files_and_directories_and_keeps_sources() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let source_file = outside.path().join("note.txt");
        let source_dir = outside.path().join("folder");
        fs::write(&source_file, b"new note").unwrap();
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("new-only.txt"), b"new directory").unwrap();
        fs::write(root.join("note.txt"), b"old note").unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("folder/old-only.txt"), b"old directory").unwrap();
        let expected_conflicts = vec![
            root.join("note.txt").to_string_lossy().to_string(),
            root.join("folder").to_string_lossy().to_string(),
        ];

        let copied = copy_paths_impl_with_replace(
            root,
            vec![
                source_file.to_string_lossy().to_string(),
                source_dir.to_string_lossy().to_string(),
            ],
            root,
            true,
            Some(&expected_conflicts),
        )
        .expect("replace copy batch");

        assert_eq!(copied.len(), 2);
        assert!(copied.iter().all(|item| item.replaced));
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"new note");
        assert_eq!(
            fs::read(root.join("folder/new-only.txt")).unwrap(),
            b"new directory"
        );
        assert!(!root.join("folder/old-only.txt").exists());
        assert_eq!(fs::read(&source_file).unwrap(), b"new note");
        assert!(source_dir.join("new-only.txt").exists());
        assert!(
            !root.join(LYCEUM_TRASH_DIR).exists(),
            "successful replacement must clean its staging directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replace_copy_cleans_up_a_read_only_directory_backup() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let source = outside.path().join("locked");
        let destination = root.join("locked");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("new.txt"), b"NEW").unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old.txt"), b"OLD").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o555)).unwrap();
        let expected_conflicts = vec![destination.to_string_lossy().to_string()];

        let copied = copy_paths_impl_with_replace(
            root,
            vec![source.to_string_lossy().to_string()],
            root,
            true,
            Some(&expected_conflicts),
        )
        .expect("replace read-only directory");

        assert_eq!(fs::read(destination.join("new.txt")).unwrap(), b"NEW");
        assert!(!destination.join("old.txt").exists());
        assert!(copied.iter().all(|item| item.cleanup_warning.is_none()));
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[test]
    fn copy_paths_rejects_replacing_a_source_with_itself() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let source = root.join("note.txt");
        fs::write(&source, b"must survive").unwrap();

        let error = copy_paths_impl_with_replace(
            root,
            vec![source.to_string_lossy().to_string()],
            root,
            true,
            None,
        )
        .expect_err("same-entry copy must be rejected before staging");

        assert!(error.contains("same filesystem entry"), "{error}");
        assert_eq!(fs::read(&source).unwrap(), b"must survive");
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_replace_copy_restores_every_existing_destination() {
        use std::os::unix::fs::FileTypeExt;
        use std::os::unix::net::UnixListener;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let good = outside.path().join("good.txt");
        let unsupported = outside.path().join("unsupported.sock");
        fs::write(&good, b"new good").unwrap();
        let _socket = UnixListener::bind(&unsupported).expect("create unix socket");
        fs::write(root.join("good.txt"), b"old good").unwrap();
        fs::write(root.join("unsupported.sock"), b"old socket-named file").unwrap();
        let expected_conflicts = vec![
            root.join("good.txt").to_string_lossy().to_string(),
            root.join("unsupported.sock").to_string_lossy().to_string(),
        ];

        copy_paths_impl_with_replace(
            root,
            vec![
                good.to_string_lossy().to_string(),
                unsupported.to_string_lossy().to_string(),
            ],
            root,
            true,
            Some(&expected_conflicts),
        )
        .expect_err("copying a Unix socket must fail and roll back");

        assert_eq!(fs::read(root.join("good.txt")).unwrap(), b"old good");
        assert_eq!(
            fs::read(root.join("unsupported.sock")).unwrap(),
            b"old socket-named file"
        );
        assert_eq!(fs::read(&good).unwrap(), b"new good");
        assert!(std::fs::symlink_metadata(&unsupported)
            .unwrap()
            .file_type()
            .is_socket());
        assert!(!root.join(LYCEUM_TRASH_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn replace_copy_can_replace_a_broken_symlink_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("create external dir");
        let source = outside.path().join("shortcut.txt");
        let destination = root.join("shortcut.txt");
        let missing_target = root.join("missing.txt");
        fs::write(&source, b"replacement").unwrap();
        symlink(&missing_target, &destination).unwrap();
        assert!(!destination.exists());
        let expected_conflicts = vec![destination.to_string_lossy().to_string()];

        let copied = copy_paths_impl_with_replace(
            root,
            vec![source.to_string_lossy().to_string()],
            root,
            true,
            Some(&expected_conflicts),
        )
        .expect("replace broken symlink entry");

        assert_eq!(copied.len(), 1);
        assert!(copied[0].replaced);
        assert_eq!(
            copied[0].replaced_path.as_deref(),
            Some(destination.to_string_lossy().as_ref())
        );
        assert_eq!(fs::read(&destination).unwrap(), b"replacement");
        assert!(!missing_target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_paths_reports_requested_symlink_workspace_paths() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let real_root = tmp.path().join("real");
        let linked_root = tmp.path().join("linked");
        fs::create_dir(&real_root).unwrap();
        symlink(&real_root, &linked_root).unwrap();
        fs::write(real_root.join("note.txt"), b"note").unwrap();
        fs::create_dir(real_root.join("folder")).unwrap();

        let src = linked_root.join("note.txt");
        let dst = linked_root.join("folder");
        let moved = move_paths_impl(&linked_root, vec![src.to_string_lossy().to_string()], &dst)
            .expect("move through linked root");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, src.to_string_lossy().to_string());
        assert_eq!(
            moved[0].to,
            dst.join("note.txt").to_string_lossy().to_string()
        );
        assert!(!src.exists());
        assert_eq!(
            fs::read(real_root.join("folder/note.txt")).unwrap(),
            b"note"
        );
    }

    #[cfg(unix)]
    #[test]
    fn trash_batch_reports_requested_symlink_workspace_paths_and_restores() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let real_root = tmp.path().join("real");
        let linked_root = tmp.path().join("linked");
        fs::create_dir(&real_root).unwrap();
        symlink(&real_root, &linked_root).unwrap();
        fs::write(real_root.join("note.txt"), b"note").unwrap();

        let src = linked_root.join("note.txt");
        let batch = move_paths_to_trash_impl(&linked_root, vec![src.to_string_lossy().to_string()])
            .expect("trash through linked root");

        assert_eq!(batch.items.len(), 1);
        assert_eq!(batch.items[0].original_path, src.to_string_lossy());
        assert!(batch.items[0]
            .trashed_path
            .starts_with(&linked_root.to_string_lossy().to_string()));
        assert!(!src.exists());

        restore_trash_batch_impl(&linked_root, batch.items.clone())
            .expect("restore through linked root");
        assert_eq!(fs::read(real_root.join("note.txt")).unwrap(), b"note");

        redo_trash_batch_impl(&linked_root, batch.items).expect("redo through linked root");
        assert!(!src.exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_paths_moves_symlink_itself_not_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let target = root.join("target.txt");
        let link = root.join("shortcut.txt");
        let dst = root.join("folder");
        fs::write(&target, b"target").unwrap();
        fs::create_dir(&dst).unwrap();
        symlink(&target, &link).unwrap();
        let expected_from = link.to_string_lossy().to_string();
        let expected_to = dst.join("shortcut.txt").to_string_lossy().to_string();

        let moved = move_paths_impl(root, vec![link.to_string_lossy().to_string()], &dst)
            .expect("move symlink entry");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert_eq!(moved[0].to, expected_to);
        assert!(!moved[0].is_dir);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert!(std::fs::symlink_metadata(dst.join("shortcut.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_deduplicates_nested_selections_and_skips_same_parent() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let dir = root.join("src");
        let leaf = dir.join("leaf.txt");
        let already_there = dst.join("already.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(&leaf, b"leaf").unwrap();
        fs::write(&already_there, b"same parent").unwrap();
        let expected_from = dir.to_string_lossy().to_string();

        let moved = move_paths_impl(
            root,
            vec![
                dir.to_string_lossy().to_string(),
                leaf.to_string_lossy().to_string(),
                already_there.to_string_lossy().to_string(),
            ],
            &dst,
        )
        .expect("move top-level selection");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].from, expected_from);
        assert!(dst.join("src/leaf.txt").is_file());
    }

    #[test]
    fn move_paths_rejects_overwrite_and_duplicate_destinations() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let a = root.join("a").join("note.txt");
        let b = root.join("b").join("note.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let duplicate_err = move_paths_impl(
            root,
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
            &dst,
        )
        .unwrap_err();
        assert!(duplicate_err.contains("multiple moved items"));

        fs::write(dst.join("note.txt"), b"existing").unwrap();
        let exists_err =
            move_paths_impl(root, vec![a.to_string_lossy().to_string()], &dst).unwrap_err();
        assert!(exists_err.contains("already exists"));
    }

    fn collect_file_contents(dir: &Path, out: &mut Vec<Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect_file_contents(&path, out);
            } else {
                out.push(fs::read(&path).unwrap());
            }
        }
    }

    #[test]
    fn move_paths_does_not_silently_overwrite_case_colliding_destinations() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let a = root.join("a").join("Report.txt");
        let b = root.join("b").join("report.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"AAA").unwrap();
        fs::write(&b, b"BBB").unwrap();

        // Two files from different folders whose names differ ONLY in case, moved
        // into the same destination. On a case-insensitive FS (macOS/Windows) they
        // collide on disk and the move must reject + roll back rather than silently
        // overwrite one; on a case-sensitive FS both move fine. EITHER way, NEITHER
        // file's contents may be lost — both "AAA" and "BBB" must survive somewhere.
        let _ = move_paths_impl(
            root,
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
            &dst,
        );

        let mut contents = Vec::new();
        collect_file_contents(root, &mut contents);
        assert!(contents.iter().any(|c| c == b"AAA"), "content AAA was lost");
        assert!(contents.iter().any(|c| c == b"BBB"), "content BBB was lost");
    }

    #[test]
    fn copy_paths_reports_case_folded_batch_collision_as_non_replaceable() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let probe = root.join("LyceumCaseProbe");
        fs::write(&probe, b"probe").unwrap();
        let case_insensitive = path_entry_exists(&root.join("lyceumcaseprobe"));
        fs::remove_file(&probe).unwrap();
        if !case_insensitive {
            return;
        }

        let outside = tempfile::tempdir().expect("create external dir");
        let first_parent = outside.path().join("first");
        let second_parent = outside.path().join("second");
        fs::create_dir(&first_parent).unwrap();
        fs::create_dir(&second_parent).unwrap();
        let first = first_parent.join("Report.txt");
        let second = second_parent.join("report.txt");
        fs::write(&first, b"FIRST").unwrap();
        fs::write(&second, b"SECOND").unwrap();

        let error = copy_paths_impl(
            root,
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            root,
        )
        .expect_err("case-folded batch collision must fail");

        assert!(error.contains("multiple items would overwrite"), "{error}");
        assert!(!error.starts_with("destination conflict:"), "{error}");
        assert_eq!(fs::read(&first).unwrap(), b"FIRST");
        assert_eq!(fs::read(&second).unwrap(), b"SECOND");
        assert!(!root.join("Report.txt").exists());
        assert!(!root.join("report.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_paths_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let dst = root.join("dst");
        let src = root.join("src").join("note.txt");
        fs::create_dir(&dst).unwrap();
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, b"note").unwrap();
        let broken_destination = dst.join("note.txt");
        symlink(root.join("missing.txt"), &broken_destination).unwrap();
        assert!(!broken_destination.exists());

        let err = move_paths_impl(root, vec![src.to_string_lossy().to_string()], &dst)
            .expect_err("broken symlink destination must block overwrite");

        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(&src).unwrap(), b"note");
        assert!(std::fs::symlink_metadata(&broken_destination)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn move_paths_rejects_root_trash_outside_and_self_descendant_moves() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let outside = tempfile::tempdir().expect("outside dir");
        let dir = root.join("dir");
        let nested = dir.join("nested");
        let trash = root.join(LYCEUM_TRASH_DIR);
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&trash).unwrap();

        assert!(
            move_paths_impl(root, vec![root.to_string_lossy().to_string()], &dir)
                .unwrap_err()
                .contains("workspace root")
        );
        assert!(move_paths_impl(
            root,
            vec![dir.to_string_lossy().to_string()],
            outside.path()
        )
        .unwrap_err()
        .contains("outside workspace"));
        assert!(
            move_paths_impl(root, vec![dir.to_string_lossy().to_string()], &nested)
                .unwrap_err()
                .contains("itself")
        );
        assert!(
            move_paths_impl(root, vec![dir.to_string_lossy().to_string()], &trash)
                .unwrap_err()
                .contains("Lyceum trash")
        );
    }

    #[test]
    fn restore_rejects_path_traversal_in_original_path() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        let item = TrashItemDto {
            original_path: root
                .join("../outside/note.txt")
                .to_string_lossy()
                .to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(err.contains("path traversal") || err.contains("outside workspace"));
    }

    #[test]
    fn restore_rejects_path_traversal_in_trash_path() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let item = TrashItemDto {
            original_path: root.join("note.txt").to_string_lossy().to_string(),
            trashed_path: root
                .join(LYCEUM_TRASH_DIR)
                .join("../outside/note.txt")
                .to_string_lossy()
                .to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(
            err.contains("path traversal")
                || err.contains("outside workspace")
                || err.contains("trash item outside Lyceum trash"),
            "{err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_broken_symlink_destination() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root_buf = tmp.path().canonicalize().unwrap();
        let root = root_buf.as_path();
        let original = root.join("note.txt");
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        symlink(root.join("missing.txt"), &original).unwrap();
        assert!(!original.exists());
        let item = TrashItemDto {
            original_path: original.to_string_lossy().to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(&trashed).unwrap(), b"note");
        assert!(std::fs::symlink_metadata(&original)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn redo_moves_restored_broken_symlink_back_to_trash() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let link = root.join("broken-shortcut.txt");
        symlink(root.join("missing.txt"), &link).unwrap();
        let batch = move_paths_to_trash_impl(root, vec![link.to_string_lossy().to_string()])
            .expect("trash broken symlink");

        restore_trash_batch_impl(root, batch.items.clone()).expect("restore broken symlink");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!link.exists());

        redo_trash_batch_impl(root, batch.items.clone()).expect("redo broken symlink delete");

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(std::fs::symlink_metadata(&batch.items[0].trashed_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlinked_destination_ancestor_outside_workspace() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        symlink(outside.path(), root.join("link")).unwrap();
        let trashed = root.join(LYCEUM_TRASH_DIR).join("batch").join("note.txt");
        fs::create_dir_all(trashed.parent().unwrap()).unwrap();
        fs::write(&trashed, b"note").unwrap();
        let item = TrashItemDto {
            original_path: root
                .join("link/nested/note.txt")
                .to_string_lossy()
                .to_string(),
            trashed_path: trashed.to_string_lossy().to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(
            err.contains("resolves outside workspace") || err.contains("outside workspace"),
            "{err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlinked_trash_ancestor_outside_workspace() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let outside = tempfile::tempdir().expect("create outside dir");
        let root = tmp.path();
        let trash_root = root.join(LYCEUM_TRASH_DIR);
        fs::create_dir_all(&trash_root).unwrap();
        fs::write(outside.path().join("note.txt"), b"note").unwrap();
        symlink(outside.path(), trash_root.join("link")).unwrap();
        let item = TrashItemDto {
            original_path: root.join("note.txt").to_string_lossy().to_string(),
            trashed_path: trash_root
                .join("link/note.txt")
                .to_string_lossy()
                .to_string(),
            is_dir: false,
        };

        let err = restore_trash_batch_impl(root, vec![item]).unwrap_err();

        assert!(
            err.contains("resolves outside workspace") || err.contains("outside workspace"),
            "{err}"
        );
    }
}
