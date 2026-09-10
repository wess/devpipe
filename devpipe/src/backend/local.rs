//! The host itself, unmediated.
//!
//! This is bridge mode: a machine somebody already owns, running one
//! environment that *is* that machine. There is no isolation here and none is
//! wanted — the user is the tenant, and a container would only put a wall
//! between them and their own files.
//!
//! It is the wrong backend for a host holding several environments. Nothing
//! separates their ports, their files or their processes, so `serve` refuses
//! to make a second one.

use std::path::PathBuf;

use anyhow::Result;

use super::{Backend, Entry, EnvSpec, PortMap, Status};

pub struct Local;

#[async_trait::async_trait]
impl Backend for Local {
    fn kind(&self) -> &'static str {
        "local"
    }

    async fn create(&self, spec: &EnvSpec) -> Result<()> {
        tokio::fs::create_dir_all(&spec.workspace).await?;
        Ok(())
    }

    async fn start(&self, _spec: &EnvSpec) -> Result<()> {
        Ok(())
    }

    /// A no-op rather than a lie about killing things: the host does not stop
    /// because an environment on it was asked to.
    async fn stop(&self, _spec: &EnvSpec) -> Result<()> {
        Ok(())
    }

    async fn destroy(&self, _spec: &EnvSpec) -> Result<()> {
        Ok(())
    }

    async fn status(&self, spec: &EnvSpec) -> Result<Status> {
        Ok(if spec.workspace.exists() {
            Status::Running
        } else {
            Status::Absent
        })
    }

    /// Whatever is listening is already on the host's own ports; there is no
    /// mapping to report.
    async fn ports(&self, _spec: &EnvSpec) -> Result<Vec<PortMap>> {
        Ok(Vec::new())
    }

    /// No boundary to cross, so the argv is the argv and the host's secrets
    /// are simply this process's environment. A shell here is the user's own —
    /// bridge mode is somebody's actual machine, and giving them `/bin/sh`
    /// when they live in zsh would be the daemon overriding a preference it
    /// has no business having.
    fn enter(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry {
        Entry {
            argv: argv.to_vec(),
            env: secrets.to_vec(),
            cwd: Some(spec.workspace.clone()),
        }
    }

    fn run_in(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry {
        Entry {
            argv: argv.to_vec(),
            env: secrets.to_vec(),
            cwd: Some(spec.workspace.clone()),
        }
    }
}

pub fn workspace_default() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}
