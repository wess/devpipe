//! The machines this laptop knows about.
//!
//! A host does not know it is one of several — it holds environments and
//! answers for itself. Fanning out across four boxes is the client's job, and
//! this is the client's memory of which four.
//!
//! Deliberately a file a person can open. `~/.devpipe/machines.toml` is short,
//! and the thing it is most likely to hold is an ssh alias somebody already
//! has in `~/.ssh/config`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::client::Client;
use crate::proto::HostInfo;
use crate::tunnel::{Target, Tunnel};

pub const DEFAULT_PORT: u16 = 7455;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Machine {
    /// What you type. The first segment of every path.
    pub name: String,
    /// An ssh destination. Usually just the name again, because the name is
    /// usually already an alias in `~/.ssh/config`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<String>,
    /// For a host reached some other way — a daemon on this machine, or one
    /// already behind a tunnel somebody else set up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Absent means read it off the far side over ssh, which is the point of
    /// not having to keep it here. A relayed machine has to keep it: there is
    /// no ssh to read it over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// A relay this machine has dialled out to, for one it cannot be reached
    /// at directly. Slower and less private than ssh — the relay terminates
    /// TLS and so sees the token going past — and the only thing a browser can
    /// do. See `relay.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// The relay's own secret, which is not this machine's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_token: Option<String>,
    #[serde(default = "default_port", skip_serializing_if = "is_default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn is_default_port(port: &u16) -> bool {
    *port == DEFAULT_PORT
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default, rename = "machine")]
    machines: Vec<Machine>,
}

pub struct Machines {
    path: PathBuf,
    list: Vec<Machine>,
}

impl Machines {
    pub fn open(dir: &Path) -> Machines {
        let path = dir.join("machines.toml");
        let list = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| toml::from_str::<File>(&text).ok())
            .map(|f| f.machines)
            .unwrap_or_default();
        Machines { path, list }
    }

    pub fn all(&self) -> &[Machine] {
        &self.list
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn find(&self, name: &str) -> Option<&Machine> {
        self.list.iter().find(|m| m.name == name)
    }

    pub fn add(&mut self, machine: Machine) -> Result<()> {
        valid_name(&machine.name)?;
        if self.find(&machine.name).is_some() {
            bail!("there is already a machine called {}", machine.name);
        }
        self.list.push(machine);
        self.save()
    }

    pub fn forget(&mut self, name: &str) -> Result<()> {
        let before = self.list.len();
        self.list.retain(|m| m.name != name);
        if self.list.len() == before {
            bail!("no machine called {name}");
        }
        self.save()
    }

    fn save(&self) -> Result<()> {
        let text = toml::to_string_pretty(&File {
            machines: self.list.clone(),
        })?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // A token may be in here, so the same care as the daemon's own files.
        crate::host::write_private(&self.path, text.as_bytes())
    }
}

/// A machine name is the first segment of a path, so it cannot hold the
/// separator, and it should look like something a person meant to type.
pub fn valid_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("a machine needs a name");
    }
    if name.contains('/') {
        bail!("a machine name cannot contain a slash: it is the first part of a path");
    }
    Ok(())
}

/// Somewhere in the tree, written the way it is printed: `machine`,
/// `machine/environment`, `machine/environment/session`.
///
/// The tree is the whole interface, so what you read off it is what you type
/// back. Nothing here takes an id nobody can remember.
#[derive(Debug, Default, Clone)]
pub struct Spot {
    pub machine: Option<String>,
    pub environment: Option<String>,
    pub session: Option<String>,
}

