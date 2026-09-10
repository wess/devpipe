//! A program inside an environment asking for a browser.
//!
//! `claude /login` cannot open one: there is no display in the container, and
//! the person who would look at it is on a laptop the container cannot name.
//! The shim turns that into an escape sequence on the pty, and these are the
//! tests that it comes out the other end as something a client can draw.

mod harness;

use devpipe::proto::{Frame, Op, PaneEvent};
use harness::*;

/// Everything the pane says until it asks for a URL to be opened.
async fn opened_url(source: &mut Source) -> String {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while tokio::time::Instant::now() < deadline {
        let Some(frame) = next(source).await else {
            panic!("the socket closed before anything was opened");
        };
        if frame.channel == PANE
            && frame.op == Op::Event
            && let Ok(PaneEvent::Open { url }) = frame.json()
        {
            return url;
        }
    }
    panic!("nothing asked to be opened");
}

/// The whole point: a login flow inside an environment reaches the person
/// looking at it, without anything being mounted or any port being reachable.
#[tokio::test]
async fn a_program_can_ask_for_a_browser() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;

    // What the shim prints. Written out here rather than run from the image,
    // so this tests the daemon rather than whether docker is installed.
    send(
        &mut sink,
        Frame::data(
            PANE,
            b"printf '\\033]9998;devpipe;open;%s\\033\\\\' 'https://claude.ai/oauth/authorize?code=1'\n"
                .to_vec(),
        ),
    )
    .await;

    assert_eq!(
        opened_url(&mut source).await,
        "https://claude.ai/oauth/authorize?code=1"
    );
}

/// Anything in the environment can print that sequence — the agent, a build
/// script, a dependency's postinstall. A client that would render whatever
/// came out of it is a phishing delivery mechanism with devpipe's name on it,
/// so schemes that are not the web never become an event at all.
#[tokio::test]
async fn a_url_that_is_not_the_web_never_reaches_the_client() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;

    for hostile in ["javascript:alert(1)", "file:///etc/passwd"] {
        send(
            &mut sink,
            Frame::data(
                PANE,
                format!("printf '\\033]9998;devpipe;open;%s\\033\\\\' '{hostile}'\n").into_bytes(),
            ),
        )
        .await;
    }
    // A good one last. If either of the above had produced an event it would
    // be sitting ahead of this, which is how absence gets tested.
    send(
        &mut sink,
        Frame::data(
            PANE,
            b"printf '\\033]9998;devpipe;open;%s\\033\\\\' 'https://example.com/ok'\n".to_vec(),
        ),
    )
    .await;

    assert_eq!(opened_url(&mut source).await, "https://example.com/ok");
}

/// A tool inside an environment has to be able to tell that it is on a remote
/// machine, because for some of them the login flow that works there is a
/// different flag.
#[tokio::test]
async fn a_session_knows_it_is_in_devpipe() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    let session = open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;

    send(
        &mut sink,
        Frame::data(
            PANE,
            b"printf 'here:%s:%s:%s\\n' \"$DEVPIPE\" \"$DEVPIPE_ENVIRONMENT\" \"$DEVPIPE_SESSION\"\n"
                .to_vec(),
        ),
    )
    .await;

    let seen = painted(&mut source, &format!("here:1:bridge:{session}")).await;
    assert!(
        seen.contains(&format!("here:1:bridge:{session}")),
        "{seen:?}"
    );
}
