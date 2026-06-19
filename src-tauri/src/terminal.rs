// Embedded terminal backend (M5): real PTY sessions via `portable-pty`.
//
// Each session spawns a shell attached to a pseudo-terminal. A reader thread
// streams output bytes to the frontend as Tauri events (`terminal:data:<id>`),
// and an exit event (`terminal:exit:<id>`) fires when the shell ends. Input,
// resize, and close are plain commands. Sessions live in Tauri-managed state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Monotonic generation stamp for sessions. The reader thread only removes its
/// own session from the map when the stored generation still matches, so a new
/// session that reused the same id is never torn down by a stale reader.
static SESSION_GEN: AtomicU64 = AtomicU64::new(0);

struct Session {
    master: Box<dyn MasterPty + Send>,
    // The writer lives behind its own lock so terminal_write never holds the
    // manager map lock across blocking PTY I/O (a full PTY buffer would
    // otherwise deadlock every terminal command). Mirrors lsp.rs's stdin.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    // The child handle lives in the session (not the reader thread) so whoever
    // wins the gen-guarded map removal — the reader on EOF, OR a closer — owns
    // the reap. All kills go through this one owned handle (child.kill() escalates
    // SIGHUP -> grace -> SIGKILL), so child.wait() and any kill share a single
    // handle and a closer can never signal a pid the reader just reaped.
    child: Box<dyn portable_pty::Child + Send + Sync>,
    gen: u64,
}

/// Sessions are app-global but ids are generated per window, so the map is
/// keyed by `"<window label>:<id>"` to keep windows from colliding.
fn session_key(window: &tauri::Window, id: &str) -> String {
    format!("{}:{}", window.label(), id)
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl TerminalManager {
    /// Kill every running terminal session. Called on app exit so no shell
    /// subprocess is orphaned when Lyceum quits.
    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_id, mut session) in sessions.drain() {
                // child.kill() escalates SIGHUP -> grace -> SIGKILL so a shell
                // that traps/ignores SIGHUP is terminated, not left orphaned.
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }

    /// Kill every session belonging to one window (called when it is
    /// destroyed), so its shells and PTY fds do not outlive the window.
    /// Entries are removed under the lock, but the kills happen after the
    /// guard is dropped so other windows' terminal commands are never blocked
    /// on them. Each killed shell's reader thread then sees EOF and reaps the
    /// child as usual (its map entry is already gone, which is fine — removal
    /// there is gen-guarded and tolerates a miss).
    pub fn close_sessions_for_window(&self, label: &str) {
        let prefix = format!("{label}:");
        let removed: Vec<Session> = {
            let Ok(mut sessions) = self.sessions.lock() else {
                return;
            };
            let keys: Vec<String> = sessions
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect();
            keys.iter().filter_map(|key| sessions.remove(key)).collect()
        };
        kill_and_reap_detached(removed);
    }
}

/// Kill and reap the given sessions on a DETACHED thread. The window-close and
/// tab-close paths use this so their caller — the window `Destroyed` handler on
/// the main event-loop thread, or a Tauri command thread — never blocks on a
/// shell slow to exit on SIGHUP. The sessions are already removed from the map,
/// and the child lives in the Session, so the reader threads won't double-reap
/// and the reap/kill can't race a reader's wait on the same pid. (App-exit
/// shutdown_all does the same kill+reap inline — the app is quitting, so there's
/// nothing left for it to block.)
fn kill_and_reap_detached(sessions: Vec<Session>) {
    if sessions.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        for mut session in sessions {
            // child.kill() escalates SIGHUP -> grace -> SIGKILL (portable_pty),
            // so a shell that traps/ignores SIGHUP can't block child.wait()
            // forever and leak this thread, the process, and the PTY fds.
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    });
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

