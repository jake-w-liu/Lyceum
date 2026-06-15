// Julia run-file / run-selection (M8). Spawns the Julia executable and streams
// its stdout/stderr to the frontend as `julia:output:<id>` events, with a
// `julia:exit:<id>` carrying the exit code. The pure argument/resolution logic
// is unit-tested; the spawn/stream path mirrors the terminal and is smoke-tested.
//
// Running children are tracked in `RunManager` (id -> pid) so a long-running or
// hung run can be cancelled from the UI via `run_cancel`; entries are removed on
// natural exit. This mirrors the terminal/LSP managers, which retain kill handles.

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// id -> OS pid of the running child, so runs can be cancelled and cleaned up.
pub(crate) type RunMap = Arc<Mutex<HashMap<String, u32>>>;

/// Tauri-managed registry of in-flight Julia/build runs.
#[derive(Default)]
pub struct RunManager {
    pub(crate) runs: RunMap,
    /// Run keys whose cancel arrived before the child was registered (cancel
    /// raced the spawn). `stream_child` consults this right after it inserts and
    /// kills immediately, so a Stop click during the spawn window is honored
    /// instead of being silently lost.
    pub(crate) pending_cancel: Arc<Mutex<HashSet<String>>>,
}

impl RunManager {
    /// Kill every in-flight run (whole process group each). Called on app exit
    /// so a long-running Julia process is not orphaned when Lyceum quits.
    /// Entries are drained under the lock, but the (blocking) kills happen
    /// after the guard is dropped so reaper threads are never blocked on it.
    pub fn shutdown_all(&self) {
        let pids: Vec<u32> = match self.runs.lock() {
            Ok(mut runs) => runs.drain().map(|(_id, pid)| pid).collect(),
            Err(_) => return,
        };
        for pid in pids {
            kill_pid(pid);
        }
    }

    /// Cancel every in-flight run belonging to one window (called when it is
    /// destroyed), reusing the `run_cancel` discipline: entries are removed
    /// while the lock is held — so removal stays serialized against the reaper
    /// threads and `run_cancel` — and the (blocking) kills happen after the
    /// guard is dropped.
    pub fn cancel_runs_for_window(&self, label: &str) {
        let prefix = format!("{label}:");
        let mut pids = Vec::new();
        match self.runs.lock() {
            Ok(mut runs) => runs.retain(|key, pid| {
                if key.starts_with(&prefix) {
                    pids.push(*pid);
                    false
                } else {
                    true
                }
            }),
            Err(_) => return,
        }
        // Drop any pending-cancel tombstones for this window so they don't linger
        // after the window is gone (e.g. a cancel that raced a spawn which then
        // errored before registering).
        if let Ok(mut pending) = self.pending_cancel.lock() {
            pending.retain(|key| !key.starts_with(&prefix));
        }
        for pid in pids {
            kill_pid(pid);
        }
    }
}

/// Runs are app-global but ids are generated per window, so the registry is
/// keyed by `"<window label>:<id>"` to keep windows from colliding.
pub(crate) fn run_key(window: &tauri::Window, id: &str) -> String {
    format!("{}:{}", window.label(), id)
}

/// Resolve the Julia executable: an explicit setting, else common GUI-app PATH
/// locations plus PATH (juliaup provides it). Pure-ish wrapper for production.
pub fn resolve_julia(explicit: Option<String>) -> String {
    resolve_julia_with_env(
        explicit,
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref(),
    )
}

fn resolve_julia_with_env(
    explicit: Option<String>,
    path: Option<&OsStr>,
    home: Option<&OsStr>,
) -> String {
    match explicit {
        Some(s) if !s.is_empty() => return s,
        _ => {}
    }
    let search_path = augmented_path(path, home);
    find_program_in_path("julia", &search_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "julia".to_string())
}

