// Julia run-file / run-selection (M8). Spawns the Julia executable and streams
// its stdout/stderr to the frontend as `julia:output:<id>` events, with a
// `julia:exit:<id>` carrying the exit code. The pure argument/resolution logic
// is unit-tested; the spawn/stream path mirrors the terminal and is smoke-tested.
//
// Running children are tracked in `RunManager` (id -> pid) so a long-running or
// hung run can be cancelled from the UI via `run_cancel`; entries are removed on
// natural exit. This mirrors the terminal/LSP managers, which retain kill handles.

use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// id -> OS pid of the running child, so runs can be cancelled and cleaned up.
type RunMap = Arc<Mutex<HashMap<String, u32>>>;

/// Tauri-managed registry of in-flight Julia/build runs.
#[derive(Default)]
pub struct RunManager {
    runs: RunMap,
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

fn augmented_path(path: Option<&OsStr>, home: Option<&OsStr>) -> OsString {
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

fn find_program_in_path(program: &str, path: &OsStr) -> Option<PathBuf> {
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
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
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
            }
        }
        out
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

/// Read a child stream to EOF, emitting each line as an `OutputLine` event.
fn pump<R: Read>(mut reader: R, app: &AppHandle, event: &str, stream_name: &str) {
    let mut splitter = LineSplitter::default();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for line in splitter.feed(&buf[..n]) {
                    let _ = app.emit(
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
        let _ = app.emit(
            event,
            OutputLine {
                stream: stream_name.into(),
                line,
            },
        );
    }
}

/// Send a terminating signal to a process by pid (best-effort, cross-platform).
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

/// Run a Julia file or inline code, streaming output to the frontend.
#[tauri::command]
pub fn run_julia(
    app: AppHandle,
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

    let child = command
        .spawn()
        .map_err(|e| format!("failed to start {program}: {e}"))?;
    stream_child(
        app,
        child,
        id.clone(),
        state.runs.clone(),
        format!("julia:output:{id}"),
        format!("julia:exit:{id}"),
    );
    Ok(())
}

/// Stream a spawned child's stdout/stderr as `<out_event>` (OutputLine payloads)
/// and its exit code as `<exit_event>`. Registers the child in `runs` (keyed by
/// `id`) so it can be cancelled, and removes it on exit. Shared by run_julia and
/// run_build.
fn stream_child(
    app: AppHandle,
    mut child: Child,
    id: String,
    runs: RunMap,
    out_event: String,
    exit_event: String,
) {
    runs.lock().unwrap().insert(id.clone(), child.id());

    let out_handle = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let event = out_event.clone();
        std::thread::spawn(move || pump(stdout, &app, &event, "stdout"))
    });
    let err_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let event = out_event.clone();
        std::thread::spawn(move || pump(stderr, &app, &event, "stderr"))
    });
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        // Drain all output before signaling exit so the frontend (which tears
        // down its output listener on exit) never loses trailing lines.
        if let Some(handle) = out_handle {
            let _ = handle.join();
        }
        if let Some(handle) = err_handle {
            let _ = handle.join();
        }
        runs.lock().unwrap().remove(&id);
        let _ = app.emit(&exit_event, code);
    });
}

/// Run a build command (e.g. `latexmk -pdf main.tex`) via the system shell,
/// streaming output as `build:output:<id>` / `build:exit:<id>` events (M11).
#[tauri::command]
pub fn run_build(
    app: AppHandle,
    state: State<RunManager>,
    id: String,
    command: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let path = augmented_path(
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref(),
    );
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    cmd.env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to run build: {e}"))?;
    stream_child(
        app,
        child,
        id.clone(),
        state.runs.clone(),
        format!("build:output:{id}"),
        format!("build:exit:{id}"),
    );
    Ok(())
}

/// Report whether an executable is available through the same augmented PATH
/// used for Julia runs and build commands. The frontend uses this for
/// conservative tool selection without shelling out itself.
#[tauri::command]
pub fn program_available(program: String) -> bool {
    let program = program.trim();
    if program.is_empty() {
        return false;
    }
    let path = augmented_path(
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref(),
    );
    find_program_in_path(program, &path).is_some()
}

/// Cancel an in-flight run (Julia or build) by id, killing its process. Idempotent.
#[tauri::command]
pub fn run_cancel(state: State<RunManager>, id: String) -> Result<(), String> {
    let pid = state.runs.lock().unwrap().remove(&id);
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
}
