//! One environment: its spec, its backend, and the sessions living in it.
//!
//! Sessions belong here rather than to a connection, so a client dropping off
//! a train costs nothing. They do not live *in* this process either: each is a
//! keeper holding a pty on the other side of a unix socket, which is what lets
//! them outlast the daemon that started them. See `keeper.rs`.
//!
//! Nothing about them is remembered in memory, then — the sockets in the
//! runtime directory are the list, and a daemon coming back up reads it the
//! same way the one before it did.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result, bail};

use tokio::sync::broadcast;

use crate::backend::{Backend, EnvSpec, run_inside};
use crate::keeper::{self, Link, Spec, Stirred};
use crate::proto::{EnvInfo, FromServer, SessionInfo};
use crate::secrets::Secrets;

pub struct Environment {
    pub spec: EnvSpec,
    backend: Arc<dyn Backend>,
    secrets: Arc<Secrets>,
    runtime: PathBuf,
    /// The devpipe binary to start keepers with. Passed in rather than looked
    /// up, because `current_exe` is the daemon in production and the test
    /// harness under `cargo test`, and only one of those understands `keep`.
    keeper: PathBuf,
    news: broadcast::Sender<FromServer>,
}

impl Environment {
    pub fn new(
        spec: EnvSpec,
        backend: Arc<dyn Backend>,
        secrets: Arc<Secrets>,
        runtime: PathBuf,
        keeper: PathBuf,
        news: broadcast::Sender<FromServer>,
    ) -> Arc<Environment> {
        Arc::new(Environment {
            spec,
            backend,
            secrets,
            runtime,
            keeper,
            news,
        })
    }

    /// Watch every session that is already here.
    ///
    /// Called when a daemon adopts what the last one left. Without it, a
    /// session started before the restart would sit in the tree until it ended
    /// and then stay there, because nothing was listening when it did.
    pub fn watch_what_is_already_running(self: &Arc<Self>) {
        for link in self.links() {
            self.watch(link);
        }
    }

    /// Report what one session does, for as long as it does anything.
    ///
    /// The whole `EnvInfo` goes out on every stir rather than a delta. It is a
    /// small message, a client can replace rather than reconcile, and a
    /// reconciler is a thing that drifts.
    fn watch(self: &Arc<Self>, link: Link) {
        let environment = self.clone();
        tokio::spawn(async move {
            let Ok(mut stirring) = link.watch().await else {
                return;
            };
            while let Some(stirred) = stirring.recv().await {
                let ending = matches!(stirred, Stirred::Ended);
                let _ = environment.news.send(FromServer::Environment {
                    environment: environment.describe().await,
                });
                if ending {
                    return;
                }
            }
            // The socket went without the keeper saying so — it was killed
            // rather than the child exiting. The session is gone either way
            // and the list has to stop showing it.
            let _ = environment.news.send(FromServer::Environment {
                environment: environment.describe().await,
            });
        });
    }

    /// Put a repository in the workspace, using the environment's own git and
    /// the host's own secrets — so a private clone works with the token that
    /// is already there and nothing has to be typed into a shell.
    pub async fn clone_repo(&self, repo: &str) -> Result<()> {
        // Cloning over somebody's files is not a thing to do quietly, and an
        // empty check here is cheaper than the alternative conversation.
        let mut existing = tokio::fs::read_dir(&self.spec.workspace).await?;
        if existing.next_entry().await?.is_some() {
            bail!("the workspace already has files in it");
        }
        run_inside(
            self.backend.as_ref(),
            &self.spec,
            // `--` because a repository argument beginning with a dash is
            // otherwise git's flag, and the URL came off a socket.
            &[
                "git".into(),
                "clone".into(),
                "--".into(),
                repo.into(),
                ".".into(),
            ],
            &self.secrets.load(),
        )
        .await
    }

