// Embedded terminal backend (M5): real PTY sessions via `portable-pty`.
//
// Each session spawns a shell attached to a pseudo-terminal. A reader thread
// streams output bytes to the frontend as Tauri events (`terminal:data:<id>`),
// and an exit event (`terminal:exit:<id>`) fires when the shell ends. Input,
// resize, and close are plain commands. Sessions live in Tauri-managed state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Monotonic generation stamp for sessions. The reader thread only removes its
/// own session from the map when the stored generation still matches, so a new
/// session that reused the same id is never torn down by a stale reader.
static SESSION_GEN: AtomicU64 = AtomicU64::new(0);

/// At most this many raw PTY chunks may wait for the event-emitter thread.
/// Reader chunks are 4 KiB, so the queue retains at most roughly 256 KiB per
/// terminal before applying backpressure to the PTY (plus one in-flight batch).
const OUTPUT_QUEUE_CAPACITY: usize = 64;

/// Largest payload the emitter thread will coalesce into one Tauri event.
const MAX_OUTPUT_BATCH: usize = 32 * 1024;
/// How long the emitter waits for more output before flushing a partial batch.
const MAX_OUTPUT_DELAY: std::time::Duration = std::time::Duration::from_millis(5);
/// Maximum terminal data events emitted but not yet parsed by xterm. Together
/// with `MAX_OUTPUT_BATCH`, this bounds the WebView/event/xterm backlog to about
/// 256 KiB per terminal; the reader's bounded queue adds another ~256 KiB.
const MAX_IN_FLIGHT_OUTPUT_EVENTS: usize = 8;

fn terminal_output_channel() -> (
    std::sync::mpsc::SyncSender<Vec<u8>>,
    std::sync::mpsc::Receiver<Vec<u8>>,
) {
    std::sync::mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY)
}

#[derive(Default)]
struct OutputFlowState {
    in_flight: usize,
    cancelled: bool,
}

#[derive(Default)]
struct OutputFlow {
    state: Mutex<OutputFlowState>,
    ready: Condvar,
}

impl OutputFlow {
    fn reserve(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !state.cancelled && state.in_flight >= MAX_IN_FLIGHT_OUTPUT_EVENTS {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if state.cancelled {
            return false;
        }
        state.in_flight += 1;
        true
    }

    fn acknowledge(&self, count: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight = state.in_flight.saturating_sub(count);
        self.ready.notify_all();
    }

    fn cancel(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.cancelled = true;
        self.ready.notify_all();
    }

    fn is_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancelled
    }
}

/// At most this many pending writes may queue for a session's writer thread.
/// One entry is one `terminal_write` (a keystroke, or a whole paste however
/// large), so this only fills when a wedged child has ignored a thousand
/// separate inputs.
const INPUT_QUEUE_CAPACITY: usize = 1024;

fn terminal_input_channel() -> (
    std::sync::mpsc::SyncSender<Vec<u8>>,
    std::sync::mpsc::Receiver<Vec<u8>>,
) {
    std::sync::mpsc::sync_channel(INPUT_QUEUE_CAPACITY)
}

fn enqueue_terminal_input(
    input: &std::sync::mpsc::SyncSender<Vec<u8>>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    input.try_send(bytes).map_err(|error| match error {
        std::sync::mpsc::TrySendError::Full(_) => "terminal input queue full".to_string(),
        std::sync::mpsc::TrySendError::Disconnected(_) => "terminal input closed".to_string(),
    })
}

/// Own the PTY writer on a dedicated thread and drain the input queue in order.
/// Exits when the session (and with it the sender) is dropped, or when the PTY
/// write fails because the shell is gone.
fn spawn_terminal_writer(
    mut writer: Box<dyn Write + Send>,
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("lyceum-terminal-write".to_string())
        .spawn(move || {
            while let Ok(bytes) = rx.recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        })
        .map(|_| ())
}

/// Coalesce reader chunks into one event payload: start from `first`, then keep
/// WAITING for more until the batch reaches `max_batch` bytes or `max_delay`
/// elapses.
///
/// Waiting (rather than draining only what is already queued) is the whole
/// point. The reader hands over one 4 KiB chunk per `read`, and every emitted
/// event becomes a `webview.eval()` posted to the UI thread's event loop —
/// which is unbounded and has no backpressure. A drain-only loop returned as
/// soon as the queue was momentarily empty, so heavy output produced one
/// main-thread script evaluation per 4 KiB instead of per 32 KiB.
fn collect_batch(
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    first: Vec<u8>,
    max_batch: usize,
    max_delay: std::time::Duration,
) -> Vec<u8> {
    let mut batch = first;
    let deadline = std::time::Instant::now() + max_delay;
    while batch.len() < max_batch {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            // Timeout: the shell went quiet inside the window, so emit what we
            // have (this is the interactive path — at most `max_delay` of added
            // echo latency). Disconnected: the reader is gone; emit the tail and
            // let the outer `recv` end the emitter thread.
            Err(_) => break,
        }
    }
    batch
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    // Input is handed to a per-session writer thread rather than written inline.
    // Tauri runs non-async commands on the thread that receives the IPC message
    // — the UI thread on macOS — so writing to the PTY from terminal_write meant
    // a child that had stopped draining its stdin (a long command running while
    // the user pastes) blocked the whole window until it finished. A single
    // consumer also keeps writes in arrival order, which a threadpool command
    // would not.
    input: std::sync::mpsc::SyncSender<Vec<u8>>,
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
    output_flows: Mutex<HashMap<String, Arc<OutputFlow>>>,
    teardowns: crate::julia::TeardownTracker,
}

