//! Sessions outliving the daemon.
//!
//! The promise this iteration makes is that letting go of something costs
//! nothing. A client dropping off a train was already free; a restart of
//! `devpipe serve` — an upgrade, a crash, systemd doing its job — was not, and
//! took every session on the host with it. These are the tests that say it no
//! longer does.

mod harness;

use std::sync::Arc;

use devpipe::backend::local::Local;
use devpipe::proto::Frame;
use harness::*;

#[tokio::test]
async fn a_session_survives_the_daemon_that_started_it() {
    let dir = scratch();
    let mut first = serve_host(dir.clone(), Arc::new(Local)).await;
    first.keep_state = true;
    first
        .host
        .create("bridge".into(), None, vec![], None, None)
        .await
        .unwrap();

    let (mut sink, mut source, _) = greet(first.addr, TOKEN).await;
    let session = open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;
    send(
        &mut sink,
        Frame::data(PANE, b"echo painted-before-the-restart\n".to_vec()),
    )
    .await;
    painted(&mut source, "painted-before-the-restart").await;

    // Everything the daemon was holding goes: the socket, the connection, the
    // process's memory of any of it.
    drop(sink);
    drop(source);
    drop(first);

    let again = serve_host(dir.clone(), Arc::new(Local)).await;
    let (_sink, _source, welcome) = greet(again.addr, TOKEN).await;
    let environments = welcome.expect("welcome").environments;
    assert_eq!(environments.len(), 1);
    assert_eq!(
        environments[0].sessions.len(),
        1,
        "the new daemon should find the session: {:?}",
        environments[0].sessions
    );
    assert_eq!(
        environments[0].sessions[0].id, session,
        "and it should be the same session, not a new one"
    );

    // Not just listed — still the same screen, which is the part that would
    // make somebody trust it.
    let (mut sink, mut source, _) = greet(again.addr, TOKEN).await;
    open(&mut sink, &mut source, None, Some(session.clone()), &[]).await;
    let seen = painted(&mut source, "painted-before-the-restart").await;
    assert!(seen.contains("painted-before-the-restart"), "{seen:?}");

    // And it is still a live shell rather than a photograph of one.
    send(
        &mut sink,
        Frame::data(PANE, b"echo still-alive-afterwards\n".to_vec()),
    )
    .await;
    let seen = painted(&mut source, "still-alive-afterwards").await;
    assert!(seen.contains("still-alive-afterwards"), "{seen:?}");
}

/// A session that has actually ended must not come back as a name in a list.
/// The socket outlives the keeper by a moment, and a daemon that trusted the
/// file rather than the answer would offer panes over nothing.
#[tokio::test]
async fn a_finished_session_stops_being_listed() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    let session = open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;

    send(&mut sink, Frame::data(PANE, b"exit\n".to_vec())).await;
    // Wait for the pane to close rather than sleeping: that frame is the
    // daemon saying the child has gone.
    loop {
        let frame = next(&mut source).await.expect("the pane should close");
        if frame.channel == PANE && frame.op == devpipe::proto::Op::Close {
            break;
        }
    }

    let listed = host.host.describe().await;
    assert!(
        listed.environments[0].sessions.is_empty(),
        "a finished session should not be listed: {:?}",
        listed.environments[0].sessions
    );

    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    send(
        &mut sink,
        Frame::control(&devpipe::proto::FromClient::Open {
            channel: PANE,
            pane: devpipe::proto::Pane::Pty {
                environment: None,
                session: Some(session),
                argv: vec![],
                cols: 80,
                rows: 24,
            },
        }),
    )
    .await;
    match control(&mut source).await {
        Some(devpipe::proto::FromServer::Error { .. }) => {}
        other => panic!("resuming a finished session should be refused, got {other:?}"),
    }
}

/// Two hosts on one machine must not find each other's sessions. This is what
/// a parallel test run is, and it would also be two people on a shared box.
#[tokio::test]
async fn one_host_does_not_see_anothers_sessions() {
    let one = local_host().await;
    let two = local_host().await;

    let (mut sink, mut source, _) = greet(one.addr, TOKEN).await;
    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;
    send(&mut sink, Frame::data(PANE, b"echo mine\n".to_vec())).await;
    painted(&mut source, "mine").await;

    let seen = two.host.describe().await;
    assert!(
        seen.environments[0].sessions.is_empty(),
        "the other host's session should be invisible here: {:?}",
        seen.environments[0].sessions
    );
}