    /// Attach to `session` if it is named and still answering, otherwise start
    /// one. Naming a session that has gone is an error rather than a silent
    /// new shell: the caller asked to resume something specific.
    pub async fn attach(
        self: &Arc<Self>,
        session: Option<&str>,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Link> {
        if let Some(id) = session {
            let link = Link {
                id: id.to_string(),
                path: keeper::socket_path(&self.runtime, &self.spec.id, id),
            };
            // A socket file whose keeper has gone is a file, and handing it
            // back would open a pane over nothing. A keeper whose child has
            // finished is still there, but resuming it is not a thing that
            // means anything.
            match link.detail().await {
                Some(found) if found.running => return Ok(link),
                Some(_) => bail!("that session has finished"),
                None => {
                    self.forget(&link);
                    bail!("no such session");
                }
            }
        }
        self.start_session(argv, cols, rows).await
    }

    /// Hand a keeper its pty and let go of it.
    ///
    /// The spec goes down the keeper's stdin rather than into its argv: it
    /// carries the host's secrets, and argv is readable by every process on
    /// the machine.
    async fn start_session(
        self: &Arc<Self>,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Link> {
        let id = crate::host::random_id(6);
        // The backend decides what "run this here" means. The keeper spawns a
        // pty around whatever this is and never learns there was a boundary.
        //
        // Secrets are read here rather than held: this is the moment a session
        // starts, and it is the only moment at which what the environment
        // knows is allowed to change.
        let entry = self.backend.enter(&self.spec, &argv, &self.lend(&id));
        let spec = Spec {
            id: id.clone(),
            environment: self.spec.id.clone(),
            argv: if argv.is_empty() {
                entry.argv.clone()
            } else {
                argv
            },
            entry,
            cols: cols.max(1),
            rows: rows.max(1),
        };

        let mut child = tokio::process::Command::new(&self.keeper)
            .arg("keep")
            .arg("--runtime-dir")
            .arg(&self.runtime)
            // Its own process group, so a signal aimed at the daemon — a
            // ctrl-c in the terminal it was started from — does not travel
            // into every session on the host.
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, so whatever a keeper has to say about failing to
            // start lands in the daemon's journal rather than nowhere.
            .stderr(Stdio::inherit())
            .spawn()
            .context("could not start a session keeper")?;

        {
            use tokio::io::AsyncWriteExt;
            let mut stdin = child.stdin.take().context("the keeper has no stdin")?;
            stdin.write_all(&serde_json::to_vec(&spec)?).await?;
            stdin.shutdown().await?;
        }

        // Wait for the keeper to say the socket is bound. The file appearing
        // and the socket accepting are not the same moment, and connecting
        // between them is a refused connection.
        let ready = {
            use tokio::io::AsyncBufReadExt;
            let stdout = child.stdout.take().context("the keeper has no stdout")?;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            tokio::time::timeout(std::time::Duration::from_secs(30), lines.next_line()).await
        };

        // Reaped, never waited on for its lifetime: the keeper is expected to
        // outlive this daemon, and a task that only collects the exit status
        // keeps it from becoming a zombie in the meantime.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        match ready {
            Ok(Ok(Some(_))) => {
                let link = Link {
                    id: id.clone(),
                    path: keeper::socket_path(&self.runtime, &self.spec.id, &id),
                };
                self.watch(Link {
                    id: link.id.clone(),
                    path: link.path.clone(),
                });
                let _ = self.news.send(FromServer::Environment {
                    environment: self.describe().await,
                });
                Ok(link)
            }
            Ok(Ok(None)) | Ok(Err(_)) => bail!("the session keeper stopped before it started"),
            Err(_) => bail!("the session keeper did not come up"),
        }
    }

    /// What the process inside gets in its environment: the host's secrets,
    /// and enough for anything in there to know where it is.
    ///
    /// `DEVPIPE_SESSION` matters more than it looks. A tool that knows it is
    /// on a remote machine can choose the login flow that works there — the
    /// difference between `codex login` (a callback to a localhost nobody can
    /// reach) and `codex login --device-auth` (a code you read out) is a flag,
    /// and something has to be able to tell.
    fn lend(&self, session: &str) -> Vec<(String, String)> {
        let mut lent = self.secrets.load();
        lent.push(("DEVPIPE".into(), "1".into()));
        lent.push(("DEVPIPE_SESSION".into(), session.to_string()));
        lent.push(("DEVPIPE_ENVIRONMENT".into(), self.spec.name.clone()));
        lent
    }

    /// Every session this environment still has a keeper for.
    pub fn links(&self) -> Vec<Link> {
        keeper::sockets_for(&self.runtime, &self.spec.id)
            .into_iter()
            .map(|(id, path)| Link { id, path })
            .collect()
    }

    pub async fn describe(&self) -> EnvInfo {
        let status = self
            .backend
            .status(&self.spec)
            .await
            .map(|s| s.as_str())
            .unwrap_or("unknown");
        let ports = self.backend.ports(&self.spec).await.unwrap_or_default();

        let mut sessions = Vec::new();
        for link in self.links() {
            // A keeper that does not answer has gone, and the socket it left
            // is litter. Clearing it here means the list is self-repairing
            // rather than needing a sweep nobody remembers to run.
            //
            // One that answers but is finished is neither: it is holding a
            // screen for a few more seconds. Not listed, and not deleted.
            match link.detail().await {
                Some(detail) if detail.running => sessions.push(SessionInfo {
                    id: detail.id,
                    title: detail.title,
                    cols: detail.cols,
                    rows: detail.rows,
                    argv: detail.argv,
                }),
                Some(_) => {}
                None => self.forget(&link),
            }
        }
        sessions.sort_by(|a, b| a.id.cmp(&b.id));

        EnvInfo {
            id: self.spec.id.clone(),
            name: self.spec.name.clone(),
            backend: self.spec.backend.clone(),
            image: self.spec.image.clone(),
            status: status.into(),
            workspace: self.spec.workspace.display().to_string(),
            memory: self.spec.memory.clone(),
            ports,
            sessions,
        }
    }

    /// Ends every session. Called when the environment underneath them is
    /// going away, because a pty into a stopped container is a pty into
    /// nothing.
    pub async fn close(&self) {
        for link in self.links() {
            link.kill().await;
        }
    }

    /// The same from a `Drop` or a teardown, where there is no runtime left to
    /// await on.
    pub fn close_now(&self) {
        for link in self.links() {
            link.kill_now();
        }
    }

    fn forget(&self, link: &Link) {
        let _ = std::fs::remove_file(&link.path);
    }
}
