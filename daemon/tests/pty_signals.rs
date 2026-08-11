//! The pty layer on its own: no websocket, no axum, no session thread.
//!
//! If Ctrl+C fails here, the problem is below Devpipe entirely.

use std::io;
use std::time::{Duration, Instant};

use pty::{Pty, SpawnOptions, Winsize};

/// Drive a pty directly: write `input`, pump output, and return everything
/// seen within `window`.
fn run(argv: &[&str], script: &[(u64, &[u8])], window: Duration) -> String {
    let mut opts = SpawnOptions::command(argv.iter().map(|s| s.to_string()).collect());
    opts.winsize = Winsize::new(80, 24);
    opts.env.push(("TERM".into(), "xterm-256color".into()));

    let mut child = Pty::spawn(&opts).expect("spawn");
    let (pump, waker) = child.pump().expect("pump");

    let start = Instant::now();
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut next = 0;

    while start.elapsed() < window {
        if next < script.len() {
            let (at_ms, bytes) = script[next];
            if start.elapsed() >= Duration::from_millis(at_ms) {
                let mut written = 0;
                while written < bytes.len() {
                    match pump.write(&bytes[written..]) {
                        Ok(0) => break,
                        Ok(n) => written += n,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("write: {e}"),
                    }
                }
                next += 1;
            }
        }
        match pump.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => break,
        }
    }
    drop(waker);
    let _ = child.kill();
    String::from_utf8_lossy(&out).into_owned()
}

/// The baseline: bytes written to the master reach the child and run.
#[test]
fn input_reaches_the_child() {
    let out = run(
        &["/bin/bash", "--norc"],
        &[(300, b"echo $((6*7))-ran\n")],
        Duration::from_secs(3),
    );
    assert!(out.contains("42-ran"), "child never ran the command; saw:\n{out}");
}

/// And the one that matters: 0x03 must signal, not just echo.
#[test]
fn ctrl_c_signals_the_foreground_child() {
    let out = run(
        &["/bin/bash", "--norc"],
        &[
            (300, b"sleep 30\n"),
            (1200, &[0x03]),
            (2000, b"echo $((6*7))-alive\n"),
        ],
        Duration::from_secs(5),
    );
    assert!(
        out.contains("42-alive"),
        "SIGINT never reached the child — the shell was still blocked in sleep.\nsaw:\n{out}"
    );
}