impl Spot {
    /// Resolve a path against what is registered.
    ///
    /// A single unqualified word is the ambiguous case and it is worth being
    /// generous about: it is a machine if one is called that, and otherwise an
    /// environment on the only machine there is. With several machines and no
    /// match, saying so beats guessing.
    pub fn parse(given: &str, machines: &Machines) -> Result<Spot> {
        let mut parts = given.split('/').filter(|p| !p.is_empty());
        let Some(first) = parts.next() else {
            return Ok(Spot::default());
        };
        let second = parts.next();
        let third = parts.next();
        if parts.next().is_some() {
            bail!("a path is machine/environment/session, no deeper");
        }

        if second.is_some() || machines.find(first).is_some() {
            return Ok(Spot {
                machine: Some(first.to_string()),
                environment: second.map(str::to_string),
                session: third.map(str::to_string),
            });
        }

        match machines.all() {
            [only] => Ok(Spot {
                machine: Some(only.name.clone()),
                environment: Some(first.to_string()),
                session: None,
            }),
            [] => bail!("no machines yet — `devpipe add <name>` first"),
            several => {
                let names: Vec<&str> = several.iter().map(|m| m.name.as_str()).collect();
                bail!(
                    "no machine called {first}; say which one: {}",
                    names
                        .iter()
                        .map(|n| format!("{n}/{first}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        }
    }

    /// The machine this points at, when it has to point at exactly one.
    pub fn machine<'a>(&self, machines: &'a Machines) -> Result<&'a Machine> {
        match &self.machine {
            Some(name) => machines
                .find(name)
                .with_context(|| format!("no machine called {name}")),
            None => match machines.all() {
                [only] => Ok(only),
                [] => bail!("no machines yet — `devpipe add <name>` first"),
                several => {
                    let names: Vec<&str> = several.iter().map(|m| m.name.as_str()).collect();
                    bail!("say which machine: {}", names.join(", "))
                }
            },
        }
    }
}

/// An open connection to one machine, and the tunnel keeping it open.
pub struct Reached {
    pub client: Client,
    pub host: HostInfo,
    /// Dropped last. Taking this away closes the forward the client is using.
    pub tunnel: Option<Tunnel>,
}

impl Machine {
    /// Named for what a person would call it, which is the ssh alias when
    /// there is one.
    pub fn describe_route(&self) -> String {
        match (&self.ssh, &self.relay, &self.url) {
            (Some(ssh), _, _) => format!("ssh {ssh}"),
            (None, Some(relay), _) => format!("relay {relay}"),
            (None, None, Some(url)) => url.clone(),
            (None, None, None) => "unreachable: no ssh target, no relay and no url".into(),
        }
    }

    /// Everything needed to open a socket to this machine, and the tunnel
    /// that has to stay alive while it is open.
    ///
    /// Separate from `reach` because `attach` opens its own socket and needs
    /// the two halves apart, while everything else just wants a client.
    pub async fn route(&self) -> Result<(String, String, Option<Tunnel>)> {
        match (&self.ssh, &self.url) {
            (Some(ssh), _) => {
                let target = Target::parse(ssh);
                let token = match &self.token {
                    Some(token) => token.clone(),
                    None => target.token().await?,
                };
                let tunnel = target.forward(self.port).await?;
                Ok((tunnel.url.clone(), token, Some(tunnel)))
            }
            (None, Some(url)) => {
                let token = self
                    .token
                    .clone()
                    .with_context(|| format!("{} has a url but no token", self.name))?;
                Ok((url.clone(), token, None))
            }
            (None, None) => bail!("{} has no ssh target and no url", self.name),
        }
    }

    pub async fn reach(&self) -> Result<Reached> {
        if let Some(relay) = &self.relay {
            let token = self
                .token
                .clone()
                .with_context(|| format!("{} is relayed and needs its host token", self.name))?;
            let secret = self
                .relay_token
                .clone()
                .with_context(|| format!("{} needs the relay's token", self.name))?;
            let socket = crate::relay::reach(relay, &secret, &self.name).await?;
            let (client, host) = Client::over(socket, &token).await?;
            return Ok(Reached {
                client,
                host,
                tunnel: None,
            });
        }
        let (url, token, tunnel) = self.route().await?;
        let (client, host) = Client::connect(&url, &token).await?;
        Ok(Reached {
            client,
            host,
            tunnel,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(names: &[&str]) -> Machines {
        Machines {
            path: PathBuf::from("/dev/null"),
            list: names
                .iter()
                .map(|n| Machine {
                    name: n.to_string(),
                    ssh: Some(n.to_string()),
                    url: None,
                    token: None,
                    relay: None,
                    relay_token: None,
                    port: DEFAULT_PORT,
                })
                .collect(),
        }
    }

    #[test]
    fn a_full_path_is_read_left_to_right() {
        let spot = Spot::parse("box-a/api/abc123", &registry(&["box-a"])).unwrap();
        assert_eq!(spot.machine.as_deref(), Some("box-a"));
        assert_eq!(spot.environment.as_deref(), Some("api"));
        assert_eq!(spot.session.as_deref(), Some("abc123"));
    }

    /// One word that names a machine is that machine, even when an
    /// environment somewhere shares the name. The tree prints machines at the
    /// left margin, so that is what the eye read.
    #[test]
    fn a_known_machine_wins_the_bare_word() {
        let spot = Spot::parse("box-a", &registry(&["box-a", "box-b"])).unwrap();
        assert_eq!(spot.machine.as_deref(), Some("box-a"));
        assert_eq!(spot.environment, None);
    }

    /// With one machine there is nothing to disambiguate, and making somebody
    /// type its name every time would be a tax on the common case.
    #[test]
    fn one_machine_makes_the_machine_optional() {
        let spot = Spot::parse("api", &registry(&["only"])).unwrap();
        assert_eq!(spot.machine.as_deref(), Some("only"));
        assert_eq!(spot.environment.as_deref(), Some("api"));
    }

    /// With several, guessing would attach somebody to the wrong box. The
    /// refusal spells out what to type instead.
    #[test]
    fn several_machines_make_a_bare_word_an_error_that_helps() {
        let refused = Spot::parse("api", &registry(&["box-a", "box-b"])).unwrap_err();
        let said = refused.to_string();
        assert!(said.contains("box-a/api"), "{said}");
        assert!(said.contains("box-b/api"), "{said}");
    }

    #[test]
    fn a_path_is_three_deep_at_most() {
        assert!(Spot::parse("a/b/c/d", &registry(&["a"])).is_err());
    }
}
