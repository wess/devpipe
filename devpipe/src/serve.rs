//! Serving a host.
//!
//! One websocket per client, every pane multiplexed onto it, and the panes on
//! one socket may belong to different environments. That is deliberate: a
//! client showing two projects side by side is one connection to one host,
//! not two connections to two machines.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::host::Host;
use crate::proto::{self, Frame, FromClient, FromServer, Op, Pane};

const WRITE_BACKLOG: usize = 256;

/// How long a refused client is given to read why before the socket goes.
const FAREWELL: Duration = Duration::from_secs(2);

type Incoming = SplitStream<WebSocketStream<TcpStream>>;

pub async fn run(listener: TcpListener, host: Arc<Host>) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let host = host.clone();
        tokio::spawn(async move {
            if let Err(e) = serve(stream, host).await {
                eprintln!("devpipe: {peer}: {e}");
            }
        });
    }
}

async fn serve(stream: TcpStream, host: Arc<Host>) -> Result<()> {
    stream.set_nodelay(true).ok();
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Frame>(WRITE_BACKLOG);

    // One writer owns the sink. Pane pumps and the control path both produce
    // frames and a sink cannot be shared, so everything queues here and the
    // channel decides the order.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink
                .send(Message::Binary(frame.encode().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let outcome = converse(&mut source, tx, &host).await;
    // `converse` dropped its sender, so the writer drains and stops on its
    // own. The timeout is only for a peer that has stopped reading.
    let _ = tokio::time::timeout(FAREWELL, writer).await;
    outcome
}

/// A pane the client has open, from the daemon's side: somewhere to put what
/// the client types, and the task carrying the session's output back.
///
/// No session in here, because the daemon does not hold one. It holds a socket
/// to the keeper that does, which is the entire reason a restart of this
/// process is survivable.
struct OpenPane {
    to_session: mpsc::Sender<Frame>,
    pump: JoinHandle<()>,
}

async fn converse(source: &mut Incoming, tx: mpsc::Sender<Frame>, host: &Arc<Host>) -> Result<()> {
    let mut panes: HashMap<u32, OpenPane> = HashMap::new();
    let mut watching: Option<JoinHandle<()>> = None;
    let result = talk(source, &tx, host, &mut panes, &mut watching).await;
    if let Some(watching) = watching {
        watching.abort();
    }
    // Detaching, not killing: the sessions stay in their environments and the
    // next client picks them up where this one left them.
    for pane in panes.values() {
        pane.pump.abort();
    }
    drop(tx);
    result
}

async fn talk(
    source: &mut Incoming,
    tx: &mpsc::Sender<Frame>,
    host: &Arc<Host>,
    panes: &mut HashMap<u32, OpenPane>,
    watching: &mut Option<JoinHandle<()>>,
) -> Result<()> {
    let opening = next_frame(source).await?.context("closed before hello")?;
    let FromClient::Hello { version, token, .. } = opening.json().context("expected hello")? else {
        refuse(tx, "expected hello").await;
        bail!("expected hello");
    };
    if version != proto::VERSION {
        refuse(
            tx,
            &format!("protocol {version}, this host speaks {}", proto::VERSION),
        )
        .await;
        bail!("version mismatch");
    }
    if !host.authenticate(&token) {
        refuse(tx, "unauthorized").await;
        bail!("unauthorized");
    }

    tx.send(Frame::control(&FromServer::Welcome {
        version: proto::VERSION,
        host: host.describe().await,
    }))
    .await?;

    while let Some(frame) = next_frame(source).await? {
        if frame.channel == proto::CONTROL {
            control(&frame, tx, host, panes, watching).await?;
            continue;
        }
        let Some(pane) = panes.get(&frame.channel) else {
            // A frame for a channel that is not open is a client bug, not a
            // reason to drop somebody's session.
            continue;
        };
        match frame.op {
            Op::Data | Op::Event => {
                let mut frame = frame;
                // The keeper has one pane and numbers it zero; the channel is
                // this connection's way of telling its own panes apart.
                frame.channel = proto::CONTROL;
                // Waiting rather than dropping. Backpressure here stops the
                // socket being read, which is what a client that is typing
                // faster than the session can accept should feel — and losing
                // the middle of somebody's paste is not.
                if pane.to_session.send(frame).await.is_err() {
                    // The keeper has gone. The relay will say so on its own
                    // channel; nothing to do here but stop feeding it.
                    continue;
                }
            }
            Op::Close => {
                if let Some(pane) = panes.remove(&frame.channel) {
                    pane.pump.abort();
                }
            }
        }
    }
    Ok(())
}

async fn control(
    frame: &Frame,
    tx: &mpsc::Sender<Frame>,
    host: &Arc<Host>,
    panes: &mut HashMap<u32, OpenPane>,
    watching: &mut Option<JoinHandle<()>>,
) -> Result<()> {
    let msg: FromClient = match frame.json() {
        Ok(msg) => msg,
        Err(e) => {
            return say(
                tx,
                FromServer::Error {
                    message: e.to_string(),
                },
            )
            .await;
        }
    };

    match msg {
        FromClient::Open { channel, pane } => {
            if channel == proto::CONTROL || panes.contains_key(&channel) {
                return say(
                    tx,
                    FromServer::Error {
                        message: format!("channel {channel} is not available"),
                    },
                )
                .await;
            }
            let Pane::Pty {
                environment,
                session,
                argv,
                cols,
                rows,
            } = pane;
            let found = match host.get(environment.as_deref()) {
                Ok(found) => found,
                Err(e) => {
                    return say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            };
            match found.attach(session.as_deref(), argv, cols, rows).await {
                Ok(link) => {
                    let (from_session, to_session) = match link.attach(cols, rows).await {
                        Ok(pair) => pair,
                        Err(e) => {
                            return say(
                                tx,
                                FromServer::Error {
                                    message: e.to_string(),
                                },
                            )
                            .await;
                        }
                    };
                    // Announce before pumping, so the client has the session
                    // id before the first byte painted under it.
                    say(
                        tx,
                        FromServer::Opened {
                            channel,
                            environment: found.spec.id.clone(),
                            session: link.id.clone(),
                        },
                    )
                    .await?;
                    let pump = relay(channel, from_session, tx.clone());
                    panes.insert(channel, OpenPane { to_session, pump });
                }
                Err(e) => {
                    return say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        FromClient::Close { channel } => {
            if let Some(pane) = panes.remove(&channel) {
                pane.pump.abort();
            }
            return say(
                tx,
                FromServer::Closed {
                    channel,
                    reason: "detached".into(),
                },
            )
            .await;
        }
        FromClient::CreateEnvironment {
            name,
            image,
            ports,
            repo,
            memory,
        } => {
            return match make(host, name, image, ports, repo, memory).await {
                Ok(made) => {
                    say(
                        tx,
                        FromServer::Environment {
                            environment: made.describe().await,
                        },
                    )
                    .await
                }
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::StartEnvironment { id } => {
            return match host.start(&id).await {
                Ok(env) => {
                    say(
                        tx,
                        FromServer::Environment {
                            environment: env.describe().await,
                        },
                    )
                    .await
                }
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::StopEnvironment { id } => {
            return match host.stop(&id).await {
                Ok(env) => {
                    say(
                        tx,
                        FromServer::Environment {
                            environment: env.describe().await,
                        },
                    )
                    .await
                }
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::DestroyEnvironment { id } => {
            return match host.destroy(&id).await {
                Ok(id) => say(tx, FromServer::EnvironmentGone { id }).await,
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::SetSecret { key, value } => {
            return match host.secrets().set(&key, &value) {
                Ok(()) => {
                    say(
                        tx,
                        FromServer::Secrets {
                            names: host.secrets().names(),
                        },
                    )
                    .await
                }
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::RemoveSecret { key } => {
            return match host.secrets().remove(&key) {
                Ok(true) => {
                    say(
                        tx,
                        FromServer::Secrets {
                            names: host.secrets().names(),
                        },
                    )
                    .await
                }
                Ok(false) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: format!("no secret called {key}"),
                        },
                    )
                    .await
                }
                Err(e) => {
                    say(
                        tx,
                        FromServer::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            };
        }
        FromClient::ListSecrets => {
            return say(
                tx,
                FromServer::Secrets {
                    names: host.secrets().names(),
                },
            )
            .await;
        }
        FromClient::Describe => {
            return say(
                tx,
                FromServer::Welcome {
                    version: proto::VERSION,
                    host: host.describe().await,
                },
            )
            .await;
        }
        FromClient::Watch { on } => {
            if let Some(already) = watching.take() {
                already.abort();
            }
            if on {
                *watching = Some(forward_news(host.news(), tx.clone()));
            }
            return say(tx, FromServer::Pong).await;
        }
        FromClient::Ping => return say(tx, FromServer::Pong).await,
        FromClient::Hello { .. } => {
            return say(
                tx,
                FromServer::Error {
                    message: "already greeted".into(),
                },
            )
            .await;
        }
    }
    Ok(())
}

/// Create, and put the code in it before anyone is told it exists.
///
/// A failed clone takes the environment with it. The alternative is handing
/// somebody an environment named after a repository that is not in it, which
/// they will find out about later and by surprise.
async fn make(
    host: &Arc<Host>,
    name: String,
    image: Option<String>,
    ports: Vec<u16>,
    repo: Option<String>,
    memory: Option<String>,
) -> Result<Arc<crate::environment::Environment>> {
    let made = host.create(name, image, ports, None, memory).await?;
    if let Some(repo) = repo
        && let Err(e) = made.clone_repo(&repo).await
    {
        let _ = host.destroy(&made.spec.id).await;
        return Err(e);
    }
    Ok(made)
}

/// Forward everything the host announces to one connection.
///
/// A separate task rather than another arm of the read loop: the loop can be
/// parked on a pane's backpressure, and news that waits behind somebody's
/// paste is news that arrives after the thing it describes has changed again.
fn forward_news(
    mut news: tokio::sync::broadcast::Receiver<FromServer>,
    tx: mpsc::Sender<Frame>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match news.recv().await {
                Ok(said) => {
                    if tx.send(Frame::control(&said)).await.is_err() {
                        return;
                    }
                }
                // Too far behind to be told what changed, so tell it that
                // everything did. A client that reloads is right again; one
                // fed a gap is quietly wrong.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if tx.send(Frame::control(&FromServer::Stale)).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    })
}

/// Carry one session's output to the client.
///
/// Everything interesting — the mirror, the resync after falling behind, the
/// last bytes a dying child painted — happens in the keeper, on the other side
/// of the socket. What is left here is renumbering the channel, because the
/// keeper only ever has one pane and the client may have several.
fn relay(
    channel: u32,
    mut from_session: mpsc::Receiver<Frame>,
    tx: mpsc::Sender<Frame>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(mut frame) = from_session.recv().await {
            frame.channel = channel;
            let ending = frame.op == Op::Close;
            if tx.send(frame).await.is_err() || ending {
                return;
            }
        }
        // The socket went without a Close, which means the keeper died rather
        // than the child exiting. Either way the pane is over, and saying so
        // is better than leaving a live-looking pane over nothing.
        let _ = tx.send(Frame::close(channel)).await;
    })
}

async fn say(tx: &mpsc::Sender<Frame>, msg: FromServer) -> Result<()> {
    tx.send(Frame::control(&msg)).await?;
    Ok(())
}

async fn refuse(tx: &mpsc::Sender<Frame>, message: &str) {
    let _ = tx
        .send(Frame::control(&FromServer::Error {
            message: message.into(),
        }))
        .await;
}

async fn next_frame(source: &mut Incoming) -> Result<Option<Frame>> {
    while let Some(msg) = source.next().await {
        match msg? {
            Message::Binary(bytes) => return Ok(Some(Frame::decode(&bytes)?)),
            Message::Close(_) => return Ok(None),
            // Text carries nothing here, and ping/pong belong to the
            // transport rather than to the protocol.
            _ => continue,
        }
    }
    Ok(None)
}