pub(crate) fn augmented_path(path: Option<&OsStr>, home: Option<&OsStr>) -> OsString {
    let mut dirs: Vec<PathBuf> = path.map(env::split_paths).into_iter().flatten().collect();
    if let Some(home) = home {
        let home = PathBuf::from(home);
        dirs.push(home.join(".juliaup").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
    }
    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
        dirs.push(PathBuf::from("/usr/sbin"));
        dirs.push(PathBuf::from("/sbin"));
    }
    env::join_paths(dedup_paths(dirs)).unwrap_or_default()
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if !path.as_os_str().is_empty() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

pub(crate) fn find_program_in_path(program: &str, path: &OsStr) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return is_executable_file(program_path).then(|| program_path.to_path_buf());
    }
    for dir in env::split_paths(path) {
        let candidate = dir.join(program);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{program}.exe"));
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
pub(crate) fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub(crate) fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Build Julia CLI args: run inline `code` (`-e code`) if given, else a file
/// path, else nothing. Pure for testing.
pub fn julia_args(file: Option<&str>, code: Option<&str>) -> Vec<String> {
    if let Some(c) = code {
        return vec!["-e".to_string(), c.to_string()];
    }
    if let Some(f) = file {
        return vec![f.to_string()];
    }
    Vec::new()
}

#[derive(Clone, Serialize)]
struct OutputLine {
    stream: String,
    line: String,
}

/// Incremental splitter that turns a child's raw output bytes into log lines.
///
/// Unlike `BufRead::lines()` (which only yields on `\n`/EOF and withholds
/// carriage-return progress redraws and newline-less trailing output until the
/// stream closes), this breaks on `\n`, `\r`, and `\r\n`, so incremental and
/// progress output surfaces promptly. `\r\n` is collapsed to a single line and
/// blank lines from `\n\n` are preserved. State persists across reads.
#[derive(Default)]
struct LineSplitter {
    line: Vec<u8>,
    pending_cr: bool,
}

impl LineSplitter {
    /// A buffered line longer than this is force-flushed as-is, so a child that
    /// prints a huge chunk with no newline cannot grow the buffer unboundedly.
    const MAX_LINE: usize = 1024 * 1024;

    /// Feed freshly read bytes; returns each completed line (terminator stripped).
    fn feed(&mut self, data: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in data {
            if b == b'\n' {
                if self.pending_cr {
                    // `\r\n`: the `\r` already emitted this line; swallow the `\n`.
                    self.pending_cr = false;
                } else {
                    out.push(String::from_utf8_lossy(&self.line).into_owned());
                    self.line.clear();
                }
            } else if b == b'\r' {
                out.push(String::from_utf8_lossy(&self.line).into_owned());
                self.line.clear();
                self.pending_cr = true;
            } else {
                self.pending_cr = false;
                self.line.push(b);
                if self.line.len() >= Self::MAX_LINE {
                    out.push(self.force_flush());
                }
            }
        }
        out
    }

    /// Force-flush the buffer at `MAX_LINE`, stopping at the last complete UTF-8
    /// char boundary so a multi-byte code point straddling the cap is not split
    /// into U+FFFD replacement chars. Any trailing incomplete bytes are retained
    /// to be completed by the next read. An all-invalid buffer (no valid prefix)
    /// is flushed whole to guarantee forward progress.
    fn force_flush(&mut self) -> String {
        let valid_up_to = match std::str::from_utf8(&self.line) {
            Ok(_) => self.line.len(),
            Err(e) => e.valid_up_to(),
        };
        let cut = if valid_up_to == 0 {
            self.line.len()
        } else {
            valid_up_to
        };
        let flushed = String::from_utf8_lossy(&self.line[..cut]).into_owned();
        self.line.drain(..cut);
        flushed
    }

    /// Emit any buffered partial line (output that never ended in a newline).
    fn finish(&mut self) -> Option<String> {
        if self.line.is_empty() {
            None
        } else {
            let s = String::from_utf8_lossy(&self.line).into_owned();
            self.line.clear();
            Some(s)
        }
    }
}

/// Read a child stream to EOF, emitting each line as an `OutputLine` event to
/// the owning window only.
fn pump<R: Read>(mut reader: R, app: &AppHandle, label: &str, event: &str, stream_name: &str) {
    let mut splitter = LineSplitter::default();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for line in splitter.feed(&buf[..n]) {
                    let _ = app.emit_to(
                        label,
                        event,
                        OutputLine {
                            stream: stream_name.into(),
                            line,
                        },
                    );
                }
            }
            Err(_) => break,
        }
    }
    if let Some(line) = splitter.finish() {
        let _ = app.emit_to(
            label,
            event,
            OutputLine {
                stream: stream_name.into(),
                line,
            },
        );
    }
}

