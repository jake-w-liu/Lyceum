use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const LYCEUM_TRASH_DIR: &str = ".lyceum-trash";
static CASE_PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

/// True only for Lyceum's reserved trash entry directly under `root`.
/// Filesystem identity preserves case-sensitive distinctions while recognizing
/// the actual disk spelling on case-insensitive filesystems.
pub(crate) fn is_workspace_trash_entry(root: &Path, entry: &Path) -> bool {
    entry_matches_sibling_name(root, entry, LYCEUM_TRASH_DIR)
}

/// Match an existing entry against a sibling name by identity. This recognizes
/// preserved disk-case aliases only on filesystems where the requested spelling
/// resolves to that same entry; distinct names on case-sensitive filesystems
/// remain ordinary user content.
pub(crate) fn entry_matches_sibling_name(parent: &Path, entry: &Path, name: &str) -> bool {
    if entry.parent() != Some(parent) {
        return false;
    }
    if entry
        .file_name()
        .is_some_and(|entry_name| entry_name == name)
    {
        return true;
    }
    // Every reserved traversal name is ASCII. Avoid filesystem identity calls
    // for the overwhelmingly common case where the spelling cannot be a case
    // alias of that name.
    if name.is_ascii()
        && !entry
            .file_name()
            .and_then(|entry_name| entry_name.to_str())
            .is_some_and(|entry_name| entry_name.eq_ignore_ascii_case(name))
    {
        return false;
    }
    same_existing_entry(entry, &parent.join(name))
}

/// True when the requested path, or the target of any symlink in it, passes
/// through an entry named `name` below the workspace root. Existing entries are
/// compared by filesystem identity, so an uppercase spelling aliases the
/// reserved name only on a case-insensitive filesystem.
pub(crate) fn path_resolves_through_workspace_name(root: &Path, path: &Path, name: &str) -> bool {
    path_resolves_through_workspace_names(root, path, &[name], &[])
}

/// Batched traversal classifier. The path and workspace root are resolved at
/// most once regardless of how many internal/heavy names the caller checks.
pub(crate) fn path_resolves_through_workspace_names(
    root: &Path,
    path: &Path,
    any_entry_names: &[&str],
    directory_names: &[&str],
) -> bool {
    if path_contains_named_entry(root, path, any_entry_names, directory_names) {
        return true;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    if let Ok(canonical_path) = path.canonicalize() {
        return path_contains_named_entry(
            &canonical_root,
            &canonical_path,
            any_entry_names,
            directory_names,
        );
    }

    // Removal notifications often name a child that no longer exists. Resolve
    // each still-existing lexical ancestor so an alias such as
    // `docs/git-link -> ../.git` remains classified even after its child was
    // removed and the full event path can no longer be canonicalized.
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        current.push(component);
        if current.canonicalize().is_ok_and(|canonical| {
            path_contains_named_entry(
                &canonical_root,
                &canonical,
                any_entry_names,
                directory_names,
            )
        }) {
            return true;
        }
    }
    false
}

fn path_contains_named_entry(
    root: &Path,
    path: &Path,
    any_entry_names: &[&str],
    directory_names: &[&str],
) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut parent = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        let entry = parent.join(component);
        if any_entry_names
            .iter()
            .any(|name| entry_matches_sibling_name(&parent, &entry, name))
        {
            return true;
        }
        if directory_names
            .iter()
            .any(|name| entry_matches_sibling_name(&parent, &entry, name))
            && std::fs::metadata(&entry).is_ok_and(|metadata| metadata.is_dir())
        {
            return true;
        }
        parent = entry;
    }
    false
}

