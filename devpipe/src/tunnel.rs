//! Reaching a host over ssh.
//!
//! The daemon speaks plaintext websocket and binds loopback, which is the
//! right default and a useless one on its own: the host worth having is not
//! the laptop it is running on. Rather than grow a certificate story — a CA to
//! trust, a name to match, a renewal to forget — this borrows the one every
//! developer already has working on the box, and one they already trust with
//! more than this.
//!
//! So `--ssh box` is not a convenience wrapper around a manual `ssh -L`. It is
//! the transport, and the daemon stays a loopback service on the far side
//! where nothing but ssh can reach it.

use std::io;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

/// How long to wait for ssh to finish authenticating and open the forward.
/// Long enough for a passphrase prompt and a slow handshake, short enough that
/// a hostname nobody can resolve fails while you are still watching.
const PATIENCE: Duration = Duration::from_secs(30);

pub struct Tunnel {
    child: Child,
    pub url: String,
}

/// An ssh destination, with the port ssh itself listens on if it is not 22.
/// `box`, `wess@box`, `wess@box:2222`.
pub struct Target {
    pub host: String,
    pub port: Option<u16>,
}

impl Target {
    pub fn parse(given: &str) -> Target {
        let whole = || Target {
            host: given.to_string(),
            port: None,
        };
        // `[fe80::1]:2222` — brackets are how a literal address says which of
        // its colons is the port, and the brackets are not part of the host.
        if let Some(rest) = given.strip_prefix('[') {
            let Some((inside, after)) = rest.split_once(']') else {
                return whole();
            };
            return Target {
                host: inside.to_string(),
                port: after.strip_prefix(':').and_then(|p| p.parse().ok()),
            };
        }
        // Otherwise a colon is the port only if it is the *only* one. A bare
        // `fe80::1` is an address, and reading its last colon as a port turns
        // it into a hostname nobody can resolve.
        match given.split_once(':') {
            Some((host, port)) if !port.contains(':') => match port.parse() {
                Ok(port) => Target {
                    host: host.to_string(),
                    port: Some(port),
                },
                Err(_) => whole(),
            },
            _ => whole(),
        }
    }

    fn ssh(&self) -> Command {
        let mut ssh = Command::new("ssh");
        if let Some(port) = self.port {
            ssh.arg("-p").arg(port.to_string());
        }
        ssh
    }

    /// The host's token, read from the far side rather than pasted about.
    ///
    /// It is the same secret either way; the difference is that a token which
    /// travels by scrollback and clipboard ends up in both, and this one never
    /// leaves the two machines that need it.
    pub async fn token(&self) -> Result<String> {
        let out = tokio::process::Command::from(self.ssh())
            .arg(&self.host)
            .arg("cat ~/.devpipe/token")
            .stderr(Stdio::inherit())
            .output()
            .await
            .context("could not run ssh")?;
        if !out.status.success() {
            bail!(
                "could not read ~/.devpipe/token on {}; pass --token if the host keeps its state elsewhere",
                self.host
            );
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if token.is_empty() {
            bail!("~/.devpipe/token on {} is empty", self.host);
        }
        Ok(token)
    }

    /// Forward a local port to the daemon's loopback port on the far side.
    pub async fn forward(&self, remote_port: u16) -> Result<Tunnel> {
        let local = free_port()?;
        let mut ssh = self.ssh();
        ssh.arg("-N")
            // No remote command, no tty, and no escape character: this ssh
            // exists to carry bytes, and a stray `~.` in a pane is somebody's
            // keystroke rather than a request to hang up.
            .arg("-T")
            .arg("-e")
            .arg("none")
            // Without this ssh happily connects while the forward has failed,
            // and the failure arrives later as a refused websocket.
            .arg("-o")
            .arg("ExitOnForwardFailure=yes")
            // A tunnel that has silently died looks exactly like an idle one,
            // and the pane above it would hang rather than say so.
            .arg("-o")
            .arg("ServerAliveInterval=15")
            .arg("-o")
            .arg("ServerAliveCountMax=3")
            .arg("-L")
            .arg(format!("127.0.0.1:{local}:127.0.0.1:{remote_port}"))
            .arg(&self.host)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());

        let mut child = ssh.spawn().context("could not run ssh")?;
        let deadline = Instant::now() + PATIENCE;
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", local))
                .await
                .is_ok()
            {
                return Ok(Tunnel {
                    child,
                    url: format!("ws://127.0.0.1:{local}"),
                });
            }
            // ssh giving up is the common case — a wrong hostname, a refused
            // key — and it has already said why on stderr.
            if let Ok(Some(status)) = child.try_wait() {
                bail!("ssh to {} exited ({status})", self.host);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                bail!("ssh to {} did not open the forward in time", self.host);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Ask the kernel for a port and immediately give it back. There is a window
/// between here and ssh binding it, and nothing portable closes it — but the
/// alternative is a fixed port, which collides with the last tunnel that has
/// not finished dying.
fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_can_carry_the_ssh_port() {
        let t = Target::parse("wess@box:2222");
        assert_eq!(t.host, "wess@box");
        assert_eq!(t.port, Some(2222));
    }

    #[test]
    fn a_plain_host_keeps_the_default_port() {
        let t = Target::parse("box");
        assert_eq!(t.host, "box");
        assert_eq!(t.port, None);
    }

    /// An IPv6 literal has several colons and none of them are a port, so the
    /// last one must not be read as one.
    #[test]
    fn an_address_full_of_colons_keeps_all_of_them() {
        let t = Target::parse("fe80::1");
        assert_eq!(t.host, "fe80::1");
        assert_eq!(t.port, None);
    }

    /// Brackets are the only way such an address can also name a port.
    #[test]
    fn brackets_are_how_a_literal_address_names_its_port() {
        let t = Target::parse("[fe80::1]:2222");
        assert_eq!(t.host, "fe80::1");
        assert_eq!(t.port, Some(2222));
    }
}