/// Place a spawned child in its own process group (Unix) so the whole group —
/// the child plus anything it forks (e.g. `latexmk` -> `pdflatex`/`biber`) — can
/// be terminated together on cancel. No-op elsewhere (Windows uses `taskkill /T`,
/// which already walks the process tree).
pub(crate) fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 0 = put the child in a new process group whose id equals its pid.
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

/// Send a terminating signal to a process by pid (best-effort, cross-platform).
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // Children are spawned in their own process group (see
        // `configure_process_group`), so signal the whole group first (negative
        // pid) to terminate grandchildren too — otherwise cancelling a build
        // leaves the heavyweight compiler subtree (pdflatex/biber) running
        // orphaned while the UI reports the run as ended. Then signal the pid
        // directly as a fallback for any child not in its own group.
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Signal only the process GROUP of `pid` (negative pid on Unix), NOT the bare
/// pid. Safe to call after the leader child has already been reaped: the group
/// keeps existing as long as a lingering grandchild (which inherited the pipe)
/// is alive, whereas the bare leader pid may have been reused by an unrelated
/// process. Used to unblock the output pumps on a natural exit whose grandchild
/// is holding the stdout/stderr pipe open.
fn kill_process_group(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Run a Julia file or inline code, streaming output to the frontend.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command signature mirrors the IPC payload.
pub fn run_julia(
    app: AppHandle,
    window: tauri::Window,
    state: State<RunManager>,
    id: String,
    julia_path: Option<String>,
    file: Option<String>,
    code: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let program = resolve_julia(julia_path);
    let args = julia_args(file.as_deref(), code.as_deref());
    let path = augmented_path(
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref(),
    );

    let mut command = Command::new(&program);
    command
        .args(&args)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            command.current_dir(dir);
        }
    }
    configure_process_group(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("failed to start {program}: {e}"))?;
    stream_child(
        app,
        window.label().to_string(),
        child,
        run_key(&window, &id),
        state.runs.clone(),
        state.pending_cancel.clone(),
        format!("julia:output:{id}"),
        format!("julia:exit:{id}"),
    );
    Ok(())
}