fn terminal_command(shell: Option<&str>, env_shell: Option<String>) -> CommandBuilder {
    let mut cmd = if cfg!(unix) {
        let mut c = CommandBuilder::new_default_prog();
        if let Some(shell) = shell
            .filter(|shell| !shell.is_empty())
            .or(env_shell.as_deref().filter(|shell| !shell.is_empty()))
        {
            c.env("SHELL", shell);
        }
        c
    } else {
        let shell = resolve_shell(shell.map(ToOwned::to_owned), env_shell);
        CommandBuilder::new(shell)
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

fn normalize_terminal_input(data: &str) -> Vec<u8> {
    data.as_bytes().to_vec()
}

/// Spawn a new PTY session running a shell, streaming its output to the frontend.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command signature mirrors the IPC payload.
pub fn terminal_create(
    app: AppHandle,
    window: tauri::Window,
    state: State<TerminalManager>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let key = session_key(&window, &id);
    // Reject a duplicate id outright rather than silently killing the existing
    // session (which would orphan the old tab and leak its reader thread).
    if state.sessions.lock().unwrap().contains_key(&key) {
        return Err(format!("terminal already exists: {id}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = terminal_command(shell.as_deref(), std::env::var("SHELL").ok());
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Acquire the killer immediately so any failure between here and inserting
    // the session can still terminate (and reap) the just-spawned shell instead
    // of orphaning it.
    let mut killer = child.clone_killer();
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    let writer = Arc::new(Mutex::new(writer));

    let gen = SESSION_GEN.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");

    {
        let mut sessions = state.sessions.lock().unwrap();
        if sessions.contains_key(&key) {
            drop(sessions);
            let _ = killer.kill();
            let _ = child.wait();
            return Err(format!("terminal already exists: {id}"));
        }
        sessions.insert(
            key.clone(),
            Session {
                master: pair.master,
                writer,
                child,
                gen,
            },
        );
    }

    // Reader thread: pull raw bytes off the PTY and hand them to the emitter
    // thread through a channel. Splitting read from emit lets the emitter
    // coalesce a backlog without ever issuing a blocking read that would sit on
    // already-buffered output.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let app_for_reader = app.clone();
    let key_for_reader = key.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        drop(tx);
        // The shell hit EOF, so it is exiting. Reclaim our session from the map —
        // but ONLY if our generation still owns the entry. The child lives IN the
        // session, so whoever wins this removal owns the reap. If a closer
        // (terminal_close / shutdown_all / close_sessions_for_window) already
        // removed it, the closer owns the child and reaps it; we must NOT touch
        // the pid, which by then may be reaped and reused — that is exactly the
        // bare-pid SIGHUP-to-an-unrelated-process hazard. Only our own generation
        // matches, so a new session that reused the id is never reclaimed here.
        let mut reclaimed: Option<Session> = None;
        if let Some(manager) = app_for_reader.try_state::<TerminalManager>() {
            let mut sessions = manager.sessions.lock().unwrap();
            if sessions
                .get(&key_for_reader)
                .is_some_and(|session| session.gen == gen)
            {
                reclaimed = sessions.remove(&key_for_reader);
            }
        }
        // Reap outside the lock, and only when WE won the removal.
        if let Some(mut session) = reclaimed {
            let _ = session.child.wait();
        }
    });

    // Emitter thread: coalesce bursts (up to ~32 KiB or ~5 ms) into one event so
    // heavy output does not become thousands of IPC events per second, while
    // small interactive output is flushed immediately (try_recv -> Empty).
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        const MAX_BATCH: usize = 32 * 1024;
        const MAX_DELAY: std::time::Duration = std::time::Duration::from_millis(5);
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            let deadline = std::time::Instant::now() + MAX_DELAY;
            while batch.len() < MAX_BATCH && std::time::Instant::now() < deadline {
                match rx.try_recv() {
                    Ok(chunk) => batch.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            // base64 (a JSON-safe string) instead of Vec<u8>, which Tauri
            // would serialize as a bloated JSON number array (~3.5x).
            let _ = app_for_thread.emit_to(label.as_str(), &data_event, STANDARD.encode(&batch));
        }
        let _ = app_for_thread.emit_to(label.as_str(), &exit_event, ());
    });

    Ok(())
}

/// Send input bytes to a session's shell.
#[tauri::command]
pub fn terminal_write(
    window: tauri::Window,
    state: State<TerminalManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Clone out the per-session writer under the map lock, then release the map
    // lock BEFORE the (potentially blocking) write/flush so a full PTY buffer
    // on one terminal can't wedge every other terminal command.
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions
            .get(&session_key(&window, &id))
            .ok_or("no such terminal")?;
        session.writer.clone()
    };
    let mut writer = writer.lock().unwrap();
    writer
        .write_all(&normalize_terminal_input(&data))
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a session's PTY (in character cells).
#[tauri::command]
pub fn terminal_resize(
    window: tauri::Window,
    state: State<TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_key(&window, &id))
        .ok_or("no such terminal")?;
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
pub fn terminal_close(
    window: tauri::Window,
    state: State<TerminalManager>,
    id: String,
) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .unwrap()
        .remove(&session_key(&window, &id));
    if let Some(session) = removed {
        // Reap on a detached thread (see kill_and_reap_detached): the reader
        // thread no longer reaps a session a closer removed, and this command
        // must not block on a shell slow to exit on SIGHUP.
        kill_and_reap_detached(vec![session]);
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
        let default_shell = if cfg!(windows) {
            "powershell.exe"
        } else {
            "/bin/sh"
        };
        assert_eq!(resolve_shell(Some(String::new()), None), default_shell);
        assert_eq!(resolve_shell(None, None), default_shell);
    }

    #[test]
    fn preserves_terminal_input_bytes() {
        assert_eq!(normalize_terminal_input("abc\x7fd"), b"abc\x7fd");
        assert_eq!("λ".as_bytes(), normalize_terminal_input("λ"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_command_starts_login_shell() {
        let cmd = terminal_command(Some("/bin/zsh"), None);
        assert!(cmd.is_default_prog());
        assert_eq!(
            cmd.get_env("SHELL")
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
    fn terminal_command_uses_env_shell_for_login_shell() {
        let cmd = terminal_command(None, Some("/bin/bash".to_string()));
        assert!(cmd.is_default_prog());
        assert_eq!(
            cmd.get_env("SHELL")
                .map(|v| v.to_string_lossy().to_string()),
            Some("/bin/bash".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn login_zsh_reads_zprofile_before_zshrc() {
        use std::{fs, path::Path};

        if !Path::new("/bin/zsh").exists() {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(".zprofile"),
            "export LYCEUM_LOGIN_SHELL_TEST=from_zprofile\n",
        )
        .unwrap();
        fs::write(
            dir.path().join(".zshrc"),
            "printf 'LYCEUM_LOGIN:%s\\n' \"$LYCEUM_LOGIN_SHELL_TEST\"; exit\n",
        )
        .unwrap();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = terminal_command(Some("/bin/zsh"), None);
        cmd.env("HOME", dir.path());
        cmd.env("ZDOTDIR", dir.path());
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
                    if out.contains("LYCEUM_LOGIN:from_zprofile") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(
            out.contains("LYCEUM_LOGIN:from_zprofile"),
            "pty output was: {out:?}"
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
    fn del_erases_character_in_canonical_pty_input() {
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
            "printf 'READY\\n'; IFS= read -r value; printf '<%s>' \"$value\"",
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
        writer.write_all(b"abc\x7fd\r").unwrap();
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