impl TerminalManager {
    /// Kill every running terminal session. Called on app exit so no shell
    /// subprocess is orphaned when Lyceum quits.
    pub fn shutdown_all(&self) {
        let flows: Vec<Arc<OutputFlow>> = self
            .output_flows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(_, flow)| flow)
            .collect();
        for flow in flows {
            flow.cancel();
        }
        let sessions = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sessions.drain().map(|(_, session)| session).collect()
        };
        kill_and_reap(sessions);
        self.teardowns.shutdown_and_join();
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
        let flows: Vec<Arc<OutputFlow>> = {
            let mut flows = self
                .output_flows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys: Vec<String> = flows
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect();
            keys.iter().filter_map(|key| flows.remove(key)).collect()
        };
        for flow in flows {
            flow.cancel();
        }
        let removed: Vec<Session> = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys: Vec<String> = sessions
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect();
            keys.iter().filter_map(|key| sessions.remove(key)).collect()
        };
        if !removed.is_empty() {
            self.teardowns.spawn(move || kill_and_reap(removed));
        }
    }
}

/// Kill and reap sessions after their map entries have been removed. Callers
/// either run this synchronously during app exit or register it with the
/// manager's teardown tracker for window/tab close.
fn kill_and_reap(sessions: Vec<Session>) {
    for mut session in sessions {
        // child.kill() escalates SIGHUP -> grace -> SIGKILL (portable_pty),
        // so a shell that traps/ignores SIGHUP can't block child.wait()
        // forever and leak this thread, the process, and the PTY fds.
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
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
    if state
        .sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(&key)
    {
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
    // The writer thread must exist before the session does; without it every
    // keystroke would be queued to a receiver nobody reads.
    let (input_tx, input_rx) = terminal_input_channel();
    if let Err(e) = spawn_terminal_writer(writer, input_rx) {
        let _ = killer.kill();
        let _ = child.wait();
        return Err(format!("failed to start terminal writer: {e}"));
    }

    let gen = SESSION_GEN.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");
    let output_flow = Arc::new(OutputFlow::default());

    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
                input: input_tx,
                child,
                gen,
            },
        );
    }
    state
        .output_flows
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(key.clone(), output_flow.clone());

    // Reader thread: pull raw bytes off the PTY and hand them to the emitter
    // thread through a channel. Splitting read from emit lets the emitter
    // coalesce a backlog without ever issuing a blocking read that would sit on
    // already-buffered output.
    // A bounded queue is essential here: a child can write PTY output much
    // faster than Tauri can serialize/emit it. An unbounded mpsc::channel would
    // retain every 4 KiB chunk until the process exhausts memory. Backpressure
    // is correct terminal behavior; once this small queue fills, the reader
    // pauses and the kernel PTY buffer eventually throttles the child.
    let (tx, rx) = terminal_output_channel();
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
        if let Some(manager) = app_for_reader.try_state::<TerminalManager>() {
            let reclaimed = {
                let mut sessions = manager
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if sessions
                    .get(&key_for_reader)
                    .is_some_and(|session| session.gen == gen)
                {
                    sessions.remove(&key_for_reader)
                } else {
                    None
                }
            };
            // EOF does not prove the child itself exited: a shell can close its
            // PTY fds and continue running. Once its map ownership is removed,
            // route kill/reap through the manager tracker so ExitRequested can
            // join it instead of exiting around a blocked reader thread.
            if let Some(session) = reclaimed {
                manager
                    .teardowns
                    .spawn(move || kill_and_reap(vec![session]));
            }
        }
    });

    // Emitter thread: coalesce bursts (up to ~32 KiB or ~5 ms) into one event so
    // heavy output does not become thousands of IPC events per second. An idle
    // shell costs nothing extra — the batch closes as soon as the PTY goes quiet
    // for MAX_DELAY, so interactive echo is delayed by at most one 5 ms window.
    let app_for_thread = app.clone();
    let key_for_emitter = key.clone();
    let flow_for_emitter = output_flow.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let batch = collect_batch(&rx, first, MAX_OUTPUT_BATCH, MAX_OUTPUT_DELAY);
            // `emit_to` only queues a WebView evaluation and returns immediately.
            // Reserve a bounded slot first; xterm acknowledges after parsing so
            // background output applies real backpressure all the way to the PTY.
            if !flow_for_emitter.reserve() {
                break;
            }
            // base64 (a JSON-safe string) instead of Vec<u8>, which Tauri
            // would serialize as a bloated JSON number array (~3.5x).
            if app_for_thread
                .emit_to(label.as_str(), &data_event, STANDARD.encode(&batch))
                .is_err()
            {
                flow_for_emitter.acknowledge(1);
                break;
            }
        }
        if !flow_for_emitter.is_cancelled() {
            let _ = app_for_thread.emit_to(label.as_str(), &exit_event, ());
        }
        if let Some(manager) = app_for_thread.try_state::<TerminalManager>() {
            let mut flows = manager
                .output_flows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if flows
                .get(&key_for_emitter)
                .is_some_and(|flow| Arc::ptr_eq(flow, &flow_for_emitter))
            {
                flows.remove(&key_for_emitter);
            }
        }
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
    // Clone out the session's input sender under the map lock, release the lock,
    // then hand the bytes to that session's writer thread. This command runs on
    // the UI thread (Tauri executes non-async commands inline on the thread that
    // received the IPC message), so it must never touch the PTY itself: a child
    // that has stopped reading its stdin would otherwise block the write — and
    // the whole window — until it did.
    let input = {
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let session = sessions
            .get(&session_key(&window, &id))
            .ok_or("no such terminal")?;
        session.input.clone()
    };
    // Never wait for capacity here: this command executes on the macOS UI
    // thread. A full bounded queue means the child is already not consuming
    // input; report backpressure instead of freezing the whole window.
    enqueue_terminal_input(&input, normalize_terminal_input(&data))
}