/// True when an existing path or any existing lexical ancestor resolves into
/// Lyceum's reserved trash entry directly under `root`. This hides aliases to
/// the internal store at any Explorer depth without reserving an ordinary
/// nested directory that merely has the same name.
pub(crate) fn path_resolves_into_workspace_trash(root: &Path, path: &Path) -> bool {
    if path_starts_with_workspace_trash(root, path) {
        return true;
    }
    let (Ok(canonical_root), Ok(canonical_trash)) = (
        root.canonicalize(),
        root.join(LYCEUM_TRASH_DIR).canonicalize(),
    ) else {
        return false;
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if let Ok(canonical) = path.canonicalize() {
        return resolved_path_is_workspace_trash(&canonical_root, &canonical_trash, &canonical);
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        current.push(component);
        if current.canonicalize().is_ok_and(|canonical| {
            resolved_path_is_workspace_trash(&canonical_root, &canonical_trash, &canonical)
        }) {
            return true;
        }
    }
    false
}

fn resolved_path_is_workspace_trash(
    canonical_root: &Path,
    canonical_trash: &Path,
    path: &Path,
) -> bool {
    path == canonical_trash
        || path.starts_with(canonical_trash)
        || path_starts_with_workspace_trash(canonical_root, path)
}

/// True when `path` is the reserved root trash entry or one of its descendants.
pub(crate) fn path_starts_with_workspace_trash(root: &Path, path: &Path) -> bool {
    let Some(Component::Normal(first)) = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
    else {
        return false;
    };
    is_workspace_trash_entry(root, &root.join(first))
}

/// Like `path_starts_with_workspace_trash`, but also rejects an absent spelling
/// that would become the reserved entry once created on a case-insensitive
/// directory. Existing identity alone cannot answer that pre-claim question.
pub(crate) fn path_would_be_workspace_trash(root: &Path, path: &Path) -> std::io::Result<bool> {
    let Some(Component::Normal(first)) = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
    else {
        return Ok(false);
    };
    if first == LYCEUM_TRASH_DIR {
        return Ok(true);
    }
    let Some(name) = first.to_str() else {
        return Ok(false);
    };
    if !name.eq_ignore_ascii_case(LYCEUM_TRASH_DIR) {
        return Ok(false);
    }

    let entry = root.join(first);
    if is_workspace_trash_entry(root, &entry) {
        return Ok(true);
    }
    if std::fs::symlink_metadata(&entry).is_ok() {
        // Both spellings exist as distinct entries, so this directory is
        // demonstrably case-sensitive for the requested name.
        return Ok(false);
    }
    Ok(!directory_is_case_sensitive(root)?)
}

/// Probe lookup semantics with one uniquely claimed file. Before cleanup, move
/// the pathname to a second unique name and compare it with the still-open file
/// handle's identity. A replacement at the observed probe name is restored and
/// never deleted.
fn directory_is_case_sensitive(root: &Path) -> std::io::Result<bool> {
    directory_is_case_sensitive_with_hook(root, |_| {})
}

fn directory_is_case_sensitive_with_hook(
    root: &Path,
    mut after_probe: impl FnMut(&Path),
) -> std::io::Result<bool> {
    const MAX_ATTEMPTS: usize = 128;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for _ in 0..MAX_ATTEMPTS {
        let sequence = CASE_PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
        let lower_name = format!(
            ".lyceum-case-probe-{}-{nanos}-{sequence}",
            std::process::id()
        );
        let lower = root.join(&lower_name);
        match create_probe_file(&lower) {
            Ok(file) => {
                let Some(owned_identity) = file_identity(&file) else {
                    remove_claimed_probe(file, &lower)?;
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "filesystem does not expose a stable probe identity",
                    ));
                };
                let upper = root.join(lower_name.to_ascii_uppercase());
                let aliases = same_existing_entry(&lower, &upper);
                after_probe(&lower);

                let quarantine_sequence = CASE_PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
                let quarantine = root.join(format!(
                    ".lyceum-case-probe-quarantine-{}-{nanos}-{quarantine_sequence}",
                    std::process::id()
                ));
                crate::fs_ops::rename_noreplace(&lower, &quarantine)?;
                if entry_identity(&quarantine).as_ref() != Some(&owned_identity) {
                    let _ = crate::fs_ops::rename_noreplace(&quarantine, &lower);
                    return Err(std::io::Error::other(
                        "case-sensitivity probe path was concurrently replaced",
                    ));
                }
                remove_claimed_probe(file, &quarantine)?;
                return Ok(!aliases);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not claim a unique case-sensitivity probe",
    ))
}

#[cfg(windows)]
fn create_probe_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE: u32 = 0x0001_0000;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(unix)]
fn create_probe_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn create_probe_file(_path: &Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "case-sensitivity probe is unsupported on this platform",
    ))
}

#[cfg(windows)]
fn remove_claimed_probe(file: std::fs::File, _path: &Path) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: u8,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information_class: i32,
            information: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    let information = FileDispositionInfo { delete_file: 1 };
    // SAFETY: `file` owns a live handle with DELETE access, `information` has
    // the FILE_DISPOSITION_INFO layout, and the API retains neither pointer.
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&information as *const FileDispositionInfo).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    drop(file);
    Ok(())
}

