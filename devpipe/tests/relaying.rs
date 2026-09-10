//! A machine reached through something it dialled out to.
//!
//! ssh is the better path and stays the default: nothing is in the middle of
//! it. But a browser cannot open one, so a host that wants to be reachable from
//! the web connects *out* to a relay and waits there. These are the tests that
//! the introduction works and that the conversation afterwards is the ordinary
//! one, byte for byte.

mod harness;

use std::sync::Arc;
use std::time::Duration;

use devpipe::client::Client;
use devpipe::proto::{Frame, FromClient, FromServer, Op, Pane};
use devpipe::relay::{self, Relay};
use futures_util::{SinkExt, StreamExt};
use harness::*;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Relaying {
    url: String,
    relay: Arc<Relay>,
    dir: std::path::PathBuf,
    /// What a machine enrols with, and what a person reaches with. Separate
    /// keys because they are stolen differently.
    enrol: String,
    reach: String,
}

impl Drop for Relaying {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn relay_on() -> Relaying {
    relay_for(&["wess"]).await
}

/// A relay with a key pair per named account.
async fn relay_for(accounts: &[&str]) -> Relaying {
    let dir = std::env::temp_dir().join(format!("devpipe-relay-{}", devpipe::host::random_id(8)));
    let mut keys = devpipe::keys::Keys::open(&dir);
    let mut granted = Vec::new();
    for account in accounts {
        let enrol = keys
            .grant(account, devpipe::keys::Can::Enrol, "test")
            .unwrap();
        let reach = keys
            .grant(account, devpipe::keys::Can::Reach, "test")
            .unwrap();
        granted.push((enrol, reach));
    }
    let (enrol, reach) = granted[0].clone();
    let relay = Relay::new(keys);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let serving = relay.clone();
    tokio::spawn(async move {
        let _ = relay::run(listener, serving).await;
    });
    Relaying {
        url,
        relay,
        dir,
        enrol,
        reach,
    }
}

/// Waits for the relay to have a machine, rather than sleeping for a guess.
async fn wait_for(relay: &Arc<Relay>, name: &str) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while tokio::time::Instant::now() < deadline {
        if relay.all_online().iter().any(|(_, m)| m == name) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// The whole point: a client that never learns where the machine is, running a
/// command on it.
#[tokio::test]
async fn a_session_runs_through_the_relay() {
    let relaying = relay_on().await;
    let host = local_host().await;

    let enrolling = host.host.clone();
    let url = relaying.url.clone();
    let enrol = relaying.enrol.clone();
    tokio::spawn(async move {
        let _ = relay::dial_out(url, enrol, "faraway".into(), enrolling).await;
    });
    assert!(wait_for(&relaying.relay, "faraway").await, "never enrolled");

    // From here nothing knows about a relay. The socket comes back and the
    // ordinary handshake happens on it, with the host's own token.
    let socket = relay::reach(&relaying.url, &relaying.reach, "faraway")
        .await
        .unwrap();
    let (mut client, seen) = Client::over(socket, TOKEN).await.unwrap();
    assert_eq!(seen.environments.len(), 1);
    assert_eq!(seen.environments[0].name, "bridge");

    client
        .say(FromClient::Open {
            channel: PANE,
            pane: Pane::Pty {
                environment: None,
                session: None,
                argv: vec!["/bin/sh".into()],
                cols: 80,
                rows: 24,
            },
        })
        .await
        .unwrap();
    match client.control().await.unwrap() {
        Some(FromServer::Opened { .. }) => {}
        other => panic!("the pane should have opened, got {other:?}"),
    }

    client
        .send(Frame::data(PANE, b"echo through-the-relay\n".to_vec()))
        .await
        .unwrap();

    let mut seen = String::new();
    loop {
        let frame = devpipe::client::next_frame(&mut client.source)
            .await
            .unwrap()
            .expect("the socket should stay open");
        if frame.channel == PANE && frame.op == Op::Data {
            seen.push_str(&String::from_utf8_lossy(&frame.payload));
            if seen.contains("through-the-relay") {
                break;
            }
        }
    }
}

/// Every way of reaching a machine has to reach it the same way, or a feature
/// works over ssh and quietly does not over the relay. This one did exactly
/// that: `attach` resolved a url and a relayed machine has none.
#[tokio::test]
async fn a_relayed_machine_is_reached_like_any_other() {
    let relaying = relay_on().await;
    let host = local_host().await;

    let enrolling = host.host.clone();
    let url = relaying.url.clone();
    let enrol = relaying.enrol.clone();
    tokio::spawn(async move {
        let _ = relay::dial_out(url, enrol, "byname".into(), enrolling).await;
    });
    assert!(wait_for(&relaying.relay, "byname").await, "never enrolled");

    let machine = devpipe::machines::Machine {
        name: "byname".into(),
        ssh: None,
        url: None,
        token: Some(TOKEN.into()),
        relay: Some(relaying.url.clone()),
        relay_token: Some(relaying.reach.clone()),
        port: devpipe::machines::DEFAULT_PORT,
    };

    // The same call every command makes, with no idea a relay is involved.
    let reached = machine.reach().await.expect("should have been introduced");
    assert_eq!(reached.host.environments.len(), 1);
    assert_eq!(reached.host.environments[0].name, "bridge");
    assert!(reached.tunnel.is_none(), "a relay is not an ssh forward");
}

/// The relay routes by name and holds nothing else. A name nobody enrolled is
/// a sentence, not a hang.
#[tokio::test]
async fn a_machine_that_is_not_there_is_said_so() {
    let relaying = relay_on().await;
    let refused = relay::reach(&relaying.url, &relaying.reach, "nowhere")
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("nowhere is not here"), "{refused}");
}

/// The relay's secret is not the host's, and neither opens the other's door.
#[tokio::test]
async fn the_relays_own_token_is_required() {
    let relaying = relay_on().await;
    let refused = relay::reach(&relaying.url, "not-a-granted-key", "anything")
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("unauthorized"), "{refused}");

