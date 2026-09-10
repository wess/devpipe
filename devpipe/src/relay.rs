//! Reaching a machine that cannot be dialled.
//!
//! `dp` reaches a host over ssh, and nothing about that needs a server in the
//! middle — which is the best property this product has and the reason the
//! machine list lives on the laptop. A browser cannot do it. There is no ssh in
//! a browser and there will not be one, so a web client needs something the
//! machine has dialled *out* to.
//!
//! That thing is this. Machines connect to it and wait; clients connect to it
//! and ask for one by name; the relay introduces them and then copies bytes.
//! After the introduction the two ends speak exactly the protocol they already
//! speak — `proto.rs`, unchanged, end to end — because the relay deliberately
//! does not understand it. Adding a pane kind does not touch this file.
//!
//! **Using the relay means trusting the relay, and ssh mode does not.** TLS
//! terminates here, so a relay that has been tampered with can read the host
//! token a client presents on its way past. That is the honest cost of the only
//! design a browser can take part in, and it is why this is a second path
//! rather than a replacement for the first. Ending it properly means the client
//! and the daemon doing their own handshake inside the tunnel; until they do,
//! say so plainly rather than implying otherwise.
//!
//! One connection per conversation rather than several multiplexed down the
//! machine's socket. It costs a websocket per session and buys the thing that
//! matters: each conversation is an ordinary socket carrying an ordinary
//! `proto.rs` exchange, so nothing above has to learn that a relay exists.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::host::random_id;
use crate::proto::Frame;

/// How long a machine has to bring up a data connection after being asked.
/// Long enough for a slow link, short enough that a client is not left holding
/// a socket nothing is coming down.
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);

/// Depth of the queue toward one machine's control connection. A machine this
/// far behind on `Dial` messages is not answering, and the timeout above is
/// what the client is already waiting on.
const CONTROL_BACKLOG: usize = 32;

