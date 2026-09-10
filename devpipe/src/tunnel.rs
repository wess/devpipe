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
        self.forwarding(&[(local, remote_port)], local).await
    }

    /// The same, for several ports at once, over one ssh.
    ///
    /// One connection rather than one per port: each is a handshake and a
    /// process, and somebody forwarding a web server, an API and a debugger
    /// should not pay for three.
    pub async fn forward_all(&self, pairs: &[(u16, u16)]) -> Result<Tunnel> {
        let first = pairs.first().map(|(local, _)| *local).unwrap_or(0);
        self.forwarding(pairs, first).await
    }

    /// `pairs` are (local, remote); `ready` is the local port to watch for, as
    /// the sign that ssh has finished authenticating and opened the forwards.
    async fn forwarding(&self, pairs: &[(u16, u16)], ready: u16) -> Result<Tunnel> {
        if pairs.is_empty() {
            bail!("nothing to forward");
        }
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
            .arg("ServerAliveCountMax=3");
        for (local, remote) in pairs {
            ssh.arg("-L")
                .arg(format!("127.0.0.1:{local}:127.0.0.1:{remote}"));
        }
        ssh.arg(&self.host)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());

        let mut child = ssh.spawn().context("could not run ssh")?;
        let deadline = Instant::now() + PATIENCE;
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", ready))
                .await
                .is_ok()
            {
                return Ok(Tunnel {
                    child,
                    url: format!("ws://127.0.0.1:{ready}"),
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

impl Tunnel {
    /// Whether ssh has gone. A forward whose carrier died looks exactly like an
    /// idle one from the outside, and the command holding it should say so
    /// rather than sit there looking busy.
    pub fn has_gone(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
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
pub fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Whether this machine would let ssh bind that port.
///
/// Worth knowing before ssh is started rather than after: `ExitOnForwardFailure`
/// makes a taken port kill the whole connection, and the error it prints is
/// about the connection rather than about the port somebody chose.
pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// One port somebody asked to reach: where it should land here, and what it is
/// called inside the environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asked {
    pub here: Option<u16>,
    pub inside: u16,
}

/// `3000`, or `8080:3000` for "port 8080 here, 3000 in there".
pub fn parse_port(given: &str) -> Result<Asked> {
    let port = |text: &str| -> Result<u16> {
        text.parse()
            .with_context(|| format!("{text} is not a port number"))
    };
    Ok(match given.split_once(':') {
        Some((here, inside)) => Asked {
            here: Some(port(here)?),
            inside: port(inside)?,
        },
        None => Asked {
            here: None,
            inside: port(given)?,
        },
    })
}

/// Match what was asked for against what the environment actually publishes.
///
/// A port is published when the environment is *made*, because that is when
/// the container is created and a container's published ports cannot change
/// afterwards. So the failure here is common and worth a sentence somebody can
/// act on rather than an empty refusal.
pub fn resolve(
    name: &str,
    published: &[crate::backend::PortMap],
    asked: &[Asked],
) -> Result<Vec<(Asked, u16)>> {
    if published.is_empty() {
        bail!(
            "{name} publishes no ports, and a container's are fixed when it is made: \
             `dp new <machine>/<name> --port 3000`"
        );
    }
    let mut found = Vec::new();
    for want in asked {
        match published.iter().find(|p| p.inside == want.inside) {
            Some(mapped) => found.push((*want, mapped.outside)),
            None => {
                let has: Vec<String> = published.iter().map(|p| p.inside.to_string()).collect();
                bail!(
                    "{name} does not publish {}; it publishes {}",
                    want.inside,
                    has.join(", ")
                );
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::PortMap;

    fn published(pairs: &[(u16, u16)]) -> Vec<PortMap> {
        pairs
            .iter()
            .map(|(inside, outside)| PortMap {
                inside: *inside,
                outside: *outside,
            })
            .collect()
    }

    #[test]
    fn a_bare_number_is_the_port_at_both_ends() {
        assert_eq!(
            parse_port("3000").unwrap(),
            Asked {
                here: None,
                inside: 3000
            }
        );
    }

    #[test]
    fn a_colon_moves_it_to_a_different_port_here() {
        assert_eq!(
            parse_port("8080:3000").unwrap(),
            Asked {
                here: Some(8080),
                inside: 3000
            }
        );
    }

    #[test]
    fn something_that_is_not_a_port_says_which_half_was_wrong() {
        let said = parse_port("web:3000").unwrap_err().to_string();
        assert!(said.contains("web"), "{said}");
    }

    /// The environment's own number is what the person knows; the host port is
    /// the kernel's business and they should never have to see it.
    #[test]
    fn asking_for_the_inside_port_finds_the_host_port() {
        let found = resolve(
            "api",
            &published(&[(3000, 32768), (5432, 32769)]),
            &[Asked {
                here: None,
                inside: 5432,
            }],
        )
        .unwrap();
        assert_eq!(found[0].1, 32769);
    }

    /// A container's published ports are fixed when it is created, so this is
    /// the common mistake rather than an exotic one.
    #[test]
    fn a_port_that_is_not_published_names_the_ones_that_are() {
        let said = resolve(
            "api",
            &published(&[(3000, 32768)]),
            &[Asked {
                here: None,
                inside: 8080,
            }],
        )
        .unwrap_err()
        .to_string();
        assert!(said.contains("api does not publish 8080"), "{said}");
        assert!(said.contains("publishes 3000"), "{said}");
    }

    #[test]
    fn an_environment_with_no_ports_says_why_rather_than_nothing() {
        let said = resolve("api", &[], &[]).unwrap_err().to_string();
        assert!(said.contains("api publishes no ports"), "{said}");
        assert!(said.contains("--port"), "{said}");
    }

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