#[cfg(not(windows))]
fn remove_claimed_probe(file: std::fs::File, path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(path)?;
    drop(file);
    Ok(())
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExistingEntryIdentity(u64, u64);

#[cfg(unix)]
fn metadata_identity(metadata: &std::fs::Metadata) -> Option<ExistingEntryIdentity> {
    use std::os::unix::fs::MetadataExt;

    Some(ExistingEntryIdentity(metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExistingEntryIdentity(u32, u64);

#[cfg(windows)]
fn metadata_identity(metadata: &std::fs::Metadata) -> Option<ExistingEntryIdentity> {
    use std::os::windows::fs::MetadataExt;

    Some(ExistingEntryIdentity(
        metadata.volume_serial_number()?,
        metadata.file_index()?,
    ))
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExistingEntryIdentity;

#[cfg(not(any(unix, windows)))]
fn metadata_identity(_metadata: &std::fs::Metadata) -> Option<ExistingEntryIdentity> {
    None
}

fn entry_identity(path: &Path) -> Option<ExistingEntryIdentity> {
    metadata_identity(&std::fs::symlink_metadata(path).ok()?)
}

fn file_identity(file: &std::fs::File) -> Option<ExistingEntryIdentity> {
    metadata_identity(&file.metadata().ok()?)
}

#[cfg(unix)]
fn same_existing_entry(left: &Path, right: &Path) -> bool {
    matches!((entry_identity(left), entry_identity(right)), (Some(left), Some(right)) if left == right)
}

#[cfg(windows)]
fn same_existing_entry(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (entry_identity(left), entry_identity(right)) {
        (Some(left), Some(right)) => left == right,
        // Some network filesystems omit stable IDs. Existing ordinary probe
        // entries can still be compared by their resolved paths; broken links
        // remain conservatively non-equal rather than guessed from spelling.
        _ => match (left.canonicalize(), right.canonicalize()) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        },
    }
}

#[cfg(not(any(unix, windows)))]
fn same_existing_entry(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        directory_is_case_sensitive, directory_is_case_sensitive_with_hook,
        path_resolves_into_workspace_trash, path_would_be_workspace_trash, LYCEUM_TRASH_DIR,
    };
    use std::path::PathBuf;

    #[test]
    fn absent_trash_case_alias_follows_the_directory_lookup_semantics() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let case_sensitive = directory_is_case_sensitive(root).unwrap();

        assert_eq!(
            path_would_be_workspace_trash(root, &root.join(".LYCEUM-TRASH")).unwrap(),
            !case_sensitive
        );
        assert!(std::fs::read_dir(root).unwrap().next().is_none());
    }

    #[test]
    fn nested_trash_case_alias_is_never_reserved() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();

        assert!(!path_would_be_workspace_trash(
            root,
            &root.join(PathBuf::from("nested").join(".LYCEUM-TRASH")),
        )
        .unwrap());
    }

    #[test]
    fn case_probe_cleanup_preserves_a_concurrent_empty_replacement() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let mut replacement = None;

        let error = directory_is_case_sensitive_with_hook(root, |probe| {
            std::fs::remove_file(probe).unwrap();
            std::fs::write(probe, b"concurrent replacement").unwrap();
            replacement = Some(probe.to_path_buf());
        })
        .expect_err("replacement identity must abort probe cleanup");

        assert!(error.to_string().contains("concurrently replaced"));
        let replacement = replacement.unwrap();
        assert_eq!(
            std::fs::read(&replacement).unwrap(),
            b"concurrent replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_root_trash_case_alias_follows_filesystem_identity() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path();
        let upper = root.join(".LYCEUM-TRASH");
        std::fs::create_dir(&upper).unwrap();
        std::fs::write(upper.join("deleted.txt"), b"deleted").unwrap();
        symlink(".LYCEUM-TRASH", root.join("trash-link")).unwrap();

        assert_eq!(
            path_resolves_into_workspace_trash(root, &root.join("trash-link").join("deleted.txt")),
            root.join(LYCEUM_TRASH_DIR).exists()
        );
    }

    #[test]
    fn windows_identity_source_uses_non_following_file_ids() {
        let source = include_str!("workspace_paths.rs");
        let identity_start = source
            .find("fn entry_identity(path: &Path)")
            .expect("entry identity helper");
        let identity_end = source[identity_start..]
            .find("fn file_identity")
            .map(|offset| identity_start + offset)
            .expect("end of entry identity helper");
        let entry_identity = &source[identity_start..identity_end];
        let start = source
            .find("#[cfg(windows)]\nfn same_existing_entry")
            .expect("Windows identity branch");
        let end = source[start..]
            .find("#[cfg(not(any(unix, windows)))]")
            .map(|offset| start + offset)
            .expect("end of Windows identity branch");
        let implementation = &source[start..end];

        assert!(entry_identity.contains("symlink_metadata"));
        assert!(implementation.contains("entry_identity(left)"));
        assert!(implementation.contains("entry_identity(right)"));
        assert!(source.contains("volume_serial_number()?"));
        assert!(source.contains("file_index()?"));
        assert!(!implementation.contains("std::fs::metadata(left)"));
        assert!(source.contains("access_mode(GENERIC_WRITE | DELETE)"));
        assert!(source.contains("delete_file: u8"));
        assert!(source.contains("SetFileInformationByHandle"));
    }
}
