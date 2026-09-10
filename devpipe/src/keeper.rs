//! Sessions that outlive the daemon.
//!
//! A pty spawned by `devpipe serve` is a child of `devpipe serve`, and every
//! restart of the daemon — an upgrade, a crash, `Restart=always` doing its job
//! — took every session on the host with it. That is a bad trade in a product
//! whose one promise is that closing something costs nothing.
//!
//! So the pty moves out. Each session gets a *keeper*: a small detached
//! process that owns the pty, mirrors the screen, and serves both over a unix
//! socket. `serve` becomes a relay between the websocket and that socket, and
//! holds nothing a restart can lose. The keeper outlives it, and the next
//! daemon finds the session by finding the socket.
//!
//! What this does not buy is survival of a reboot, or of the environment being
//! stopped — a pty into a container that is not running is a pty into nothing,
//! whoever is holding it. Those are honest limits: the keeper is on the host
//! side of the boundary, and the sockets live in a runtime directory that a
//! reboot clears, which is exactly the set of things that die together anyway.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

use crate::backend::Entry;
use crate::marker::{Marker, Scanner};
use crate::proto::{Frame, Op, PaneEvent};
use crate::session::Session;

/// Everything a keeper needs, handed to it on stdin rather than in argv:
/// secrets are in here, and argv is readable by every process on the machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub id: String,
    /// The environment this belongs to. Part of the socket's name, which is
    /// how a restarted daemon works out whose sessions these are.
    pub environment: String,
    /// What the user asked for, as opposed to the argv that carries it across
    /// the boundary. Only ever shown.
    pub argv: Vec<String>,
    pub entry: Entry,
    pub cols: u16,
    pub rows: u16,
}

/// What a client says first. Both are one round trip: an attach never ends,
/// and a describe answers and hangs up.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Asking {
    Attach {
        cols: u16,
        rows: u16,
    },
    Describe,
    /// Say nothing until something changes, then say it. One idle unix socket
    /// per session is what lets the daemon report a session ending while
    /// nobody is looking at it — the alternative is polling every environment
    /// on a timer and still being a second late.
    Watch,
    Kill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Saying {
    Info {
        id: String,
        argv: Vec<String>,
        title: String,
        cols: u16,
        rows: u16,
        /// False during the grace period: the child has gone but the final
        /// screen is still here to be read.
        running: bool,
    },
    Titled {
        title: String,
    },
    /// The child has gone. The socket closing says the same thing, but this
    /// says it deliberately, which is the difference between a session that
    /// ended and a keeper that was killed.
    Ended,
}

/// How long a keeper outlives its child.
///
/// The window this closes is small and completely ordinary: the daemon starts
/// a keeper, the keeper starts `ls`, and `ls` is finished before the daemon has
/// connected to read the output. Without the grace the socket is already gone
/// and the person gets an error instead of their output.
const GRACE: Duration = Duration::from_secs(10);

/// Where keepers put their sockets.
///
/// Not the state directory: these are runtime things, and the set of them that
/// is still meaningful after a reboot is empty. A runtime directory says that
/// in the filesystem instead of leaving stale sockets to be reasoned about.
/// The host id is in the path because two hosts on one machine — which is what
/// a test run is — must not find each other's sessions.
pub fn runtime_dir(host: &str) -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Not $TMPDIR: on macOS that is a long path per user, and a unix
            // socket path is 104 bytes including the terminator.
            PathBuf::from(format!("/tmp/devpipe-{}", unsafe { libc::getuid() }))
        });
    base.join(format!("devpipe-{host}"))
}

pub fn socket_path(dir: &Path, environment: &str, session: &str) -> PathBuf {
    dir.join(format!("{environment}-{session}.sock"))
}

/// The sessions a given environment still has keepers for. Read off the
/// filesystem rather than remembered, because the whole point is that this
/// survives the process that would have been doing the remembering.
pub fn sockets_for(dir: &Path, environment: &str) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|n| n.strip_suffix(".sock")) else {
            continue;
        };
        let Some(session) = name.strip_prefix(&format!("{environment}-")) else {
            continue;
        };
        found.push((session.to_string(), entry.path()));
    }
    found.sort();
    found
}

// ---------------------------------------------------------------- the keeper