    // And a machine cannot enrol with the wrong one either.
    let (mut socket, _) = tokio_tungstenite::connect_async(&relaying.url)
        .await
        .unwrap();
    socket
        .send(Message::Binary(
            Frame::control(&relay::ToRelay::Enrol {
                name: "impostor".into(),
                token: "not-a-granted-key".into(),
            })
            .encode()
            .into(),
        ))
        .await
        .unwrap();
    // Whatever it says, it must not be online afterwards.
    let _ = socket.next().await;
    assert!(
        !relaying
            .relay
            .all_online()
            .iter()
            .any(|(_, m)| m == "impostor")
    );
}

/// A machine that goes away stops being offered, without a heartbeat or a
/// timeout to tune — the connection dropping is the whole signal.
#[tokio::test]
async fn presence_is_the_connection() {
    let relaying = relay_on().await;
    let host = local_host().await;

    let enrolling = host.host.clone();
    let url = relaying.url.clone();
    let enrol = relaying.enrol.clone();
    let dialling = tokio::spawn(async move {
        let _ = relay::dial_out(url, enrol, "briefly".into(), enrolling).await;
    });
    assert!(wait_for(&relaying.relay, "briefly").await, "never enrolled");

    dialling.abort();

    let deadline = tokio::time::Instant::now() + PATIENCE;
    while tokio::time::Instant::now() < deadline {
        if relaying.relay.all_online().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "the relay should have noticed it go: {:?}",
        relaying.relay.all_online()
    );
}

/// Two machines under one name would route a client to whichever won a race.
#[tokio::test]
async fn one_name_belongs_to_one_machine() {
    let relaying = relay_on().await;
    let host = local_host().await;

    for _ in 0..2 {
        let enrolling = host.host.clone();
        let url = relaying.url.clone();
        let enrol = relaying.enrol.clone();
        tokio::spawn(async move {
            let _ = relay::dial_out(url, enrol, "twice".into(), enrolling).await;
        });
    }
    assert!(wait_for(&relaying.relay, "twice").await, "never enrolled");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(relaying.relay.all_online().len(), 1);
}

/// Two people, one relay, and the same machine name. The reason a shared
/// secret was not enough: with one, either of them could reach the other's box
/// by knowing what it was called.
#[tokio::test]
async fn one_account_cannot_reach_anothers_machine() {
    let dir = std::env::temp_dir().join(format!("devpipe-relay-{}", devpipe::host::random_id(8)));
    let mut keys = devpipe::keys::Keys::open(&dir);
    let wess_enrol = keys.grant("wess", devpipe::keys::Can::Enrol, "").unwrap();
    let wess_reach = keys.grant("wess", devpipe::keys::Can::Reach, "").unwrap();
    let other_reach = keys
        .grant("someone", devpipe::keys::Can::Reach, "")
        .unwrap();

    let relay = Relay::new(keys);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let serving = relay.clone();
    tokio::spawn(async move {
        let _ = relay::run(listener, serving).await;
    });

    let host = local_host().await;
    let enrolling = host.host.clone();
    let dialling = url.clone();
    tokio::spawn(async move {
        let _ = relay::dial_out(dialling, wess_enrol, "box-a".into(), enrolling).await;
    });
    assert!(wait_for(&relay, "box-a").await, "never enrolled");

    // Its owner reaches it.
    assert!(relay::reach(&url, &wess_reach, "box-a").await.is_ok());

    // Somebody else does not, and is told the same thing they would be told
    // about a machine that does not exist — anything else answers "does wess
    // have a box called this" for whoever asks.
    let refused = relay::reach(&url, &other_reach, "box-a")
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("box-a is not here"), "{refused}");

    // And it is not in their listing either.
    assert_eq!(
        relay::online(&url, &other_reach).await.unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        relay::online(&url, &wess_reach).await.unwrap(),
        vec!["box-a".to_string()]
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// An enrolment key lives on a machine forever. If a stolen one could also be
/// used to reach every other machine its owner has, taking one box would take
/// all of them.
#[tokio::test]
async fn a_machines_key_cannot_be_used_to_reach_machines() {
    let relaying = relay_on().await;
    let refused = relay::reach(&relaying.url, &relaying.enrol, "anything")
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("unauthorized"), "{refused}");
}
