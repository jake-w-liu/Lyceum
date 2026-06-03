// Julia run-file / run-selection (M8). Spawns the Julia executable and streams
// its stdout/stderr to the frontend as `julia:output:<id>` events, with a
// `julia:exit:<id>` carrying the exit code. The pure argument/resolution logic
// is unit-tested; the spawn/stream path mirrors the terminal and is smoke-tested.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Resolve the Julia executable: an explicit setting, else `julia` from PATH
/// (juliaup provides it). Pure for testing.
pub fn resolve_julia(explicit: Option<String>) -> String {
    match explicit {
        Some(s) if !s.is_empty() => s,
        _ => "julia".to_string(),
    }
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

/// Run a Julia file or inline code, streaming output to the frontend.
#[tauri::command]
pub fn run_julia(
    app: AppHandle,
    id: String,
    julia_path: Option<String>,
    file: Option<String>,
    code: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let program = resolve_julia(julia_path);
    let args = julia_args(file.as_deref(), code.as_deref());

    let mut command = Command::new(&program);
    command.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
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
        format!("julia:output:{id}"),
        format!("julia:exit:{id}"),
    );
    Ok(())
}

/// Stream a spawned child's stdout/stderr as `<out_event>` (OutputLine payloads)
/// and its exit code as `<exit_event>`. Shared by run_julia and run_build.
fn stream_child(app: AppHandle, mut child: Child, out_event: String, exit_event: String) {
    let out_handle = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let event = out_event.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit(&event, OutputLine { stream: "stdout".into(), line });
            }
        })
    });
    let err_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let event = out_event.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app.emit(&event, OutputLine { stream: "stderr".into(), line });
            }
        })
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
        let _ = app.emit(&exit_event, code);
    });
}

/// Run a build command (e.g. `latexmk -pdf main.tex`) via the system shell,
/// streaming output as `build:output:<id>` / `build:exit:<id>` events (M11).
#[tauri::command]
pub fn run_build(
    app: AppHandle,
    id: String,
    command: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
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
        format!("build:output:{id}"),
        format!("build:exit:{id}"),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_julia_uses_explicit_then_default() {
        assert_eq!(resolve_julia(Some("/opt/julia".into())), "/opt/julia");
        assert_eq!(resolve_julia(Some(String::new())), "julia");
        assert_eq!(resolve_julia(None), "julia");
    }

    #[test]
    fn julia_args_prefers_inline_code_then_file() {
        assert_eq!(
            julia_args(Some("/w/a.jl"), Some("println(1)")),
            vec!["-e".to_string(), "println(1)".to_string()]
        );
        assert_eq!(julia_args(Some("/w/a.jl"), None), vec!["/w/a.jl".to_string()]);
        assert!(julia_args(None, None).is_empty());
    }
}
