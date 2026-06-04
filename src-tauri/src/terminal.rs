// Embedded terminal backend (M5): real PTY sessions via `portable-pty`.
//
// Each session spawns a shell attached to a pseudo-terminal. A reader thread
// streams output bytes to the frontend as Tauri events (`terminal:data:<id>`),
// and an exit event (`terminal:exit:<id>`) fires when the shell ends. Input,
// resize, and close are plain commands. Sessions live in Tauri-managed state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

const TERMINAL_ERASE_BYTE: u8 = b'\x08';
const TERMINAL_DELETE_BYTE: u8 = b'\x7f';

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Session>>,
}

/// Resolve the shell to spawn: an explicit override, else `$SHELL`, else a
/// platform default. Pure (env passed in) so it is unit-testable.
pub fn resolve_shell(explicit: Option<String>, env_shell: Option<String>) -> String {
    if let Some(s) = explicit {
        if !s.is_empty() {
            return s;
        }
    }
    if let Some(s) = env_shell {
        if !s.is_empty() {
            return s;
        }
    }
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

fn terminal_command(shell: &str) -> CommandBuilder {
    let mut cmd = if cfg!(unix) {
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-lc", "stty erase '^H' 2>/dev/null; exec \"$LYCEUM_SHELL\""]);
        c.env("LYCEUM_SHELL", shell);
        c
    } else {
        CommandBuilder::new(shell)
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

fn normalize_terminal_input(data: &str) -> Vec<u8> {
    data.as_bytes()
        .iter()
        .map(|&b| {
            if b == TERMINAL_DELETE_BYTE {
                TERMINAL_ERASE_BYTE
            } else {
                b
            }
        })
        .collect()
}

/// Spawn a new PTY session running a shell, streaming its output to the frontend.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<TerminalManager>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = resolve_shell(shell, std::env::var("SHELL").ok());
    let mut cmd = terminal_command(&shell);
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Reader thread: stream output, then emit an exit event when the shell ends.
    let app_for_thread = app.clone();
    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // base64 (a JSON-safe string) instead of Vec<u8>, which Tauri
                    // would serialize as a bloated JSON number array (~3.5x).
                    let _ = app_for_thread.emit(&data_event, STANDARD.encode(&buf[..n]));
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        let _ = app_for_thread.emit(&exit_event, ());
    });

    // If a session with this id already exists, kill it first so its child
    // exits and its reader thread reaches EOF (otherwise both would leak).
    if let Some(mut old) = state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
        },
    ) {
        let _ = old.killer.kill();
    }
    Ok(())
}

/// Send input bytes to a session's shell.
#[tauri::command]
pub fn terminal_write(
    state: State<TerminalManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    session
        .writer
        .write_all(&normalize_terminal_input(&data))
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a session's PTY (in character cells).
#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill and remove a session.
#[tauri::command]
pub fn terminal_close(state: State<TerminalManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_shell_prefers_explicit() {
        assert_eq!(
            resolve_shell(Some("/bin/zsh".into()), Some("/bin/bash".into())),
            "/bin/zsh"
        );
    }

    #[test]
    fn resolve_shell_falls_back_to_env_then_default() {
        assert_eq!(resolve_shell(None, Some("/bin/fish".into())), "/bin/fish");
        assert_eq!(resolve_shell(Some(String::new()), None), "/bin/sh");
        assert_eq!(resolve_shell(None, None), "/bin/sh");
    }

    #[test]
    fn normalizes_del_to_ctrl_h_for_backspace() {
        assert_eq!(normalize_terminal_input("abc\x7fd"), b"abc\x08d");
        assert_eq!("λ".as_bytes(), normalize_terminal_input("λ"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_command_wraps_shell_with_ctrl_h_erase() {
        let cmd = terminal_command("/bin/zsh");
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(argv[0], "/bin/sh");
        assert_eq!(argv[1], "-lc");
        assert!(argv[2].contains("stty erase '^H'"));
        assert_eq!(
            cmd.get_env("LYCEUM_SHELL")
                .map(|v| v.to_string_lossy().to_string()),
            Some("/bin/zsh".to_string())
        );
        assert_eq!(
            cmd.get_env("TERM").map(|v| v.to_string_lossy().to_string()),
            Some("xterm-256color".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn pty_streams_command_output() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf LYCEUM_OK"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if out.contains("LYCEUM_OK") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(out.contains("LYCEUM_OK"), "pty output was: {out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn ctrl_h_erases_character_in_canonical_pty_input() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "stty erase '^H'; printf 'READY\\n'; IFS= read -r value; printf '<%s>' \"$value\"",
        ]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if out.contains("READY") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"abc\x08d\r").unwrap();
        writer.flush().unwrap();
        drop(writer);

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if out.contains("<abd>") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(out.contains("<abd>"), "pty output was: {out:?}");
    }
}
