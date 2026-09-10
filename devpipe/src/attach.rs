//! Attaching from a terminal.
//!
//! The reference client, and the one that proves the protocol: it opens a
//! single pty pane in one environment and does nothing clever with it.
//! Anything a richer client adds — a second pane, another environment beside
//! it, a file tree — is another channel on the same socket, not another
//! connection and not another code path.

use std::io::Read;

use anyhow::{Result, bail};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::client::{Client, Incoming, Outgoing, next_frame};
use crate::proto::{self, Frame, FromClient, FromServer, HostInfo, Op, Pane, PaneEvent};
use crate::term::{self, DETACH};

/// The pty pane's channel. Fixed here only because this client opens exactly
/// one; the protocol lets a client number its own.
const PANE: u32 = 1;

enum Input {
    Bytes(Vec<u8>),
    Detach,
}

/// Attach on a connection somebody else made.
///
/// The caller decides how the host was reached — ssh, a plain url, or a relay
/// that introduced them — because those differ only in how the socket came to
/// exist. Once it does, this is the same code either way, which is the point of
/// the relay refusing to understand what it carries.
pub async fn run(
    mut client: Client,
    host: HostInfo,
    environment: Option<String>,
    session: Option<String>,
    argv: Vec<String>,
) -> Result<()> {
    eprintln!(
        "devpipe: {} on {} · {} backend · {} environment(s)",
        host.id,
        host.host,
        host.backend,
        host.environments.len()
    );

    let (cols, rows) = term::winsize();
    client
        .say(FromClient::Open {
            channel: PANE,
            pane: Pane::Pty {
                environment,
                session,
                argv,
                cols,
                rows,
            },
        })
        .await?;

    // Nothing is drawn until the pane is known to be open, so a refusal prints
    // like an ordinary error rather than a staircase in raw mode.
    let mut early = Vec::new();
    let (environment, session) = opened(&mut client.source, &mut early).await?;
    let name = host
        .environments
        .iter()
        .find(|e| e.id == environment)
        .map(|e| e.name.clone())
        .unwrap_or(environment);
    eprintln!("devpipe: {name} · session {session} · ctrl-] to detach");

    let raw = term::Raw::enter().ok();
    let ending = converse(&mut client.sink, &mut client.source, early).await;
    drop(raw);

    let _ = client.say(FromClient::Close { channel: PANE }).await;
    client.close().await;
    match ending? {
        Ending::Detached => eprintln!("devpipe: detached"),
        Ending::Exited => eprintln!("devpipe: session ended"),
        Ending::Dropped => eprintln!("devpipe: host went away"),
    }
    Ok(())
}

enum Ending {
    Detached,
    Exited,
    Dropped,
}

/// Waits for the host to confirm the pane, keeping anything it painted in the
/// meantime. The host announces before it pumps, so `early` is normally empty
/// — but a client that threw those frames away would lose the first screen the
/// day that stops being true.
async fn opened(source: &mut Incoming, early: &mut Vec<u8>) -> Result<(String, String)> {
    while let Some(frame) = next_frame(source).await? {
        if frame.channel == proto::CONTROL {
            match frame.json::<FromServer>()? {
                FromServer::Opened {
                    environment,
                    session,
                    ..
                } => return Ok((environment, session)),
                FromServer::Error { message } => bail!("{message}"),
                _ => continue,
            }
        }
        if frame.channel == PANE && frame.op == Op::Data {
            early.extend_from_slice(&frame.payload);
        }
    }
    bail!("the host closed before opening the pane")
}

async fn converse(sink: &mut Outgoing, source: &mut Incoming, early: Vec<u8>) -> Result<Ending> {
    let (tx, mut input) = mpsc::channel::<Input>(64);
    // A plain OS thread: reading stdin is a blocking syscall with no
    // cancellation, and a tokio task holding one would outlive the detach it
    // is supposed to cause.
    std::thread::spawn(move || read_stdin(tx));

    let mut resized =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    let mut out = tokio::io::stdout();
    if !early.is_empty() {
        out.write_all(&early).await?;
        out.flush().await?;
    }

    loop {
        tokio::select! {
            got = input.recv() => match got {
                Some(Input::Bytes(bytes)) => send(sink, Frame::data(PANE, bytes)).await?,
                Some(Input::Detach) | None => return Ok(Ending::Detached),
            },
            _ = resized.recv() => {
                let (cols, rows) = term::winsize();
                send(sink, Frame::event(PANE, &PaneEvent::Resize { cols, rows })).await?;
            },
            frame = next_frame(source) => match frame? {
                None => return Ok(Ending::Dropped),
                Some(frame) if frame.channel == PANE => match frame.op {
                    Op::Data => {
                        out.write_all(&frame.payload).await?;
                        out.flush().await?;
                    }
                    Op::Close => return Ok(Ending::Exited),
                    Op::Event => match frame.json() {
                        Ok(PaneEvent::Exit) => return Ok(Ending::Exited),
                        // Printed, never opened. This client is a terminal and
                        // the person is looking at it, so handing them the URL
                        // is both the safe thing and the whole of the job — a
                        // richer client draws a button, and still waits to be
                        // told to press it.
                        Ok(PaneEvent::Open { url }) => {
                            out.write_all(
                                format!("\r\n\x1b[7m devpipe \x1b[m open this to continue:\r\n{url}\r\n")
                                    .as_bytes(),
                            )
                            .await?;
                            out.flush().await?;
                        }
                        _ => {}
                    },
                },
                Some(frame) if frame.channel == proto::CONTROL => {
                    if let Ok(FromServer::Error { message }) = frame.json::<FromServer>() {
                        // Raw mode is still on, so the carriage return earns
                        // its place.
                        eprint!("\r\ndevpipe: {message}\r\n");
                    }
                }
                Some(_) => {}
            },
        }
    }
}

fn read_stdin(tx: mpsc::Sender<Input>) {
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 4096];
    while let Ok(n) = stdin.read(&mut buf) {
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        match chunk.iter().position(|b| *b == DETACH) {
            Some(at) => {
                // Everything typed before the escape still belongs to the
                // child; dropping it would eat a keystroke on every detach.
                if at > 0
                    && tx
                        .blocking_send(Input::Bytes(chunk[..at].to_vec()))
                        .is_err()
                {
                    break;
                }
                let _ = tx.blocking_send(Input::Detach);
                break;
            }
            None => {
                if tx.blocking_send(Input::Bytes(chunk.to_vec())).is_err() {
                    break;
                }
            }
        }
    }
}

async fn send(sink: &mut Outgoing, frame: Frame) -> Result<()> {
    use futures_util::SinkExt;
    sink.send(tokio_tungstenite::tungstenite::Message::Binary(
        frame.encode().into(),
    ))
    .await?;
    Ok(())
}
