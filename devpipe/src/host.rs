//! A machine that holds environments.
//!
//! The difference this iteration is built around: a host is not an
//! environment. Several live here at once and the expensive thing — the
//! machine — is provisioned once and shared, rather than once per environment
//! at three minutes and a block volume each.
//!
//! One customer per host is the tenancy this assumes. The wall between
//! environments here separates a person's own projects, not strangers, which
//! is why a container is the right size of boundary and a microVM would be
//! defending against a threat that is not present.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::backend::{Backend, EnvSpec};
use crate::environment::Environment;
use crate::keeper;
use crate::proto::{FromServer, HostInfo};
use crate::secrets::Secrets;

/// Pane kinds this build serves. A client is told this list and refused
/// anything outside it by name, so an old daemon and a new client disagree
/// loudly rather than hanging.
pub const PANES: &[&str] = &["pty"];

/// What survives a restart of `devpipe serve`. Sessions are not in here
/// because they are not this process's to remember: each is a keeper holding
/// its own pty, and the sockets in the runtime directory are the list.
#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    id: String,
    /// The image `env new` reaches for when nobody names one. Persisted so a
    /// host restarted without the flag does not quietly change what a new
    /// environment is made of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    memory: Option<String>,
    environments: Vec<EnvSpec>,
}

pub struct Host {
    pub id: String,
    token: String,
    image: String,
    /// The per-environment memory ceiling this host hands out when nobody
    /// names one. Unset means no limit, which is right on a workstation and
    /// wrong on anything small.
    memory: Option<String>,
    backend: Arc<dyn Backend>,
    state: PathBuf,
    secrets: Arc<Secrets>,
    /// Where this host's session keepers put their sockets. Named after the
    /// host so two of them on one machine — which is what a test run is — do
    /// not find each other's sessions.
    runtime: PathBuf,
    keeper: PathBuf,
    /// What has changed here lately. Every connection that asked to watch
    /// holds a receiver; a host with nobody watching drops what it sends,
    /// which is the behaviour that keeps this free when it is not being used.
    news: broadcast::Sender<FromServer>,
    environments: Mutex<HashMap<String, Arc<Environment>>>,
}

/// How far behind a watcher may fall before it is dropped rather than
/// slowed. These are small JSON messages and a client this far behind has
/// stopped reading; the tree it is drawing is already wrong.
const NEWS_BACKLOG: usize = 64;

impl Host {
    pub async fn open(
        dir: &Path,
        backend: Arc<dyn Backend>,
        token: Option<String>,
        image: Option<String>,
        memory: Option<String>,
        // `keeper` is the devpipe binary that will hold this host's sessions.
        // `None` means this process, which is right for the daemon and wrong
        // for a test harness — see `Environment::keeper`.
        keeper: Option<PathBuf>,
    ) -> Result<Arc<Host>> {
        tokio::fs::create_dir_all(dir).await?;
        let state = dir.join("host.json");
        let loaded: State = match tokio::fs::read(&state).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => State::default(),
        };
        let token = match token {
            Some(given) => given,
            None => resolve_token(dir)?,
        };
        let secrets = Arc::new(Secrets::at(dir));
        let news = broadcast::channel(NEWS_BACKLOG).0;
        let id = if loaded.id.is_empty() {
            random_id(8)
        } else {
            loaded.id
        };
        let runtime = keeper::runtime_dir(&id);
        tokio::fs::create_dir_all(&runtime).await?;
        let keeper = match keeper {
            Some(given) => given,
            None => std::env::current_exe()
                .context("cannot find my own binary, and sessions are started with it")?,
        };

        let host = Arc::new(Host {
            id: id.clone(),
            token,
            image: image
                .or(loaded.image)
                .unwrap_or_else(|| DEFAULT_IMAGE.to_string()),
            memory: memory.or(loaded.memory),
            backend: backend.clone(),
            state,
            secrets: secrets.clone(),
            runtime: runtime.clone(),
            keeper: keeper.clone(),
            news: news.clone(),
            environments: Mutex::new(HashMap::new()),
        });

