//! The pane and session contract, exercised over a real socket against a real
//! pty. Uses the `local` backend so these stay fast and need no runtime; the
//! container backend has its own file.
//!
//! Deliberately end-to-end. The interesting failures in a thing like this are
//! never in one function — they are a session dying with the socket, a replay
//! landing before the pane is announced, an escape cut in half. None of those
//! show up in a unit test of the piece that causes them.

mod harness;

use devpipe::proto::{Frame, FromClient, FromServer, Op, Pane};
use harness::*;

/// The product promise. A client that disappears without warning must cost the
/// session nothing, and what comes back has to be the screen rather than a
/// fresh shell.
#[tokio::test]
async fn a_session_survives_the_client_that_started_it() {
    let host = local_host().await;

    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    let session = open(
        &mut sink,
        &mut source,
        None,
        None,
        &["/bin/sh", "-c", "echo still-here; sleep 60"],
    )
    .await;
    painted(&mut source, "still-here").await;

    // Not a polite close: this is a laptop lid, a tunnel, a train.
    drop(sink);
    drop(source);

    let (mut sink, mut source, welcome) = greet(host.addr, TOKEN).await;
    let listed = &welcome.expect("welcome").environments[0].sessions;
    assert!(
        listed.iter().any(|s| s.id == session),
        "the session should be listed: {listed:?}"
    );

    let again = open(&mut sink, &mut source, None, Some(session.clone()), &[]).await;
    assert_eq!(
        again, session,
        "attaching by id must not start a new session"
    );
    let screen = painted(&mut source, "still-here").await;
    assert!(
        screen.contains("still-here"),
        "the replay should carry the screen, got {screen:?}"
    );
}

#[tokio::test]
async fn typing_reaches_the_child() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;

    send(&mut sink, Frame::data(PANE, b"echo tap-tap-tap\n".to_vec())).await;
    let painted = painted(&mut source, "tap-tap-tap").await;
    assert!(
        painted.contains("tap-tap-tap"),
        "expected the command to appear, got {painted:?}"
    );
}

#[tokio::test]
async fn a_finished_child_closes_its_pane() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(
        &mut sink,
        &mut source,
        None,
        None,
        &["/bin/sh", "-c", "echo bye"],
    )
    .await;

    let mut closed = false;
    while let Some(frame) = next(&mut source).await {
        if frame.channel == PANE && frame.op == Op::Close {
            closed = true;
            break;
        }
    }
    assert!(closed, "the pane should close when the child exits");
}

/// A session is a shell. The handshake is the only thing standing between a
/// port and somebody's machine, so its failure has to be a hard one.
#[tokio::test]
async fn a_wrong_token_is_refused() {
    let host = local_host().await;
    let (_sink, mut source, welcome) = greet(host.addr, "not-the-token").await;
    assert!(welcome.is_none(), "a bad token must not be welcomed");
    assert!(
        next(&mut source).await.is_none(),
        "and the socket must close"
    );
}

#[tokio::test]
async fn attaching_to_a_session_that_is_gone_is_an_error_not_a_new_shell() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;

    send(
        &mut sink,
        Frame::control(&FromClient::Open {
            channel: PANE,
            pane: Pane::Pty {
                environment: None,
                session: Some("nope".into()),
                argv: vec![],
                cols: 80,
                rows: 24,
            },
        }),
    )
    .await;
    match control(&mut source).await {
        Some(FromServer::Error { message }) => {
            assert!(message.contains("no such session"), "{message}")
        }
        other => panic!("expected an error, got {other:?}"),
    }
}

/// Omitting the environment is how bridge mode stays a one-word command, and
/// naming one that is not here has to say so rather than land somewhere else.
#[tokio::test]
async fn an_unknown_environment_is_named_in_the_refusal() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;

    send(
        &mut sink,
        Frame::control(&FromClient::Open {
            channel: PANE,
            pane: Pane::Pty {
                environment: Some("nowhere".into()),
                session: None,
                argv: vec![],
                cols: 80,
                rows: 24,
            },
        }),
    )
    .await;
    match control(&mut source).await {
        Some(FromServer::Error { message }) => assert!(message.contains("nowhere"), "{message}"),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// A command that finishes before anyone can attach to it.
///
/// The daemon starts a keeper, the keeper starts the command, and the command
/// is over before the daemon has connected to read the output — which for `ls`
/// is the normal case rather than a race worth mentioning. Repeated, because
/// the version of this bug that shipped passed on a fast machine and failed on
/// a CI runner.
#[tokio::test]
async fn output_survives_a_command_that_finishes_instantly() {
    let host = local_host().await;
    for _ in 0..8 {
        let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
        open(
            &mut sink,
            &mut source,
            None,
            None,
            &["/bin/sh", "-c", "echo gone-already"],
        )
        .await;
        let seen = painted(&mut source, "gone-already").await;
        assert!(seen.contains("gone-already"), "{seen:?}");
    }
}

/// The other half: a session that has ended is not offered for resuming, even
/// while its keeper is still around to hand out the last screen.
#[tokio::test]
async fn a_session_that_ended_is_not_resumable_during_the_grace() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    let session = open(
        &mut sink,
        &mut source,
        None,
        None,
        &["/bin/sh", "-c", "echo done"],
    )
    .await;
    // Not when the output appears — the shell has echoed but has not
    // necessarily exited. The pane closing is the daemon saying the child has.
    loop {
        let frame = next(&mut source).await.expect("the pane should close");
        if frame.channel == PANE && frame.op == Op::Close {
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
        devpipe::proto::Frame::control(&devpipe::proto::FromClient::Open {
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