/// Release terminal output flow-control slots after xterm has parsed the data.
#[tauri::command]
pub fn terminal_ack_output(
    window: tauri::Window,
    state: State<TerminalManager>,
    id: String,
    count: usize,
) -> Result<(), String> {
    if count == 0 {
        return Ok(());
    }
    let flow = state
        .output_flows
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&session_key(&window, &id))
        .cloned();
    // Late acknowledgements after EOF/close are harmless: no emitter remains
    // waiting on the removed flow.
    if let Some(flow) = flow {
        flow.acknowledge(count);
    }
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
    let sessions = state
        .sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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
    if let Some(flow) = state
        .output_flows
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&session_key(&window, &id))
    {
        flow.cancel();
    }
    let removed = state
        .sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&session_key(&window, &id));
    if let Some(session) = removed {
        // The reader thread no longer reaps a session a closer removed. Track
        // the detached kill/reap so app exit can join it before the runtime
        // tears down the process.
        state.teardowns.spawn(move || kill_and_reap(vec![session]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_queue_is_strictly_bounded() {
        let (sender, _receiver) = terminal_output_channel();
        for _ in 0..OUTPUT_QUEUE_CAPACITY {
            sender.try_send(vec![0; 4096]).expect("queue capacity");
        }
        assert!(matches!(
            sender.try_send(vec![0; 4096]),
            Err(std::sync::mpsc::TrySendError::Full(_))
        ));
    }

    #[test]
    fn terminal_output_flow_waits_at_the_parse_backlog_cap() {
        let flow = Arc::new(OutputFlow::default());
        for _ in 0..MAX_IN_FLIGHT_OUTPUT_EVENTS {
            assert!(flow.reserve());
        }

        let waiting_flow = flow.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let reserved = waiting_flow.reserve();
            done_tx.send(reserved).expect("report reservation");
        });

        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "one more event must wait until xterm acknowledges parsed output"
        );
        flow.acknowledge(1);
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("reservation should resume"));
        waiter.join().expect("flow waiter");
    }

    #[test]
    fn terminal_output_flow_cancel_unblocks_a_waiting_emitter() {
        let flow = Arc::new(OutputFlow::default());
        for _ in 0..MAX_IN_FLIGHT_OUTPUT_EVENTS {
            assert!(flow.reserve());
        }

        let waiting_flow = flow.clone();
        let waiter = std::thread::spawn(move || waiting_flow.reserve());
        flow.cancel();
        assert!(!waiter.join().expect("flow waiter"));
    }

    #[test]
    fn terminal_input_queue_is_strictly_bounded() {
        let (sender, _receiver) = terminal_input_channel();
        for _ in 0..INPUT_QUEUE_CAPACITY {
            sender.try_send(b"x".to_vec()).expect("queue capacity");
        }
        assert!(matches!(
            sender.try_send(b"x".to_vec()),
            Err(std::sync::mpsc::TrySendError::Full(_))
        ));
    }

    /// A `Write` sink that records everything written, for the writer-thread tests.
    #[derive(Clone, Default)]
    struct RecordingWriter(std::sync::Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn terminal_writer_thread_preserves_input_order_and_stops_with_the_session() {
        let sink = RecordingWriter::default();
        let recorded = sink.0.clone();
        let (sender, receiver) = terminal_input_channel();
        spawn_terminal_writer(Box::new(sink), receiver).expect("writer thread");

        for byte in b"abcdefghij" {
            sender.send(vec![*byte]).expect("queued");
        }
        // Dropping the session's sender is what ends the thread; once it has, the
        // queue is fully drained.
        drop(sender);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let written = recorded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if written == b"abcdefghij".to_vec() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "writer thread did not drain in order: {written:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn terminal_write_never_blocks_on_a_stalled_pty() {
        // Keep the receiver alive but deliberately never drain it, modelling a
        // writer blocked behind a child that stopped reading.
        let (sender, _receiver) = terminal_input_channel();
        for _ in 0..INPUT_QUEUE_CAPACITY {
            enqueue_terminal_input(&sender, b"keystroke".to_vec()).expect("queue capacity");
        }
        let started = std::time::Instant::now();
        let error = enqueue_terminal_input(&sender, b"one too many".to_vec())
            .expect_err("full queue must reject");
        let elapsed = started.elapsed();

        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "rejecting input behind a stalled PTY took {elapsed:?}"
        );
        assert_eq!(error, "terminal input queue full");
    }

    #[test]
    fn collect_batch_waits_out_the_window_for_a_trickling_reader() {
        // The reader hands over one 4 KiB chunk per `read`, so the queue is
        // routinely empty for a few microseconds between chunks. A drain-only
        // loop returned there and emitted a separate event per 4 KiB; the
        // batcher must keep waiting until the batch is full or the window ends.
        let (sender, receiver) = terminal_output_channel();
        let producer = std::thread::spawn(move || {
            for _ in 0..8 {
                if sender.send(vec![b'x'; 4096]).is_err() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
        });

        let first = receiver.recv().expect("first chunk");
        let batch = collect_batch(
            &receiver,
            first,
            32 * 1024,
            std::time::Duration::from_millis(500),
        );
        producer.join().expect("producer");

        assert_eq!(
            batch.len(),
            8 * 4096,
            "all trickled chunks land in one batch"
        );
    }

    #[test]
    fn collect_batch_stops_at_the_size_cap() {
        let (sender, receiver) = terminal_output_channel();
        for _ in 0..8 {
            sender.try_send(vec![b'x'; 4096]).expect("queue capacity");
        }

        let first = receiver.recv().expect("first chunk");
        let batch = collect_batch(
            &receiver,
            first,
            3 * 4096,
            std::time::Duration::from_millis(500),
        );

        // Chunks are appended whole, so the cap is honoured on the next check:
        // three 4 KiB chunks reach the 12 KiB cap exactly and the loop stops.
        assert_eq!(batch.len(), 3 * 4096);
        assert_eq!(receiver.try_recv().map(|c| c.len()).ok(), Some(4096));
    }

    #[test]
    fn collect_batch_flushes_a_partial_batch_when_the_shell_goes_quiet() {
        let (sender, receiver) = terminal_output_channel();
        sender.try_send(b"hi".to_vec()).expect("queue capacity");

        let first = receiver.recv().expect("first chunk");
        let started = std::time::Instant::now();
        let batch = collect_batch(
            &receiver,
            first,
            32 * 1024,
            std::time::Duration::from_millis(20),
        );
        let elapsed = started.elapsed();

        assert_eq!(batch, b"hi".to_vec());
        // Bounded by the delay window: interactive echo is never held longer.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "{elapsed:?}"
        );
    }

    #[test]
    fn collect_batch_emits_the_tail_when_the_reader_disconnects() {
        let (sender, receiver) = terminal_output_channel();
        sender.try_send(b"tail".to_vec()).expect("queue capacity");
        drop(sender);

        let first = receiver.recv().expect("first chunk");
        let batch = collect_batch(
            &receiver,
            first,
            32 * 1024,
            std::time::Duration::from_secs(30),
        );

        // Must not sit on the 30 s window after the reader is gone.
        assert_eq!(batch, b"tail".to_vec());
    }

    #[test]
    fn terminal_reader_reap_is_manager_tracked() {
        let source = include_str!("terminal.rs");
        let reader = source
            .split_once("// Reader thread: pull raw bytes")
            .expect("reader source")
            .1
            .split_once("// Emitter thread: coalesce bursts")
            .expect("reader end")
            .0;
        assert!(reader.contains(".teardowns"));
        assert!(reader.contains(".spawn(move || kill_and_reap(vec![session]))"));
    }

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