type Socket = WebSocketStream<TcpStream>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToRelay {
    /// A machine, announcing itself and then waiting.
    Enrol { name: String, token: String },
    /// A machine, bringing up the connection a `Dial` asked for.
    Offer { ticket: String },
    /// A client, asking to be put through to one.
    Reach { token: String, machine: String },
    /// A client, asking who is here.
    Online { token: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromRelay {
    Enrolled {
        name: String,
    },
    /// Bring up another connection and say this word on it.
    Dial {
        ticket: String,
    },
    /// The next byte is the machine's. Nothing after this is ours.
    Reaching {
        machine: String,
    },
    Online {
        machines: Vec<String>,
    },
    Error {
        message: String,
    },
}

struct Enrolled {
    dial: mpsc::Sender<FromRelay>,
}

pub struct Relay {
    token: String,
    machines: Mutex<HashMap<String, Enrolled>>,
    /// Introductions in progress. A machine's data connection finds the client
    /// waiting for it by the word the relay gave them both.
    pending: Mutex<HashMap<String, oneshot::Sender<Socket>>>,
}

impl Relay {
    pub fn new(token: String) -> Arc<Relay> {
        Arc::new(Relay {
            token,
            machines: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Constant time, for the same reason the host's is: the obvious `==` leaks
    /// the secret one byte per reconnect to anyone who can time it.
    fn authenticate(&self, presented: &str) -> bool {
        self.token.as_bytes().ct_eq(presented.as_bytes()).into()
    }

    pub fn online(&self) -> Vec<String> {
        let mut names: Vec<String> = self.machines.lock().unwrap().keys().cloned().collect();
        names.sort();
        names
    }
}

pub async fn run(listener: TcpListener, relay: Arc<Relay>) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let relay = relay.clone();
        tokio::spawn(async move {
            if let Err(e) = greet(stream, relay).await {
                eprintln!("relay: {peer}: {e}");
            }
        });
    }
}

/// Who is this, and what do they want.
///
/// Decided by the first message, so there is one endpoint and no paths to keep
/// in step with whatever proxy is in front.
async fn greet(stream: TcpStream, relay: Arc<Relay>) -> Result<()> {
    stream.set_nodelay(true).ok();
    let mut socket = tokio_tungstenite::accept_async(stream).await?;

    let opening = next_frame(&mut socket)
        .await?
        .context("closed before saying anything")?;
    let asking: ToRelay = opening.json().context("that was not a relay message")?;

    match asking {
        ToRelay::Enrol { name, token } => {
            if !relay.authenticate(&token) {
                refuse(&mut socket, "unauthorized").await;
                bail!("unauthorized enrolment");
            }
            hold(socket, relay, name).await
        }
        ToRelay::Offer { ticket } => {
            // No token: the ticket *is* the credential. This relay minted it
            // moments ago and it is good for exactly one introduction.
            let waiting = relay.pending.lock().unwrap().remove(&ticket);
            match waiting {
                // If the client has gone, so has the reason for this.
                Some(client) => {
                    let _ = client.send(socket);
                    Ok(())
                }
                None => {
                    refuse(&mut socket, "no such ticket").await;
                    bail!("stale ticket");
                }
            }
        }
        ToRelay::Online { token } => {
            if !relay.authenticate(&token) {
                refuse(&mut socket, "unauthorized").await;
                bail!("unauthorized");
            }
            say(
                &mut socket,
                &FromRelay::Online {
                    machines: relay.online(),
                },
            )
            .await?;
            let _ = socket.close(None).await;
            Ok(())
        }
        ToRelay::Reach { token, machine } => {
            if !relay.authenticate(&token) {
                refuse(&mut socket, "unauthorized").await;
                bail!("unauthorized");
            }
            introduce(socket, relay, machine).await
        }
    }
}

/// A machine's control connection: enrolled, then silent until it is needed.
///
/// The connection itself is the presence. No heartbeat, no timeout to tune —
/// when it drops the entry goes, and the next client to ask is told the machine
/// is not here. It is the one lesson worth taking from MQTT's last will: let
/// the transport say it.
async fn hold(socket: Socket, relay: Arc<Relay>, name: String) -> Result<()> {
    let (mut sink, mut source) = socket.split();
    let (dial, mut asked) = mpsc::channel::<FromRelay>(CONTROL_BACKLOG);

    {
        let taken = {
            let mut machines = relay.machines.lock().unwrap();
            if machines.contains_key(&name) {
                true
            } else {
                machines.insert(name.clone(), Enrolled { dial });
                false
            }
        };
        if taken {
            // Two machines under one name would route a client to whichever
            // won a race, which is worse than refusing the second.
            let mut socket = sink.reunite(source).expect("halves of one socket");
            refuse(&mut socket, &format!("{name} is already enrolled")).await;
            bail!("duplicate enrolment for {name}");
        }
    }

    sink.send(Message::Binary(
        Frame::control(&FromRelay::Enrolled { name: name.clone() })
            .encode()
            .into(),
    ))
    .await?;
    eprintln!("relay: {name} is here");

    loop {
        tokio::select! {
            wanted = asked.recv() => {
                let Some(wanted) = wanted else { break };
                if sink
                    .send(Message::Binary(Frame::control(&wanted).encode().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            // Nothing is expected from a machine on this connection. Reading it
            // is how the relay learns the machine has gone.
            got = source.next() => match got {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => continue,
            },
        }
    }

    relay.machines.lock().unwrap().remove(&name);
    eprintln!("relay: {name} is gone");
    Ok(())
}

/// Put a client through to a machine, then get out of the way.
async fn introduce(mut client: Socket, relay: Arc<Relay>, machine: String) -> Result<()> {
    let dial = {
        let machines = relay.machines.lock().unwrap();
        machines.get(&machine).map(|m| m.dial.clone())
    };
    let Some(dial) = dial else {
        refuse(&mut client, &format!("{machine} is not here")).await;
        bail!("{machine} is not enrolled");
    };

    let ticket = random_id(16);
    let (tx, rx) = oneshot::channel::<Socket>();
    relay.pending.lock().unwrap().insert(ticket.clone(), tx);

    if dial
        .send(FromRelay::Dial {
            ticket: ticket.clone(),
        })
        .await
        .is_err()
    {
        relay.pending.lock().unwrap().remove(&ticket);
        refuse(&mut client, &format!("{machine} is not answering")).await;
        bail!("{machine} went away mid-introduction");
    }

    let host = match tokio::time::timeout(DIAL_TIMEOUT, rx).await {
        Ok(Ok(host)) => host,
        _ => {
            // A ticket nobody claimed would otherwise sit in the map until the
            // process restarted.
            relay.pending.lock().unwrap().remove(&ticket);
            refuse(&mut client, &format!("{machine} did not answer in time")).await;
            bail!("{machine} did not dial back");
        }
    };

    say(&mut client, &FromRelay::Reaching { machine }).await?;
    splice(client, host).await;
    Ok(())
}

/// Copy, in both directions, until either end stops.
///
/// Deliberately the whole of what the relay does with a conversation. It does
/// not parse these frames and must not learn how: the moment it does, adding a
/// pane kind means deploying the relay before the feature works anywhere.
async fn splice(client: Socket, host: Socket) {
    let (mut to_client, mut from_client) = client.split();
    let (mut to_host, mut from_host) = host.split();

    let up = async {
        while let Some(Ok(message)) = from_client.next().await {
            if matches!(message, Message::Close(_)) || to_host.send(message).await.is_err() {
                break;
            }
        }
    };
    let down = async {
        while let Some(Ok(message)) = from_host.next().await {
            if matches!(message, Message::Close(_)) || to_client.send(message).await.is_err() {
                break;
            }
        }
    };

    // Either direction ending ends the conversation: a pane whose other half
    // has gone is not a pane.
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

async fn say(socket: &mut Socket, said: &FromRelay) -> Result<()> {
    socket
        .send(Message::Binary(Frame::control(said).encode().into()))
        .await?;
    Ok(())
}

async fn refuse(socket: &mut Socket, message: &str) {
    let _ = say(
        socket,
        &FromRelay::Error {
            message: message.into(),
        },
    )
    .await;
    let _ = socket.close(None).await;
}

async fn next_frame(socket: &mut Socket) -> Result<Option<Frame>> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Binary(bytes) => return Ok(Some(Frame::decode(&bytes)?)),
            Message::Close(_) => return Ok(None),
            _ => continue,
        }
    }
    Ok(None)
}

// ------------------------------------------------------------- the machine end

/// Dial out to a relay and stay there.
///
/// A host behind NAT cannot be connected *to*, which is the whole reason this
/// exists — so it connects out, says who it is, and then waits. When the relay
/// asks, it opens a second connection and hands it to the ordinary serving
/// path: from `serve::conversation` down, nothing can tell the difference
/// between a client who dialled in and one the relay introduced.
///
/// Reconnects forever, with a backoff that stops short of being a retry storm
/// when the relay is the thing that is down. There is nothing else useful for a
/// host to do while it cannot be reached.
pub async fn dial_out(
    url: String,
    token: String,
    name: String,
    host: Arc<crate::host::Host>,
) -> Result<()> {
    let mut backoff = Duration::from_secs(1);
    loop {
        match enrolled(&url, &token, &name, &host).await {
            Ok(()) => {
                eprintln!("devpipe: relay closed the connection");
                backoff = Duration::from_secs(1);
            }
            Err(e) => eprintln!("devpipe: relay: {e}"),
        }
        tokio::time::sleep(backoff).await;
        // Doubling to a minute: long enough not to hammer a relay that is
        // being restarted, short enough that nobody waits for it by hand.
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// One session at the relay: enrol, then answer every `Dial` until it drops.
async fn enrolled(url: &str, token: &str, name: &str, host: &Arc<crate::host::Host>) -> Result<()> {
    let (socket, _) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut source) = socket.split();
    sink.send(Message::Binary(
        Frame::control(&ToRelay::Enrol {
            name: name.to_string(),
            token: token.to_string(),
        })
        .encode()
        .into(),
    ))
    .await?;

    while let Some(message) = source.next().await {
        let Message::Binary(bytes) = message? else {
            continue;
        };
        match Frame::decode(&bytes)?.json::<FromRelay>()? {
            FromRelay::Enrolled { name } => eprintln!("devpipe: enrolled at the relay as {name}"),
            FromRelay::Dial { ticket } => {
                // Its own task and its own connection: answering a dial must
                // not stop this one listening for the next.
                let url = url.to_string();
                let host = host.clone();
                tokio::spawn(async move {
                    if let Err(e) = answer(&url, &ticket, host).await {
                        eprintln!("devpipe: relay dial: {e}");
                    }
                });
            }
            FromRelay::Error { message } => bail!("{message}"),
            _ => continue,
        }
    }
    Ok(())
}

/// Bring up the connection the relay asked for, and serve on it.
async fn answer(url: &str, ticket: &str, host: Arc<crate::host::Host>) -> Result<()> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
    socket
        .send(Message::Binary(
            Frame::control(&ToRelay::Offer {
                ticket: ticket.to_string(),
            })
            .encode()
            .into(),
        ))
        .await?;
    // Straight into the ordinary conversation. The client on the other side is
    // about to say hello and present this host's token, exactly as it would
    // over ssh — the relay carried the introduction and knows nothing else.
    crate::serve::conversation(socket, host).await
}

// -------------------------------------------------------------- the client end

/// Ask a relay to put you through to a machine, and get the socket back.
///
/// What comes back is a plain connection to that host: the relay is copying
/// bytes and nothing more, so the caller greets the host and presents its token
/// exactly as it would over ssh.
pub async fn reach(
    url: &str,
    token: &str,
    machine: &str,
) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
    socket
        .send(Message::Binary(
            Frame::control(&ToRelay::Reach {
                token: token.to_string(),
                machine: machine.to_string(),
            })
            .encode()
            .into(),
        ))
        .await?;

    while let Some(message) = socket.next().await {
        let Message::Binary(bytes) = message? else {
            continue;
        };
        match Frame::decode(&bytes)?.json::<FromRelay>()? {
            // Everything after this frame belongs to the host.
            FromRelay::Reaching { .. } => return Ok(socket),
            FromRelay::Error { message } => bail!("{message}"),
            _ => continue,
        }
    }
    bail!("the relay closed before putting us through")
}

/// Who the relay currently has.
pub async fn online(url: &str, token: &str) -> Result<Vec<String>> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
    socket
        .send(Message::Binary(
            Frame::control(&ToRelay::Online {
                token: token.to_string(),
            })
            .encode()
            .into(),
        ))
        .await?;
    while let Some(message) = socket.next().await {
        let Message::Binary(bytes) = message? else {
            continue;
        };
        match Frame::decode(&bytes)?.json::<FromRelay>()? {
            FromRelay::Online { machines } => return Ok(machines),
            FromRelay::Error { message } => bail!("{message}"),
            _ => continue,
        }
    }
    bail!("the relay said nothing")
}