/// The keeper process. Owns one pty for as long as its child lives, and
/// nothing else.
pub async fn run(dir: PathBuf) -> Result<()> {
    let mut spec = String::new();
    tokio::io::stdin().read_to_string(&mut spec).await?;
    let spec: Spec = serde_json::from_str(&spec).context("the keeper was handed no usable spec")?;

    tokio::fs::create_dir_all(&dir).await?;
    let path = socket_path(&dir, &spec.environment, &spec.id);
    // A socket left by a keeper that died without tidying up would refuse the
    // bind, and the session it belonged to is already gone.
    let _ = tokio::fs::remove_file(&path).await;
    let listener = UnixListener::bind(&path)?;

    let session = Session::spawn(
        spec.id.clone(),
        spec.entry.clone(),
        spec.cols.max(1),
        spec.rows.max(1),
    )?;

    // Announce readiness on stdout, so the daemon can wait for the socket to
    // be usable rather than for the file to exist — those are not the same
    // moment, and connecting between them is a refused connection.
    let mut out = tokio::io::stdout();
    out.write_all(b"ready\n").await?;
    out.flush().await?;
    drop(out);

    let live = Arc::new(AtomicUsize::new(0));
    let mut gone = session.alive_watch();
    // Already over. A command short enough to finish before its own keeper
    // finished starting is not exotic — `attach -- ls` is one — and the watch
    // reports state rather than transitions, so nothing would fire for it.
    let mut deadline = (!session.is_alive()).then(|| tokio::time::Instant::now() + GRACE);

    loop {
        let expiring = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let session = session.clone();
                let live = live.clone();
                live.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    serve_one(stream, session).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                });
            }
            _ = gone.changed(), if deadline.is_none() => {
                if !*gone.borrow() {
                    deadline = Some(tokio::time::Instant::now() + GRACE);
                }
            }
            _ = expiring => {
                // Not while somebody is still reading. They are collecting a
                // final screen and it takes a round trip, not ten seconds.
                if live.load(Ordering::SeqCst) == 0 {
                    break;
                }
                deadline = Some(tokio::time::Instant::now() + Duration::from_secs(1));
            }
        }
    }

    // The child has gone, so the session has. Whoever is attached learns it
    // from the socket closing under them.
    drop(listener);
    let _ = tokio::fs::remove_file(&path).await;
    Ok(())
}