/// Stream a spawned child's stdout/stderr as `<out_event>` (OutputLine payloads)
/// and its exit code as `<exit_event>`, emitted to the window labelled `label`.
/// Registers the child in `runs` (keyed by `key`, see `run_key`) so it can be
/// cancelled, and removes it on exit.
#[allow(clippy::too_many_arguments)] // Explicitly carries all process-stream ownership handles.
pub(crate) fn stream_child(
    app: AppHandle,
    label: String,
    mut child: Child,
    key: String,
    runs: RunMap,
    pending_cancel: Arc<Mutex<HashSet<String>>>,
    out_event: String,
    exit_event: String,
) {
    let pid = child.id();
    // Register the child, but honor a cancel that arrived during the spawn window
    // (before this insert). Both this check and `run_cancel`'s tombstone insert
    // happen while holding the `runs` lock, so they cannot interleave into a gap
    // where neither side acts: either we observe the tombstone here, or
    // `run_cancel` observes our registration there.
    let cancelled_during_spawn = {
        let mut runs = runs.lock().unwrap();
        if pending_cancel.lock().unwrap().remove(&key) {
            true
        } else {
            runs.insert(key.clone(), pid);
            false
        }
    };
    if cancelled_during_spawn {
        // Don't register; kill now. The pumps/reaper below still run so the child
        // is reaped (no zombie) and the exit event still fires for the UI.
        kill_pid(pid);
    }

    let out_handle = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let label = label.clone();
        let event = out_event.clone();
        std::thread::spawn(move || pump(stdout, &app, &label, &event, "stdout"))
    });
    let err_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let label = label.clone();
        let event = out_event.clone();
        std::thread::spawn(move || pump(stderr, &app, &label, &event, "stderr"))
    });
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        // Remove the run from the registry as soon as the child is reaped: its OS
        // pid is now eligible for reuse, so it must not remain visible to a late
        // `run_cancel` (which would otherwise signal an unrelated process that
        // reused the pid). Draining the pumps below can block (e.g. if a grandchild
        // holds the pipe open), so this must happen before the joins, not after.
        // Only remove the entry if it still maps to OUR pid — a new run that
        // reused the key must not lose its (live) registration.
        {
            let mut runs = runs.lock().unwrap();
            if runs.get(&key).copied() == Some(pid) {
                runs.remove(&key);
            }
        }
        // Drain output before signaling exit so the frontend (which tears down
        // its output listener on exit) does not lose trailing lines — but bound
        // the wait. A grandchild that inherited the pipe (e.g. latexmk forking
        // pdflatex into the background) can hold it open after the leader exits;
        // the exit event must still fire so the UI never hangs "running" forever.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            if let Some(handle) = out_handle {
                let _ = handle.join();
            }
            if let Some(handle) = err_handle {
                let _ = handle.join();
            }
            let _ = tx.send(());
        });
        if rx.recv_timeout(std::time::Duration::from_secs(2)).is_err() {
            // The pumps did not finish draining within the timeout: a grandchild
            // inherited the pipe and is keeping it open after the leader exited.
            // On the natural-exit path nothing else will ever close it, so the
            // pump threads (blocked in read()) and this drain thread would leak
            // forever. Signal the leader's process group to close the pipe so they
            // can terminate. Group-only (never the bare, possibly-reused pid).
            kill_process_group(pid);
        }
        let _ = app.emit_to(label.as_str(), &exit_event, code);
    });
}

