//! Guards the bug that Ctrl+C silently did nothing.
//!
//! This lives in its own test binary on purpose: it deliberately puts the
//! process into the broken state (SIGINT ignored), and signal dispositions are
//! process-wide, so sharing a binary with other tests would leak it into them.
//!
//! The failure this catches is invisible from inside a session. `stty` reports
//! `isig` and `intr = ^C`, the foreground process group is correct, the byte
//! arrives at the pty, and the kernel really does raise SIGINT. The foreground
//! job just ignores it, because a non-interactive shell starting a background
//! job sets SIGINT to SIG_IGN and dispositions survive fork and exec.

use std::io;
use std::time::{Duration, Instant};

use pty::{Pty, SpawnOptions, Winsize};

/// Reproduce how a daemon is actually launched: SIGINT ignored, inherited by
/// everything spawned from here.
fn ignore_sigint() {
    unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
}

fn sigint_reaches_a_child() -> bool {
    let mut opts = SpawnOptions::command(
        ["/bin/bash", "--norc"].iter().map(|s| s.to_string()).collect(),
    );
    opts.winsize = Winsize::new(80, 24);
    opts.env.push(("TERM".into(), "xterm-256color".into()));

    let mut child = Pty::spawn(&opts).expect("spawn");
    let (pump, _waker) = child.pump().expect("pump");

    let script: [(u64, &[u8]); 3] = [
        (300, b"sleep 30\n"),
        (1200, &[0x03]),
        (2000, b"echo $((6*7))-alive\n"),
    ];
    let start = Instant::now();
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut next = 0;

    while start.elapsed() < Duration::from_secs(5) {
        if next < script.len() && start.elapsed() >= Duration::from_millis(script[next].0) {
            let bytes = script[next].1;
            let mut written = 0;
            while written < bytes.len() {
                match pump.write(&bytes[written..]) {
                    Ok(0) => break,
                    Ok(n) => written += n,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
            next += 1;
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
    let _ = child.kill();
    // The marker is computed, not echoed: asserting on a literal string would
    // match the shell echoing the line back while still blocked in `sleep`.
    String::from_utf8_lossy(&out).contains("42-alive")
}

#[test]
fn an_inherited_ignored_sigint_breaks_ctrl_c_until_it_is_reset() {
    ignore_sigint();
    assert!(
        !sigint_reaches_a_child(),
        "expected the broken case to reproduce; if this now passes, the pty \
         layer started resetting dispositions itself and the workaround in \
         devpiped::restore_default_signal_dispositions can go"
    );

    devpiped::restore_default_signal_dispositions();
    assert!(
        sigint_reaches_a_child(),
        "after restoring default dispositions, Ctrl+C must interrupt again"
    );
}