async fn serve_one(stream: UnixStream, session: Arc<Session>) {
    let (mut reading, mut writing) = stream.into_split();
    let Ok(Some(frame)) = read_frame(&mut reading).await else {
        return;
    };
    let Ok(asking) = frame.json::<Asking>() else {
        return;
    };

    match asking {
        Asking::Describe => {
            let (cols, rows) = session.size();
            let _ = write_frame(
                &mut writing,
                &Frame::control(&Saying::Info {
                    id: session.id.clone(),
                    argv: session.argv.clone(),
                    title: session.title(),
                    cols,
                    rows,
                    running: session.is_alive(),
                }),
            )
            .await;
        }
        Asking::Kill => session.kill(),
        Asking::Watch => {
            let mut alive = session.alive_watch();
            let mut last = session.title();
            while *alive.borrow_and_update() {
                tokio::select! {
                    _ = alive.changed() => {}
                    // A title is set by the program inside, and there is no
                    // event for it — the mirror simply starts saying something
                    // else. Twice a second is far below the rate a person
                    // notices and far above the rate titles actually change.
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                        let now = session.title();
                        if now != last {
                            last = now.clone();
                            if write_frame(&mut writing, &Frame::control(&Saying::Titled { title: now }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
            let _ = write_frame(&mut writing, &Frame::control(&Saying::Ended)).await;
        }
        Asking::Attach { cols, rows } => {
            // Subscribe before taking the mirror. The other order loses
            // whatever is painted in between; this one can only repaint, and a
            // repaint is invisible where a gap is a hole in the screen.
            let mut output = session.subscribe();
            let mut alive = session.alive_watch();
            if cols > 0 && rows > 0 {
                session.resize(cols, rows);
            }

            if write_frame(&mut writing, &Frame::data(0, session.replay()))
                .await
                .is_err()
            {
                return;
            }
            let title = session.title();
            if !title.is_empty() {
                let _ =
                    write_frame(&mut writing, &Frame::event(0, &PaneEvent::Title { title })).await;
            }

            // One scanner per attached client rather than one per session: the
            // sequence can be split across chunks, and each connection sees
            // its own chunk boundaries.
            let mut scanner = Scanner::new();

            let feeding = session.clone();
            let inbound = tokio::spawn(async move {
                while let Ok(Some(frame)) = read_frame(&mut reading).await {
                    match frame.op {
                        Op::Data => feeding.write(&frame.payload),
                        Op::Event => {
                            if let Ok(PaneEvent::Resize { cols, rows }) = frame.json() {
                                feeding.resize(cols, rows);
                            }
                        }
                        // Detaching, never killing. A client letting go of a
                        // pane is the thing this whole design is for.
                        Op::Close => break,
                    }
                }
            });

            while *alive.borrow_and_update() {
                tokio::select! {
                    biased;
                    got = output.recv() => match got {
                        Ok(chunk) => {
                            if write_frame(&mut writing, &Frame::data(0, chunk.as_slice().to_vec()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            // After the bytes, not before: a client showing the
                            // request should show it under whatever the program
                            // printed alongside it.
                            for found in scanner.feed(&chunk) {
                                let Marker::Open { url } = found;
                                if write_frame(&mut writing, &Frame::event(0, &PaneEvent::Open { url }))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                        // Further behind than the backlog. The mirror is the
                        // only thing that can still be truthful, so resync
                        // rather than forward a gap.
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if write_frame(&mut writing, &Frame::data(0, session.replay()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = alive.changed() => {}
                }
            }

            // Whatever the child painted on its way out.
            while let Ok(chunk) = output.try_recv() {
                if write_frame(&mut writing, &Frame::data(0, chunk.as_slice().to_vec()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if !session.is_alive() {
                let _ = write_frame(&mut writing, &Frame::event(0, &PaneEvent::Exit)).await;
                let _ = write_frame(&mut writing, &Frame::close(0)).await;
            }
            inbound.abort();
        }
    }
}

// ------------------------------------------------------------- the other end

/// What a session looks like to the daemon: a socket, and what was found
/// through it.
pub struct Link {
    pub id: String,
    pub path: PathBuf,
}

/// Something a watched session did.
#[derive(Debug, Clone)]
pub enum Stirred {
    Titled { title: String },
    Ended,
}

/// One session's details, as the keeper reports them.
pub struct Detail {
    pub id: String,
    pub argv: Vec<String>,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    /// Whether the child is still there. A keeper answers for a few seconds
    /// after its child has gone so a late client can still collect the final
    /// screen — during which the session is readable but over.
    pub running: bool,
}

impl Link {
    /// Ask the keeper who it is.
    ///
    /// `None` means the socket did not answer at all, which is the only thing
    /// that makes it litter. A keeper that answers `running: false` is still
    /// holding a screen somebody may be about to ask for — deleting its socket
    /// for saying so is how listing the tree came to break the session it was
    /// listing.
    pub async fn detail(&self) -> Option<Detail> {
        let mut stream = UnixStream::connect(&self.path).await.ok()?;
        write_frame(&mut stream, &Frame::control(&Asking::Describe))
            .await
            .ok()?;
        let frame = read_frame(&mut stream).await.ok()??;
        match frame.json().ok()? {
            Saying::Info {
                id,
                argv,
                title,
                cols,
                rows,
                running,
            } => Some(Detail {
                id,
                argv,
                title,
                cols,
                rows,
                running,
            }),
            _ => None,
        }
    }

    /// Hold a connection open and hand back whatever the session does next.
    /// Ends — the receiver closes — when the session does.
    pub async fn watch(&self) -> Result<mpsc::Receiver<Stirred>> {
        let stream = UnixStream::connect(&self.path)
            .await
            .with_context(|| format!("session {} is no longer there", self.id))?;
        let (mut reading, mut writing) = stream.into_split();
        write_frame(&mut writing, &Frame::control(&Asking::Watch)).await?;

        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(async move {
            // Held so the keeper's write half stays open for the life of the
            // watch; dropping it would close the socket under the reader.
            let _writing = writing;
            while let Ok(Some(frame)) = read_frame(&mut reading).await {
                let stirred = match frame.json::<Saying>() {
                    Ok(Saying::Titled { title }) => Stirred::Titled { title },
                    Ok(Saying::Ended) => Stirred::Ended,
                    _ => continue,
                };
                let ending = matches!(stirred, Stirred::Ended);
                if tx.send(stirred).await.is_err() || ending {
                    return;
                }
            }
        });
        Ok(rx)
    }

    pub async fn kill(&self) {
        let Ok(mut stream) = UnixStream::connect(&self.path).await else {
            return;
        };
        let _ = write_frame(&mut stream, &Frame::control(&Asking::Kill)).await;
    }

    /// The same, from somewhere with no runtime left to await on — a `Drop`,
    /// or a teardown after the reactor has gone. Best effort by construction:
    /// there is nowhere to report a failure to.
    pub fn kill_now(&self) {
        use std::io::Write;

        let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&self.path) else {
            return;
        };
        let bytes = Frame::control(&Asking::Kill).encode();
        let _ = stream.write_all(&(bytes.len() as u32).to_be_bytes());
        let _ = stream.write_all(&bytes);
        let _ = stream.flush();
    }

    /// Attach, and hand back the two ends of the relay: frames coming out of
    /// the session, and a sender for what the client types into it.
    pub async fn attach(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<(mpsc::Receiver<Frame>, mpsc::Sender<Frame>)> {
        let stream = UnixStream::connect(&self.path)
            .await
            .with_context(|| format!("session {} is no longer there", self.id))?;
        let (mut reading, mut writing) = stream.into_split();
        write_frame(
            &mut writing,
            &Frame::control(&Asking::Attach { cols, rows }),
        )
        .await?;

        let (out_tx, out_rx) = mpsc::channel::<Frame>(256);
        let (in_tx, mut in_rx) = mpsc::channel::<Frame>(256);

        tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut reading).await {
                if out_tx.send(frame).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(frame) = in_rx.recv().await {
                if write_frame(&mut writing, &frame).await.is_err() {
                    break;
                }
            }
        });

        Ok((out_rx, in_tx))
    }
}

/// A unix stream is bytes, not messages, so each frame says how long it is.
/// The websocket side gets this for free, which is why the framing lives here
/// rather than in `proto`.
const CEILING: usize = 8 * 1024 * 1024;

pub(crate) async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, frame: &Frame) -> Result<()> {
    let bytes = frame.encode();
    w.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

pub(crate) async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> Result<Option<Frame>> {
    let mut header = [0u8; 4];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > CEILING {
        bail!("a {len} byte frame is not a frame");
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    Ok(Some(Frame::decode(&payload)?))
}