/// Cancel an in-flight Julia run by id, killing its whole process group.
/// Idempotent. The entry is removed while the `runs` lock is held, so removal
/// is serialized against the reaper thread: whichever thread removes the id
/// first owns it, and the other observes a miss and does nothing — only one
/// `kill_pid` can ever fire for a given run. The kill itself (which spawns a
/// blocking `kill` subprocess) happens AFTER the guard is dropped so it never
/// stalls other run commands. Killing the process group (negative pid) further
/// bounds blast radius if the leader pid were ever reused before the entry is
/// dropped.
#[tauri::command]
pub fn run_cancel(
    window: tauri::Window,
    state: State<RunManager>,
    id: String,
) -> Result<(), String> {
    let key = run_key(&window, &id);
    // Take the `runs` lock as the outer lock for both the remove and the
    // tombstone insert, matching `stream_child`'s ordering, so a cancel that
    // races the spawn cannot slip through a gap: if the child isn't registered
    // yet, we leave a tombstone that `stream_child` will honor on registration.
    let pid = {
        let mut runs = state.runs.lock().unwrap();
        match runs.remove(&key) {
            Some(pid) => Some(pid),
            None => {
                state.pending_cancel.lock().unwrap().insert(key);
                None
            }
        }
    };
    if let Some(pid) = pid {
        kill_pid(pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_julia_uses_explicit_then_default() {
        assert_eq!(
            resolve_julia_with_env(Some("/opt/julia".into()), None, None),
            "/opt/julia"
        );
        assert_eq!(
            resolve_julia_with_env(Some(String::new()), None, None),
            "julia"
        );
        assert_eq!(resolve_julia_with_env(None, None, None), "julia");
    }

    #[test]
    fn resolve_julia_finds_juliaup_home_bin() {
        let root = std::env::temp_dir().join(format!("lyceum-julia-test-{}", std::process::id()));
        let bin = root.join(".juliaup").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = bin.join(if cfg!(windows) { "julia.exe" } else { "julia" });
        std::fs::write(&executable, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions).unwrap();
        }

        let resolved = resolve_julia_with_env(None, None, Some(root.as_os_str()));

        assert_eq!(resolved, executable.to_string_lossy());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_julia_ignores_non_executable_path_entries() {
        let root =
            std::env::temp_dir().join(format!("lyceum-julia-non-exec-test-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("julia"), b"").unwrap();
        let executable = second.join("julia");
        std::fs::write(&executable, b"").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions).unwrap();
        }
        let path = env::join_paths([first.as_path(), second.as_path()]).unwrap();

        let resolved = resolve_julia_with_env(None, Some(path.as_os_str()), None);

        assert_eq!(resolved, executable.to_string_lossy());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn julia_args_prefers_inline_code_then_file() {
        assert_eq!(
            julia_args(Some("/w/a.jl"), Some("println(1)")),
            vec!["-e".to_string(), "println(1)".to_string()]
        );
        assert_eq!(
            julia_args(Some("/w/a.jl"), None),
            vec!["/w/a.jl".to_string()]
        );
        assert!(julia_args(None, None).is_empty());
    }

    #[test]
    fn line_splitter_splits_on_lf_crlf_and_cr() {
        let mut s = LineSplitter::default();
        let lines = s.feed(b"a\nb\r\nc\rd");
        assert_eq!(lines, vec!["a", "b", "c"]);
        assert_eq!(s.finish(), Some("d".to_string()));
    }

    #[test]
    fn line_splitter_preserves_blank_lines_and_emits_no_trailing_when_empty() {
        let mut s = LineSplitter::default();
        assert_eq!(s.feed(b"\n\n"), vec!["", ""]);
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn line_splitter_pending_cr_carries_across_feeds() {
        let mut s = LineSplitter::default();
        assert_eq!(s.feed(b"abc\r"), vec!["abc"]);
        // The `\n` arriving in the next read must not emit a spurious blank line.
        assert_eq!(s.feed(b"\ndef"), Vec::<String>::new());
        assert_eq!(s.finish(), Some("def".to_string()));
    }

    #[test]
    fn force_flush_at_max_line_does_not_split_multibyte_utf8() {
        let mut s = LineSplitter::default();
        // Fill to one byte short of the cap, then push the first byte of a 2-byte
        // 'é' (0xC3 0xA9). That push reaches MAX_LINE and force-flushes.
        let mut data = vec![b'a'; LineSplitter::MAX_LINE - 1];
        data.push(0xC3);
        let lines = s.feed(&data);

        assert_eq!(lines.len(), 1, "expected exactly one forced flush");
        assert!(
            !lines[0].contains('\u{FFFD}'),
            "forced flush split a multi-byte char into U+FFFD"
        );
        assert_eq!(lines[0].len(), LineSplitter::MAX_LINE - 1);
        // The orphaned 0xC3 was retained; its continuation byte completes 'é'.
        assert!(s.feed(&[0xA9]).is_empty());
        assert_eq!(s.finish(), Some("é".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn kill_pid_terminates_a_running_child() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        kill_pid(pid);
        // Should be reaped promptly (signalled) rather than after 30s.
        let status = child.wait().expect("wait child");
        assert!(
            !status.success(),
            "killed child should not exit successfully"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_pid_terminates_whole_process_group() {
        // A leader spawned in its own process group that forks a background
        // grandchild (mirrors `latexmk` forking `pdflatex`). Killing the group
        // must reap the grandchild too, not just the leader — the regression
        // this guards is "cancel reports done while the compiler keeps running".
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command.spawn().expect("spawn group leader");
        let leader_pid = child.id();

        // Read the backgrounded grandchild's pid (printed by `echo $!`).
        let mut stdout = child.stdout.take().expect("capture stdout");
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match stdout.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    if byte[0] == b'\n' {
                        break;
                    }
                    line.push(byte[0]);
                }
                Err(_) => break,
            }
        }
        let grandchild_pid: i32 = String::from_utf8_lossy(&line)
            .trim()
            .parse()
            .expect("parse grandchild pid");

        kill_pid(leader_pid);
        let _ = child.wait();

        // The grandchild must be gone (a signal-0 probe fails) within a moment.
        let mut alive = true;
        for _ in 0..50 {
            let reaped = Command::new("kill")
                .args(["-0", &grandchild_pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| !s.success())
                .unwrap_or(true);
            if reaped {
                alive = false;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        assert!(
            !alive,
            "backgrounded grandchild {grandchild_pid} survived the group kill"
        );
    }
}
