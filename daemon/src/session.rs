//! A terminal session: a pty, the thread that drives it, and a mirror of what
//! it has painted.
//!
//! The session owns the pty and outlives every client. Nothing here knows a
//! websocket exists — attaching is a subscription, detaching drops it, and
//! the child never notices either. That is the whole product promise, and it
//! falls out of keeping the pty thread independent of the transport.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use pty::{Control, Pty, SpawnOptions, Waker, Winsize};
use tokio::sync::broadcast;
use vt::Terminal;

use crate::replay::screen_as_ansi;

/// Output fan-out depth. A client that falls this far behind is resynced from
/// the mirror rather than fed a gap, so this only bounds latency tolerance.
const OUTPUT_BACKLOG: usize = 2048;

const SCROLLBACK: usize = 10_000;

pub struct Session {
    pub id: String,
    pub argv: Vec<String>,
    output: broadcast::Sender<Arc<Vec<u8>>>,
    /// Input the pty has not accepted yet. The pty thread blocks in `poll`,
    /// so a writer appends here and rings the waker.
    pending: Arc<Mutex<VecDeque<u8>>>,
    waker: Waker,
    control: Control,
    mirror: Arc<Mutex<Terminal>>,
    alive: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
}

impl Session {
    pub fn spawn(id: String, argv: Vec<String>, cols: u16, rows: u16) -> io::Result<Arc<Session>> {
        let winsize = Winsize::new(cols, rows);
        let mut opts = if argv.is_empty() {
            SpawnOptions::default()
        } else {
            SpawnOptions::command(argv.clone())
        };
        opts.winsize = winsize;
        // TERM decides what the child believes it can emit. The client runs
        // sinclair's vt, which handles the 256-color and truecolor paths, so
        // claiming xterm-256color is honest rather than optimistic.
        opts.env.push(("TERM".into(), "xterm-256color".into()));
        opts.env.push(("COLORTERM".into(), "truecolor".into()));
        opts.env.push(("DEVPIPE_SESSION".into(), id.clone()));

        let mut child = Pty::spawn(&opts)?;
        let control = child.control()?;
        let (pump, waker) = child.pump()?;

        let (output, _) = broadcast::channel(OUTPUT_BACKLOG);
        let mirror = Arc::new(Mutex::new(Terminal::new(
            cols as usize,
            rows as usize,
            SCROLLBACK,
        )));
        let pending = Arc::new(Mutex::new(VecDeque::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let shutdown = Arc::new(AtomicBool::new(false));

        let session = Arc::new(Session {
            id: id.clone(),
            argv: if argv.is_empty() { vec![pty::default_shell()] } else { argv },
            output: output.clone(),
            pending: pending.clone(),
            waker,
            control,
            mirror: mirror.clone(),
            alive: alive.clone(),
            shutdown: shutdown.clone(),
        });

        // A dedicated OS thread, not a tokio task: `Pump::wait` is a blocking
        // poll, and parking a runtime worker on it would starve the server.
        let trace_input = std::env::var_os("DEVPIPE_TRACE_INPUT").is_some();
        std::thread::Builder::new()
            .name(format!("pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 65536];
                'outer: loop {
                    if shutdown.load(Ordering::Relaxed) {
                        break;
                    }
                    let want_write = !pending.lock().unwrap().is_empty();
                    let Ok(ready) = pump.wait(want_write) else { break };

                    if ready.readable {
                        // Drain rather than one read per poll: a burst of
                        // output otherwise costs one syscall round trip per
                        // 64k, and builds cannot outrun the reader.
                        loop {
                            match pump.read(&mut buf) {
                                Ok(0) => break 'outer,
                                Ok(n) => {
                                    let chunk = Arc::new(buf[..n].to_vec());
                                    if let Ok(mut m) = mirror.lock() {
                                        m.feed(&chunk);
                                    }
                                    // Err just means nobody is attached.
                                    let _ = output.send(chunk);
                                    if n < buf.len() {
                                        break;
                                    }
                                }
                                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                                Err(_) => break 'outer,
                            }
                        }
                    }

                    if ready.writable {
                        let mut q = pending.lock().unwrap();
                        while !q.is_empty() {
                            let (front, _) = q.as_slices();
                            let chunk: Vec<u8> = front.to_vec();
                            if trace_input {
                                let hex: Vec<String> =
                                    chunk.iter().map(|b| format!("{b:02x}")).collect();
                                eprintln!("  -> pty {}B: {}", chunk.len(), hex.join(" "));
                            }
                            match pump.write(&chunk) {
                                Ok(0) => break,
                                Ok(n) => drop(q.drain(..n)),
                                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                                Err(_) => break 'outer,
                            }
                        }
                    }
                }
                alive.store(false, Ordering::Relaxed);
                let _ = child.kill();
                let _ = child.wait();
            })?;

        Ok(session)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Vec<u8>>> {
        self.output.subscribe()
    }

    /// The bytes a freshly attached client needs to show the current screen.
    pub fn replay(&self) -> Vec<u8> {
        match self.mirror.lock() {
            Ok(mut m) => screen_as_ansi(&mut m),
            Err(_) => Vec::new(),
        }
    }

    pub fn write(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if std::env::var_os("DEVPIPE_TRACE_INPUT").is_some() {
            let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
            eprintln!("[{}] write {}B: {}", self.id, bytes.len(), hex.join(" "));
        }
        if let Ok(mut q) = self.pending.lock() {
            q.extend(bytes);
        }
        self.waker.wake();
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let _ = self.control.resize(Winsize::new(cols, rows));
        if let Ok(mut m) = self.mirror.lock() {
            m.resize(cols as usize, rows as usize);
        }
    }

    pub fn size(&self) -> (u16, u16) {
        match self.mirror.lock() {
            Ok(m) => (m.cols() as u16, m.rows() as u16),
            Err(_) => (0, 0),
        }
    }

    pub fn title(&self) -> String {
        match self.mirror.lock() {
            Ok(m) => m.title().to_string(),
            Err(_) => String::new(),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn kill(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = self.control.kill();
        self.waker.wake();
    }
}
