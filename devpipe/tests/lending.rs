//! What a host lends its environments, and what it keeps.

mod harness;

use std::sync::Arc;

use devpipe::backend::local::Local;
use devpipe::host::Host;
use devpipe::proto::Frame;
use harness::*;

/// A token minted per run cannot be used by anything that restarts on its own.
/// The unit comes back, every saved token is wrong, and the person who has to
/// notice is the one whose session just stopped reconnecting.
#[tokio::test]
async fn a_host_keeps_the_token_it_minted() {
    let dir = scratch();
    let backend = Arc::new(Local);

    let first = Host::open(&dir, backend.clone(), None, None, None, None)
        .await
        .unwrap();
    let runtime = first.runtime().to_path_buf();
    let minted = std::fs::read_to_string(dir.join("token")).unwrap();
    assert!(
        !minted.trim().is_empty(),
        "a token should have been written"
    );
    assert!(first.authenticate(minted.trim()));

    drop(first);
    let again = Host::open(&dir, backend, None, None, None, None)
        .await
        .unwrap();
    assert!(
        again.authenticate(minted.trim()),
        "the token has to survive a restart or nothing can reconnect after one"
    );

    let _ = std::fs::remove_dir_all(&runtime);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Only the owner. A token beside a state directory that anyone on the box can
/// read is not a token.
#[cfg(unix)]
#[tokio::test]
async fn the_token_is_not_readable_by_the_rest_of_the_machine() {
    use std::os::unix::fs::PermissionsExt;

    let dir = scratch();
    let host = Host::open(&dir, Arc::new(Local), None, None, None, None)
        .await
        .unwrap();
    host.secrets().set("GH_TOKEN", "ghp-nothing-real").unwrap();

    for name in ["token", "env"] {
        let mode = std::fs::metadata(dir.join(name))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "{name} is readable by somebody else");
    }

    let _ = std::fs::remove_dir_all(host.runtime());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The reason secrets are read when a session starts rather than when the
/// environment was made: a key rotated this morning has to reach a container
/// created last week, without rebuilding it.
#[tokio::test]
async fn a_session_is_lent_the_secrets_as_they_are_now() {
    let host = local_host().await;
    host.host
        .secrets()
        .set("DEVPIPE_LENT", "first-value")
        .unwrap();

    let (mut sink, mut source, welcome) = greet(host.addr, TOKEN).await;
    assert_eq!(
        welcome.expect("welcome").secrets,
        vec!["DEVPIPE_LENT".to_string()],
        "the welcome should name the secrets and never carry their values"
    );

    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;
    send(
        &mut sink,
        Frame::data(PANE, b"echo lent:$DEVPIPE_LENT\n".to_vec()),
    )
    .await;
    let seen = painted(&mut source, "lent:first-value").await;
    assert!(seen.contains("lent:first-value"), "{seen:?}");

    // Rotate it, and start a *new* session. The one above keeps what it was
    // given, which is the honest behaviour: its process already has it.
    host.host
        .secrets()
        .set("DEVPIPE_LENT", "second-value")
        .unwrap();
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(&mut sink, &mut source, None, None, &["/bin/sh"]).await;
    send(
        &mut sink,
        Frame::data(PANE, b"echo lent:$DEVPIPE_LENT\n".to_vec()),
    )
    .await;
    let seen = painted(&mut source, "lent:second-value").await;
    assert!(seen.contains("lent:second-value"), "{seen:?}");
}

/// A secret that has been removed is not lent again, and the file it lived in
/// is the only copy — nothing reads it back out over the socket.
#[tokio::test]
async fn a_removed_secret_stops_being_lent() {
    let host = local_host().await;
    let secrets = host.host.secrets();
    secrets.set("DEVPIPE_GONE", "value").unwrap();
    assert!(secrets.remove("DEVPIPE_GONE").unwrap());
    assert!(
        !secrets.remove("DEVPIPE_GONE").unwrap(),
        "removing it twice should say so rather than pretend"
    );
    assert!(secrets.names().is_empty());

    let (_sink, _source, welcome) = greet(host.addr, TOKEN).await;
    assert!(welcome.expect("welcome").secrets.is_empty());
}

/// An environment named after a repository should have the repository in it.
#[tokio::test]
async fn a_repository_lands_in_the_workspace() {
    let origin = scratch();
    let made = std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&origin)
        .status();
    if !matches!(made, Ok(status) if status.success()) {
        eprintln!("no git; skipping");
        return;
    }

    let host = serve_host(scratch(), Arc::new(Local)).await;
    let environment = host
        .host
        .create("cloned".into(), None, vec![], None, None)
        .await
        .unwrap();
    environment
        .clone_repo(&origin.display().to_string())
        .await
        .unwrap();
    assert!(
        environment.spec.workspace.join(".git").exists(),
        "the clone should have landed in the workspace"
    );

    // Twice is a mistake, and doing it quietly would be a way to lose work.
    assert!(
        environment
            .clone_repo(&origin.display().to_string())
            .await
            .is_err(),
        "cloning over files already there should be refused"
    );

    let _ = std::fs::remove_dir_all(&origin);
}

/// A clone that fails takes the environment with it. The alternative is an
/// environment named after a repository that is not in it, found out later.
#[tokio::test]
async fn a_failed_clone_leaves_nothing_behind() {
    let host = local_host().await;
    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;

    send(
        &mut sink,
        Frame::control(&devpipe::proto::FromClient::CreateEnvironment {
            name: "doomed".into(),
            image: None,
            ports: vec![],
            repo: Some("/nowhere/at/all/nothing.git".into()),
            memory: None,
        }),
    )
    .await;

    match control(&mut source).await {
        Some(devpipe::proto::FromServer::Error { .. }) => {}
        other => panic!("expected the failure to be reported, got {other:?}"),
    }
    assert!(
        host.host.get(Some("doomed")).is_err(),
        "the half-made environment should have been taken back"
    );
}
