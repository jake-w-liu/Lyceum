// Generic LSP server bridge (M9): JSON-RPC 2.0 over stdio.
//
// Each session spawns a language server with piped stdin/stdout. A reader
// thread frames stdout bytes ("Content-Length: N\r\n\r\n<body>") via an
// `LspDecoder` and emits each body as a Tauri event (`lsp:message:<id>`); an
// exit event (`lsp:exit:<id>`) fires on EOF. Sends and stops are plain
// commands. Sessions live in Tauri-managed state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

/// Upper bound on a single LSP message body. A larger declared `Content-Length`
/// is treated as a desync/protocol error rather than buffered unboundedly.
const MAX_CONTENT_LENGTH: usize = 16 * 1024 * 1024;

/// Frame a JSON-RPC body with an LSP `Content-Length` header.
pub fn encode_message(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
}

/// Incremental decoder for LSP `Content-Length`-framed messages over a stream.
#[derive(Default)]
pub struct LspDecoder {
    buf: Vec<u8>,
}

impl LspDecoder {
    /// Append freshly read bytes to the internal buffer.
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Pop the next complete frame's body, or `None` if one is not yet buffered.
    pub fn next_message(&mut self) -> Option<String> {
        let sep = b"\r\n\r\n";
        let header_end = self.buf.windows(sep.len()).position(|w| w == sep)?;
        let headers = String::from_utf8_lossy(&self.buf[..header_end]);

        let content_length = headers.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("Content-Length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })?;

        if content_length > MAX_CONTENT_LENGTH {
            // Desynced or malicious header — discard the buffer instead of
            // growing it without bound while waiting for bytes that won't come.
            self.buf.clear();
            return None;
        }

        let body_start = header_end + sep.len();
        let body_end = body_start + content_length;
        if self.buf.len() < body_end {
            return None;
        }

        let body = String::from_utf8_lossy(&self.buf[body_start..body_end]).into_owned();
        self.buf.drain(..body_end);
        Some(body)
    }
}

struct LspSession {
    stdin: Box<dyn Write + Send>,
    child: Child,
}

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<String, LspSession>>,
}

/// Spawn a language server, streaming its framed stdout messages to the frontend.
#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<LspManager>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("failed to capture stdin")?;
    let mut stdout = child.stdout.take().ok_or("failed to capture stdout")?;

    // Reader thread: frame stdout, emit each message, then emit exit on EOF.
    let app_for_thread = app.clone();
    let message_event = format!("lsp:message:{id}");
    let exit_event = format!("lsp:exit:{id}");
    std::thread::spawn(move || {
        let mut decoder = LspDecoder::default();
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    decoder.push(&buf[..n]);
                    while let Some(body) = decoder.next_message() {
                        let _ = app_for_thread.emit(&message_event, body);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(&exit_event, ());
    });

    // If a server with this id already exists, kill it first so its child
    // exits and its reader thread reaches EOF (otherwise both would leak).
    if let Some(mut old) = state.servers.lock().unwrap().insert(
        id,
        LspSession {
            stdin: Box::new(stdin),
            child,
        },
    ) {
        let _ = old.child.kill();
    }
    Ok(())
}

/// Frame and write a JSON-RPC message to a server's stdin.
#[tauri::command]
pub fn lsp_send(state: State<LspManager>, id: String, message: String) -> Result<(), String> {
    let mut servers = state.servers.lock().unwrap();
    let session = servers.get_mut(&id).ok_or("no such lsp server")?;
    session
        .stdin
        .write_all(&encode_message(&message))
        .map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill and remove a server (idempotent).
#[tauri::command]
pub fn lsp_stop(state: State<LspManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.servers.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_message_frames_body() {
        assert_eq!(encode_message("hello"), b"Content-Length: 5\r\n\r\nhello");
    }

    #[test]
    fn decoder_returns_full_message_pushed_at_once() {
        let mut decoder = LspDecoder::default();
        decoder.push(&encode_message("hello"));
        assert_eq!(decoder.next_message(), Some("hello".to_string()));
        assert_eq!(decoder.next_message(), None);
    }

    #[test]
    fn decoder_assembles_message_split_mid_header() {
        let mut decoder = LspDecoder::default();
        let frame = encode_message("hello");
        decoder.push(&frame[..6]); // "Conten"
        assert_eq!(decoder.next_message(), None);
        decoder.push(&frame[6..]);
        assert_eq!(decoder.next_message(), Some("hello".to_string()));
    }

    #[test]
    fn decoder_assembles_message_split_mid_body() {
        let mut decoder = LspDecoder::default();
        let frame = encode_message("hello");
        let split = frame.len() - 2; // mid-body: "hel"
        decoder.push(&frame[..split]);
        assert_eq!(decoder.next_message(), None);
        decoder.push(&frame[split..]);
        assert_eq!(decoder.next_message(), Some("hello".to_string()));
    }

    #[test]
    fn decoder_returns_two_messages_pushed_together() {
        let mut decoder = LspDecoder::default();
        let mut both = encode_message("one");
        both.extend_from_slice(&encode_message("two"));
        decoder.push(&both);
        assert_eq!(decoder.next_message(), Some("one".to_string()));
        assert_eq!(decoder.next_message(), Some("two".to_string()));
        assert_eq!(decoder.next_message(), None);
    }

    #[test]
    fn decoder_returns_none_when_incomplete() {
        let mut decoder = LspDecoder::default();
        decoder.push(b"Content-Length: 5\r\n\r\nhel");
        assert_eq!(decoder.next_message(), None);
    }

    #[test]
    fn decoder_drops_oversized_frame_instead_of_buffering() {
        let mut decoder = LspDecoder::default();
        decoder.push(b"Content-Length: 999999999\r\n\r\nx");
        assert_eq!(decoder.next_message(), None);
        // The giant pending frame must not be retained (no unbounded growth).
        assert!(decoder.buf.is_empty());
    }
}
