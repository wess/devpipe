//! The attaching client's own terminal.
//!
//! Raw mode is a guard rather than a pair of calls because every exit path —
//! detach, the child exiting, the socket dropping, a panic — has to restore
//! the tty. Leaving a shell in raw mode is the failure everybody remembers.

use std::io;
use std::os::fd::{AsRawFd, RawFd};

/// Ctrl-] , telnet's, because it is the one key nothing else in a terminal
/// wants and everyone who has escaped a remote shell before already knows it.
pub const DETACH: u8 = 0x1d;

pub struct Raw {
    fd: RawFd,
    saved: libc::termios,
}

impl Raw {
    pub fn enter() -> io::Result<Raw> {
        let fd = io::stdin().as_raw_fd();
        if unsafe { libc::isatty(fd) } != 1 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "stdin is not a terminal",
            ));
        }
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut raw = saved;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Raw { fd, saved })
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved) };
    }
}

/// Read a line with the terminal not echoing it.
///
/// A secret typed into a terminal that echoes ends up in the scrollback, in
/// the screenshot of the scrollback, and in whatever the terminal saved on
/// quit. Turning ECHO off for the duration costs four syscalls.
pub fn read_secret(prompt: &str) -> io::Result<String> {
    use std::io::{BufRead, Write};

    let fd = io::stdin().as_raw_fd();
    let tty = unsafe { libc::isatty(fd) } == 1;
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    if tty {
        eprint!("{prompt}");
        io::stderr().flush()?;
        if unsafe { libc::tcgetattr(fd, &mut saved) } == 0 {
            let mut quiet = saved;
            quiet.c_lflag &= !libc::ECHO;
            unsafe { libc::tcsetattr(fd, libc::TCSANOW, &quiet) };
        }
    }

    let mut line = String::new();
    let read = io::stdin().lock().read_line(&mut line);

    if tty {
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };
        // The newline the user typed was swallowed with the echo, and without
        // this everything after prints on the prompt's line.
        eprintln!();
    }
    read?;
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

/// The local window, or a sane default when there is no window to ask —
/// piping `devpipe attach` still has to produce a pty of some size.
pub fn winsize() -> (u16, u16) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let asked = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ as _, &mut ws) };
    if asked == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
        (ws.ws_col, ws.ws_row)
    } else {
        (80, 24)
    }
}
