//! An environment as a container.
//!
//! The container is a place to live, not a command to run: it is created with
//! `tail -f /dev/null` and everything real arrives later through `docker
//! exec`. That is what makes an environment hold *several* things — a harness,
//! a dev server, a language server — instead of being one process's lifetime.
//!
//! Talks to the CLI rather than the daemon socket. One binary to depend on
//! instead of an API surface per runtime, and it is the half of docker that
//! podman actually matches.

use anyhow::Result;

use super::{Backend, Entry, EnvSpec, PortMap, Status, output};

pub struct Docker {
    /// `docker` or `podman`. They differ in ways that matter elsewhere and
    /// not at all in the seven verbs used here.
    pub cli: String,
}

impl Docker {
    pub fn new(cli: impl Into<String>) -> Docker {
        Docker { cli: cli.into() }
    }

    fn container(spec: &EnvSpec) -> String {
        format!("devpipe-{}", spec.id)
    }

    fn argv(&self, rest: &[&str]) -> Vec<String> {
        let mut argv = vec![self.cli.clone()];
        argv.extend(rest.iter().map(|a| a.to_string()));
        argv
    }

    /// The common prefix of every exec into an environment. Secrets ride in as
    /// `--env` rather than being baked in at create time, so a key rotated
    /// this morning reaches a container made last week.
    fn exec(&self, spec: &EnvSpec, secrets: &[(String, String)], tty: bool) -> Vec<String> {
        let mut argv = self.argv(&["exec", "--interactive"]);
        if tty {
            argv.push("--tty".into());
        }
        argv.push("--workdir".into());
        argv.push("/workspace".into());
        for (key, value) in secrets {
            argv.push("--env".into());
            // One argv element, so a value with spaces, quotes or an `=` in it
            // reaches the process as itself. Nothing is going through a shell.
            argv.push(format!("{key}={value}"));
        }
        argv.push(Self::container(spec));
        argv
    }

    /// The docker CLI prints a "What's next: try Docker Debug" advertisement
    /// after an interactive exec. It lands in the middle of somebody's
    /// session, and it is the host's tooling talking, not theirs.
    fn host_env() -> Vec<(String, String)> {
        vec![("DOCKER_CLI_HINTS".into(), "false".into())]
    }
}

#[async_trait::async_trait]
impl Backend for Docker {
    fn kind(&self) -> &'static str {
        "docker"
    }

    async fn create(&self, spec: &EnvSpec) -> Result<()> {
        tokio::fs::create_dir_all(&spec.workspace).await?;
        if self.status(spec).await? != Status::Absent {
            return Ok(());
        }

        let name = Self::container(spec);
        let mount = format!("{}:/workspace", spec.workspace.display());
        let mut argv = self.argv(&[
            "create",
            "--name",
            &name,
            "--label",
            "devpipe.environment=1",
            "--workdir",
            "/workspace",
            "--volume",
            &mount,
            // Reaps the zombies a long-lived container full of exec'd
            // processes will otherwise accumulate.
            "--init",
            // A fork bomb inside an environment should cost that environment,
            // not the machine's process table. High enough that no real
            // toolchain notices it.
            "--pids-limit",
            "4096",
        ]);
        if let Some(memory) = &spec.memory {
            argv.push("--memory".into());
            argv.push(memory.clone());
            // Deliberately not setting --memory-swap: with it unset the
            // container may swap, which on a small box is the difference
            // between a slow build and a failed one.
        }
        for port in &spec.ports {
            // An empty host port lets the kernel choose, which is the entire
            // point: every project wants 3000 and they cannot all have it.
            // Loopback-bound, because publishing an agent's dev server to the
            // world should be a separate decision.
            argv.push("--publish".into());
            argv.push(format!("127.0.0.1::{port}"));
        }
        // `tail -f /dev/null` rather than the image's own entrypoint: the
        // container is a room, and starting it must not start somebody's app.
        argv.push("--entrypoint".into());
        argv.push("tail".into());
        argv.push(spec.image.clone());
        argv.push("-f".into());
        argv.push("/dev/null".into());

        output(&argv).await?;
        Ok(())
    }

    async fn start(&self, spec: &EnvSpec) -> Result<()> {
        if self.status(spec).await? == Status::Absent {
            self.create(spec).await?;
        }
        output(&self.argv(&["start", &Self::container(spec)])).await?;
        Ok(())
    }

    async fn stop(&self, spec: &EnvSpec) -> Result<()> {
        if self.status(spec).await? == Status::Absent {
            return Ok(());
        }
        output(&self.argv(&["stop", &Self::container(spec)])).await?;
        Ok(())
    }

    async fn destroy(&self, spec: &EnvSpec) -> Result<()> {
        if self.status(spec).await? == Status::Absent {
            return Ok(());
        }
        // The workspace is a host directory and is not touched. Somebody
        // asking for the compute back has not asked to lose their work.
        output(&self.argv(&["rm", "--force", &Self::container(spec)])).await?;
        Ok(())
    }

    async fn status(&self, spec: &EnvSpec) -> Result<Status> {
        let argv = self.argv(&[
            "inspect",
            "--format",
            "{{.State.Running}}",
            &Self::container(spec),
        ]);
        // A missing container is a status, not a failure: it is how an
        // environment looks after `destroy`, or on a fresh host reading a
        // state file written by an older one.
        match output(&argv).await {
            Ok(said) if said.trim() == "true" => Ok(Status::Running),
            Ok(_) => Ok(Status::Stopped),
            Err(_) => Ok(Status::Absent),
        }
    }

    async fn ports(&self, spec: &EnvSpec) -> Result<Vec<PortMap>> {
        let mut mapped = Vec::new();
        for inside in &spec.ports {
            let argv = self.argv(&["port", &Self::container(spec), &format!("{inside}/tcp")]);
            let Ok(said) = output(&argv).await else {
                continue;
            };
            // "127.0.0.1:54321", and on some runtimes one line per family.
            if let Some(outside) = said
                .lines()
                .next()
                .and_then(|l| l.rsplit(':').next())
                .and_then(|p| p.trim().parse().ok())
            {
                mapped.push(PortMap {
                    inside: *inside,
                    outside,
                });
            }
        }
        Ok(mapped)
    }

    fn enter(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry {
        let mut entering = self.exec(spec, secrets, true);
        if argv.is_empty() {
            // The image decides what a shell is. `sh` is the one every image
            // has; anything better says so in DEVPIPE_SHELL, which the base
            // image sets and a borrowed `alpine` does not.
            entering.push("/bin/sh".into());
            entering.push("-c".into());
            entering.push("exec ${DEVPIPE_SHELL:-/bin/sh}".into());
        } else {
            entering.extend(argv.iter().cloned());
        }
        Entry {
            argv: entering,
            env: Self::host_env(),
            cwd: None,
        }
    }

    fn run_in(&self, spec: &EnvSpec, argv: &[String], secrets: &[(String, String)]) -> Entry {
        let mut running = self.exec(spec, secrets, false);
        running.extend(argv.iter().cloned());
        Entry {
            argv: running,
            env: Self::host_env(),
            cwd: None,
        }
    }
}