        // Adopt what the last run was holding. The containers are still there;
        // this only re-learns their names.
        let mut adopted = HashMap::new();
        for spec in loaded.environments {
            adopted.insert(
                spec.id.clone(),
                Environment::new(
                    spec,
                    backend.clone(),
                    secrets.clone(),
                    runtime.clone(),
                    keeper.clone(),
                    news.clone(),
                ),
            );
        }
        *host.environments.lock().unwrap() = adopted;
        // Sessions that outlived the last daemon are watched by this one, or
        // the first thing anybody notices about them is that they stopped
        // being listed.
        for environment in host.all() {
            environment.watch_what_is_already_running();
        }
        host.save().await?;
        Ok(host)
    }

    pub fn secrets(&self) -> &Arc<Secrets> {
        &self.secrets
    }

    /// Everything that changes here from now on.
    pub fn news(&self) -> broadcast::Receiver<FromServer> {
        self.news.subscribe()
    }

    /// Tell whoever is watching. Errors mean nobody is, which is not an error.
    pub fn announce(&self, said: FromServer) {
        let _ = self.news.send(said);
    }

    pub async fn announce_environment(&self, which: &Arc<Environment>) {
        self.announce(FromServer::Environment {
            environment: which.describe().await,
        });
    }

    /// The image a nameless `env new` gets.
    pub fn image(&self) -> &str {
        &self.image
    }

    /// Where this host's keepers put their sockets.
    pub fn runtime(&self) -> &Path {
        &self.runtime
    }

    /// Constant time, because the obvious `==` leaks the token one byte per
    /// reconnect to anyone who can time the handshake.
    pub fn authenticate(&self, presented: &str) -> bool {
        self.token.as_bytes().ct_eq(presented.as_bytes()).into()
    }

    pub fn workspaces(&self) -> PathBuf {
        self.state
            .parent()
            .unwrap_or(Path::new("."))
            .join("workspaces")
    }

    pub async fn create(
        &self,
        name: String,
        image: Option<String>,
        ports: Vec<u16>,
        workspace: Option<PathBuf>,
        memory: Option<String>,
    ) -> Result<Arc<Environment>> {
        // A name is not a label on a shelf: it becomes part of a hostname —
        // `<project>.<user>.devpipe.com`, or the path under it — so anything
        // DNS cannot carry has to be refused here, where the person who typed
        // it is still watching.
        valid_name(&name)?;
        if self.find(&name).is_some() {
            bail!("an environment called {name} is already here");
        }
        // Nothing separates two local environments — same ports, same files,
        // same processes — so offering a second one would only be a way to
        // lose work.
        if self.backend.kind() == "local" && !self.environments.lock().unwrap().is_empty() {
            bail!("the local backend holds one environment; it is the host");
        }

        let id = random_id(6);
        let spec = EnvSpec {
            workspace: workspace.unwrap_or_else(|| self.workspaces().join(&id)),
            id: id.clone(),
            name,
            backend: self.backend.kind().to_string(),
            // Bridge mode has no image and saying otherwise would put a
            // container name next to an environment that is somebody's laptop.
            image: match image {
                Some(named) => named,
                None if self.backend.kind() == "local" => "host".into(),
                None => self.image.clone(),
            },
            ports,
            memory: memory.or_else(|| self.memory.clone()),
        };
        self.backend.create(&spec).await?;
        self.backend.start(&spec).await?;

        let environment = Environment::new(
            spec,
            self.backend.clone(),
            self.secrets.clone(),
            self.runtime.clone(),
            self.keeper.clone(),
            self.news.clone(),
        );
        self.environments
            .lock()
            .unwrap()
            .insert(id, environment.clone());
        self.save().await?;
        self.announce_environment(&environment).await;
        Ok(environment)
    }

    /// By id or by name, or the only one there is. Naming nothing is how
    /// bridge mode stays a one-word command.
    pub fn get(&self, which: Option<&str>) -> Result<Arc<Environment>> {
        match which {
            Some(which) => self
                .find(which)
                .with_context(|| format!("no environment {which}")),
            None => {
                let environments = self.environments.lock().unwrap();
                match environments.len() {
                    1 => Ok(environments.values().next().unwrap().clone()),
                    0 => bail!("no environments here yet"),
                    _ => {
                        // Naming them, because the next thing the person has
                        // to type is one of these and they are looking at this
                        // sentence rather than at the tree.
                        let mut names: Vec<&str> = environments
                            .values()
                            .map(|e| e.spec.name.as_str())
                            .collect();
                        names.sort();
                        bail!("say which environment: {}", names.join(", "))
                    }
                }
            }
        }
    }

    fn find(&self, which: &str) -> Option<Arc<Environment>> {
        let environments = self.environments.lock().unwrap();
        environments.get(which).cloned().or_else(|| {
            environments
                .values()
                .find(|e| e.spec.name == which)
                .cloned()
        })
    }

    pub async fn start(&self, which: &str) -> Result<Arc<Environment>> {
        let environment = self.get(Some(which))?;
        self.backend.start(&environment.spec).await?;
        self.announce_environment(&environment).await;
        Ok(environment)
    }

    pub async fn stop(&self, which: &str) -> Result<Arc<Environment>> {
        let environment = self.get(Some(which))?;
        // Sessions first: they are ptys into a thing that is about to not be
        // running, and leaving them would hand a client a live-looking pane
        // over a dead container.
        environment.close().await;
        self.backend.stop(&environment.spec).await?;
        self.announce_environment(&environment).await;
        Ok(environment)
    }

    pub async fn destroy(&self, which: &str) -> Result<String> {
        let environment = self.get(Some(which))?;
        environment.close().await;
        self.backend.destroy(&environment.spec).await?;
        let id = environment.spec.id.clone();
        self.environments.lock().unwrap().remove(&id);
        self.save().await?;
        self.announce(FromServer::EnvironmentGone { id: id.clone() });
        Ok(id)
    }

    pub fn all(&self) -> Vec<Arc<Environment>> {
        let mut listed: Vec<Arc<Environment>> = self
            .environments
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        listed.sort_by(|a, b| a.spec.name.cmp(&b.spec.name));
        listed
    }

    pub async fn describe(&self) -> HostInfo {
        let mut environments = Vec::new();
        for environment in self.all() {
            environments.push(environment.describe().await);
        }
        HostInfo {
            id: self.id.clone(),
            host: hostname(),
            backend: self.backend.kind().to_string(),
            panes: PANES.iter().map(|p| p.to_string()).collect(),
            image: self.image.clone(),
            secrets: self.secrets.names(),
            environments,
        }
    }

    async fn save(&self) -> Result<()> {
        let state = State {
            id: self.id.clone(),
            image: Some(self.image.clone()),
            memory: self.memory.clone(),
            environments: self.all().iter().map(|e| e.spec.clone()).collect(),
        };
        // Written whole and renamed: a host killed mid-write must come back to
        // the previous list rather than to half of this one.
        let scratch = self.state.with_extension("json.new");
        tokio::fs::write(&scratch, serde_json::to_vec_pretty(&state)?).await?;
        tokio::fs::rename(&scratch, &self.state).await?;
        Ok(())
    }
}

