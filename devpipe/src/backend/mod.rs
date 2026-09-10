//! What an environment actually runs on.
//!
//! The point of this trait is that Devpipe stops equating an environment with
//! a machine. An environment is a workspace, a process tree, a private port
//! space and the toolchain to build with — all of which a container gives you
//! in about a second, where a VPS took three minutes and left a block volume
//! and a snapshot to reconcile afterwards.
//!
//! `stop` and `start` are the sleep/wake pair, and how much survives between
//! them is the backend's business. A container keeps the filesystem and loses
//! the processes. A microVM backend, when there is one, keeps memory too — so
//! waking finds the dev server still listening. Nothing above this trait has
//! to know the difference, which is the whole reason it is a trait.

use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

pub mod docker;
pub mod local;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The backend has never made this, or it has been destroyed under us.
    Absent,
    /// The workspace is intact; nothing is running.
    Stopped,
    Running,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Absent => "absent",
            Status::Stopped => "stopped",
            Status::Running => "running",
        }
    }
}

/// Everything needed to rebuild an environment from nothing but the state
/// file. Deliberately serialisable: a host restart must not lose track of
/// what it is holding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSpec {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub image: String,
    /// A plain directory on the host. This is the whole persistence story, and
    /// it is deliberately boring — the old design's block volumes had to be
    /// claimed, released, and reconciled, and a bug in that made every slept
    /// box unwakeable.
    pub workspace: PathBuf,
    /// Ports the environment listens on inside itself. Two environments can
    /// both want 3000; each gets its own namespace and a host port assigned
    /// by the kernel.
    #[serde(default)]
    pub ports: Vec<u16>,
    /// How much memory this environment may use, docker-style: `1g`, `512m`.
    ///
    /// The failure this prevents is specific and total. An agent runs a build,
    /// the build takes every page on a small machine, the kernel picks a
    /// victim, and on a box where the daemon *is* the product the victim is
    /// often `devpipe serve` — which takes every session on the host with it.
    /// A limit turns that into one container dying, which is a thing somebody
    /// can read about afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PortMap {
    pub inside: u16,
    pub outside: u16,
}

/// How to run something in an environment, from the host's side of the
/// boundary: an argv to spawn here, and the environment to spawn it with.
///
/// Both halves, because the two backends disagree about which one carries a
/// secret. A container takes it as `--env` flags in the argv, since the
/// process being spawned is the runtime CLI rather than the user's command.
/// Bridge mode has no boundary to cross, so it goes in the process
/// environment. Nothing above this has to know which.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Where the process starts. A container is told at exec time and so
    /// leaves this empty; bridge mode has to say it, or a session opens
    /// wherever the daemon happened to be started from.
    pub cwd: Option<PathBuf>,
}

#[async_trait::async_trait]
pub trait Backend: Send + Sync {
    fn kind(&self) -> &'static str;

    /// Make it exist without running it.
    async fn create(&self, spec: &EnvSpec) -> Result<()>;

    /// Wake. Cheap by construction: there is no machine to boot.
    async fn start(&self, spec: &EnvSpec) -> Result<()>;

    /// Sleep. Must leave the workspace exactly as it was.
    async fn stop(&self, spec: &EnvSpec) -> Result<()>;

    /// Give the compute back for good. The workspace directory outlives this
    /// on purpose — losing somebody's files should take more than one verb.
    async fn destroy(&self, spec: &EnvSpec) -> Result<()>;

    async fn status(&self, spec: &EnvSpec) -> Result<Status>;

    async fn ports(&self, spec: &EnvSpec) -> Result<Vec<PortMap>>;

    /// How to land a process inside the environment, interactively. The pty
    /// machinery never learns what a container is: it spawns whatever this
    /// returns and the boundary is somebody else's problem.
    ///
    /// `secrets` are the host's, handed to the environment at the moment a
    /// session starts rather than when it was created — see `secrets.rs` for
    /// why that ordering is the whole point.
    fn enter(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry;

    /// The same, for a command with nobody watching: setup, a clone, a probe.
    /// Separate from `enter` because an interactive exec asks for a tty, and a
    /// tty is exactly wrong for something whose output is going to be parsed.
    fn run_in(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry;
}

/// Run something inside an environment and wait for it, with the output going
/// nowhere. For the short administrative commands — `git clone`, a setup
/// line — that have to finish before the caller can answer.
pub async fn run_inside(
    backend: &dyn Backend,
    spec: &EnvSpec,
    argv: &[String],
    secrets: &[(String, String)],
) -> Result<()> {
    let entry = backend.run_in(spec, argv, secrets);
    let mut command = tokio::process::Command::new(&entry.argv[0]);
    command.args(&entry.argv[1..]);
    for (k, v) in &entry.env {
        command.env(k, v);
    }
    if let Some(cwd) = &entry.cwd {
        command.current_dir(cwd);
    }
    let done = command.output().await?;
    if !done.status.success() {
        let complaint = String::from_utf8_lossy(&done.stderr);
        let complaint = complaint.trim();
        // The command's own words, not the runtime's wrapper around them: a
        // failed clone should read like a failed clone.
        anyhow::bail!(
            "{} failed inside the environment: {}",
            argv.join(" "),
            if complaint.is_empty() {
                "no output"
            } else {
                complaint
            }
        );
    }
    Ok(())
}

/// Run a command and hand back stdout, or the tool's own complaint. Backends
/// here drive CLIs rather than daemon sockets: one dependency instead of an
/// API surface per container runtime, and the CLI is the part that stays
/// stable across podman and docker.
pub(crate) async fn output(argv: &[String]) -> Result<String> {
    let done = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .output()
        .await?;
    if !done.status.success() {
        anyhow::bail!(
            "{} failed: {}",
            argv.join(" "),
            String::from_utf8_lossy(&done.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&done.stdout).trim().to_string())
}
