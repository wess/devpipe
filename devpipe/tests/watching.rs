//! Two clients on one host agreeing without polling.
//!
//! The tree view is only as good as this: four machines in a window are worth
//! having because they are current, and a client that has to re-ask is a
//! client that is wrong between asks.

mod harness;

use std::sync::Arc;

use devpipe::backend::local::Local;
use devpipe::proto::{Frame, FromClient, FromServer};
use harness::*;

/// What one client does, another watching client is told.
#[tokio::test]
async fn a_watcher_hears_about_somebody_elses_change() {
    let host = serve_host(scratch(), Arc::new(Local)).await;

    let (mut watcher, mut watching, _) = greet(host.addr, TOKEN).await;
    send(
        &mut watcher,
        Frame::control(&FromClient::Watch { on: true }),
    )
    .await;
    assert!(
        matches!(control(&mut watching).await, Some(FromServer::Pong)),
        "watching should be acknowledged before anything is expected of it"
    );

    // A different connection entirely.
    let (mut other, mut answering, _) = greet(host.addr, TOKEN).await;
    send(
        &mut other,
        Frame::control(&FromClient::CreateEnvironment {
            name: "made-elsewhere".into(),
            image: None,
            ports: vec![],
            repo: None,
            memory: None,
        }),
    )
    .await;
    control(&mut answering).await;

    match control(&mut watching).await {
        Some(FromServer::Environment { environment }) => {
            assert_eq!(environment.name, "made-elsewhere");
        }
        other => panic!("the watcher should have been told, got {other:?}"),
    }
}

/// A client that did not ask to watch gets its own answers and nothing else.
/// Without that, a one-shot command could read somebody else's broadcast and
/// mistake it for its reply — they are the same message.
#[tokio::test]
async fn a_client_that_did_not_ask_is_not_told() {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    let (mut quiet, mut hearing, _) = greet(host.addr, TOKEN).await;

    let (mut other, mut answering, _) = greet(host.addr, TOKEN).await;
    send(
        &mut other,
        Frame::control(&FromClient::CreateEnvironment {
            name: "elsewhere".into(),
            image: None,
            ports: vec![],
            repo: None,
            memory: None,
        }),
    )
    .await;
    control(&mut answering).await;

    // If a broadcast had leaked onto this connection it would be sitting ahead
    // of the pong.
    send(&mut quiet, Frame::control(&FromClient::Ping)).await;
    match control(&mut hearing).await {
        Some(FromServer::Pong) => {}
        other => panic!("this connection should have heard only its own pong, got {other:?}"),
    }
}

/// A session ending with nobody attached is the case that decides whether the
/// tree can be trusted: it is exactly when an agent finishes while you are
/// looking at another machine.
#[tokio::test]
async fn a_session_ending_unattended_is_announced() {
    let host = local_host().await;

    let (mut watcher, mut watching, _) = greet(host.addr, TOKEN).await;
    send(
        &mut watcher,
        Frame::control(&FromClient::Watch { on: true }),
    )
    .await;
    control(&mut watching).await;

    {
        let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
        open(
            &mut sink,
            &mut source,
            None,
            None,
            &["/bin/sh", "-c", "sleep 0.3"],
        )
        .await;
        // Let go before it finishes. Nothing is attached when it ends.
        drop(sink);
        drop(source);
    }

    let mut saw_it_running = false;
    loop {
        match control(&mut watching).await {
            Some(FromServer::Environment { environment }) => {
                if !environment.sessions.is_empty() {
                    saw_it_running = true;
                    continue;
                }
                assert!(
                    saw_it_running,
                    "the session should have been announced before it was un-announced"
                );
                return;
            }
            Some(_) => continue,
            None => panic!("the host closed before saying the session ended"),
        }
    }
}