/// Environment names travel into DNS, so they are DNS labels: lowercase,
/// alphanumeric and hyphens, no leading or trailing hyphen, 63 characters at
/// the outside. Enforced at creation rather than at routing, because by
/// routing time the name is in a state file and somebody's muscle memory.
pub fn valid_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 63 {
        bail!("a name has to be 1 to 63 characters");
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        bail!("a name can hold lowercase letters, digits and hyphens");
    }
    if name.starts_with('-') || name.ends_with('-') {
        bail!("a name cannot start or end with a hyphen");
    }
    Ok(())
}

/// The image built by `deploy/docker/base.Dockerfile`: Debian with the
/// toolchains an agent needs already on it, because the alternative is
/// spending the first five minutes of every new environment on `apt`.
/// `devpipe serve --image` overrides it for a host that wants something else.
pub const DEFAULT_IMAGE: &str = "ghcr.io/wess/devpipe-base:trixie";

/// The host's own secret, kept rather than minted per run.
///
/// A generated-every-boot token cannot be used by anything that restarts on
/// its own — a systemd unit, a machine coming back from a reboot — because
/// every client's saved token is wrong the moment it does. So it is written
/// once, 0600, beside the state it protects.
fn resolve_token(dir: &Path) -> Result<String> {
    let path = dir.join("token");
    if let Ok(found) = std::fs::read_to_string(&path) {
        let found = found.trim().to_string();
        if !found.is_empty() {
            return Ok(found);
        }
    }
    let minted = random_id(24);
    write_private(&path, minted.as_bytes())?;
    Ok(minted)
}

/// Write a file only its owner can read, and never leave a half-written one
/// where a reader might take it for the whole thing.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let scratch = path.with_extension("new");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        // Before the first byte, not after the last: a chmod that comes second
        // leaves a window where the secret is world-readable.
        .mode(0o600)
        .open(&scratch)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&scratch, path)?;
    Ok(())
}

/// Hex from the kernel. Not a uuid: these are read aloud, typed into a flag,
/// and compared by eye, so shorter is worth more than structure.
pub fn random_id(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // A machine that cannot produce randomness cannot hold a session secret
    // either, so failing here is correct.
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .expect("/dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".devpipe")
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
