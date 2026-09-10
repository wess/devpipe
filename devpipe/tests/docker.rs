//! The container backend, against a real runtime.
//!
//! Skipped when neither docker nor podman answers, because a laptop or a macOS
//! CI runner without one is not a failure — but nothing here is mocked, since
//! what is being tested is precisely whether the boundary is real.

mod harness;

use harness::*;

/// The pty lands *inside* the environment, and the workspace the host set up
/// is there when it arrives. Together those are the claim that an environment
/// is a place rather than a command.
#[tokio::test]
async fn a_pane_lands_inside_the_container() {
    let Some(cli) = docker_cli() else {
        eprintln!("no container runtime; skipping");
        return;
    };
    let host = docker_host(&cli).await;

    let workspace = scratch();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("marker"), "put-here-by-the-host").unwrap();

    let made = host
        .host
        .create(
            "inside".into(),
            Some(test_image()),
            vec![],
            Some(workspace.clone()),
            None,
        )
        .await
        .unwrap();

    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(
        &mut sink,
        &mut source,
        Some("inside".into()),
        None,
        &["/bin/sh"],
    )
    .await;

    // Three claims from one command line. The host's directory is visible at
    // /workspace; a write there reaches the host; and a write to /tmp does
    // not, because that /tmp is not this machine's. None of it depends on
    // which image the runtime happened to have.
    let nonce = format!("/tmp/devpipe-{}", devpipe::host::random_id(8));
    send(
        &mut sink,
        devpipe::proto::Frame::data(
            PANE,
            format!("cat /workspace/marker; echo in > /workspace/proof; echo in > {nonce}\n")
                .into_bytes(),
        ),
    )
    .await;

    let seen = painted(&mut source, "put-here-by-the-host").await;
    assert!(
        seen.contains("put-here-by-the-host"),
        "the workspace should be mounted: {seen:?}"
    );
    assert!(
        wait_for_file(&workspace.join("proof")).await,
        "a write inside the environment should land in the host's directory"
    );
    // The line ran to its end, so the /tmp write happened too — and is not here.
    assert!(
        !std::path::Path::new(&nonce).exists(),
        "{nonce} was written inside the environment and must not be on the host"
    );

    host.host.destroy(&made.spec.id).await.unwrap();
    let _ = std::fs::remove_dir_all(&workspace);
}

/// Every project wants 3000. On one shared host they cannot all have it, and
/// the old answer — a VPS each — is the thing this iteration exists to avoid.
#[tokio::test]
async fn two_environments_can_both_want_port_3000() {
    let Some(cli) = docker_cli() else {
        eprintln!("no container runtime; skipping");
        return;
    };
    let host = docker_host(&cli).await;

    let one = host
        .host
        .create("api".into(), Some(test_image()), vec![3000], None, None)
        .await
        .unwrap();
    let two = host
        .host
        .create("web".into(), Some(test_image()), vec![3000], None, None)
        .await
        .unwrap();

    let one = one.describe().await;
    let two = two.describe().await;
    assert_eq!(one.ports.len(), 1, "{:?}", one.ports);
    assert_eq!(two.ports.len(), 1, "{:?}", two.ports);
    assert_eq!(one.ports[0].inside, 3000);
    assert_eq!(two.ports[0].inside, 3000);
    assert_ne!(
        one.ports[0].outside, two.ports[0].outside,
        "the host ports have to differ or only one of them is reachable"
    );

    host.host.destroy(&one.id).await.unwrap();
    host.host.destroy(&two.id).await.unwrap();
}

/// Sleep and wake, which used to be three minutes and a block volume to
/// reconcile. The only thing that must survive is the thing people care about.
#[tokio::test]
async fn sleeping_an_environment_keeps_its_files() {
    let Some(cli) = docker_cli() else {
        eprintln!("no container runtime; skipping");
        return;
    };
    let host = docker_host(&cli).await;
    let made = host
        .host
        .create("sleeper".into(), Some(test_image()), vec![], None, None)
        .await
        .unwrap();
    let id = made.spec.id.clone();

    let note = made.spec.workspace.join("note");
    {
        let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
        open(
            &mut sink,
            &mut source,
            Some("sleeper".into()),
            None,
            &["/bin/sh"],
        )
        .await;
        send(
            &mut sink,
            devpipe::proto::Frame::data(
                PANE,
                b"echo written-before-sleeping > /workspace/note\n".to_vec(),
            ),
        )
        .await;
        // The host side of the mount, not the echo of the command: waiting for
        // the latter would let this pass with nothing written.
        assert!(wait_for_file(&note).await, "the note should reach the host");
    }

    host.host.stop(&id).await.unwrap();
    assert_eq!(
        host.host.get(Some(&id)).unwrap().describe().await.status,
        "stopped"
    );
    host.host.start(&id).await.unwrap();

    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(
        &mut sink,
        &mut source,
        Some("sleeper".into()),
        None,
        &["/bin/sh"],
    )
    .await;
    send(
        &mut sink,
        devpipe::proto::Frame::data(PANE, b"cat /workspace/note\n".to_vec()),
    )
    .await;
    let seen = painted(&mut source, "written-before-sleeping").await;
    assert!(seen.contains("written-before-sleeping"), "{seen:?}");

    host.host.destroy(&id).await.unwrap();
}

/// Secrets cross the boundary as `--env` on the exec rather than being baked
/// in at create time. It is a different path from bridge mode's, and it is the
/// one that matters: an agent in a container is what needs the key.
#[tokio::test]
async fn a_secret_reaches_a_session_inside_a_container() {
    let Some(cli) = docker_cli() else {
        eprintln!("no container runtime; skipping");
        return;
    };
    let host = docker_host(&cli).await;
    host.host
        .secrets()
        // A value with the shapes that break naive quoting: spaces, an equals
        // sign, and a quote. Nothing here goes through a shell, and this is
        // what says so.
        .set("DEVPIPE_LENT", "one two=three'four")
        .unwrap();

    let made = host
        .host
        .create("lent".into(), Some(test_image()), vec![], None, None)
        .await
        .unwrap();

    let (mut sink, mut source, _) = greet(host.addr, TOKEN).await;
    open(
        &mut sink,
        &mut source,
        Some("lent".into()),
        None,
        &["/bin/sh"],
    )
    .await;
    send(
        &mut sink,
        devpipe::proto::Frame::data(PANE, b"echo \"lent:$DEVPIPE_LENT:end\"\n".to_vec()),
    )
    .await;

    // The needle has to be something only the *output* can contain. ":end"
    // alone is in the command the terminal just echoed back, which is how the
    // first version of this passed while proving nothing.
    let seen = painted(&mut source, "four:end").await;
    assert!(
        seen.contains("lent:one two=three'four:end"),
        "the value should arrive as itself: {seen:?}"
    );

    host.host.destroy(&made.spec.id).await.unwrap();
}

/// A ceiling on an environment is the difference between one container dying
/// and the machine dying. On a small box `devpipe serve` is a plausible victim
/// of the OOM killer, and it takes every session on the host with it.
#[tokio::test]
async fn an_environment_can_be_given_a_memory_ceiling() {
    let Some(cli) = docker_cli() else {
        eprintln!("no container runtime; skipping");
        return;
    };
    let host = docker_host(&cli).await;
    let made = host
        .host
        .create(
            "bounded".into(),
            Some(test_image()),
            vec![],
            None,
            Some("256m".into()),
        )
        .await
        .unwrap();

    let seen = std::process::Command::new(&cli)
        .args([
            "inspect",
            "--format",
            "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}",
            &format!("devpipe-{}", made.spec.id),
        ])
        .output()
        .unwrap();
    let seen = String::from_utf8_lossy(&seen.stdout);
    let mut fields = seen.split_whitespace();
    assert_eq!(
        fields.next(),
        Some("268435456"),
        "the runtime should have been told 256m: {seen:?}"
    );
    // Always set, ceiling or not: a fork bomb should cost the environment and
    // not the machine's process table.
    assert_eq!(fields.next(), Some("4096"), "{seen:?}");

    assert_eq!(made.describe().await.memory.as_deref(), Some("256m"));
    host.host.destroy(&made.spec.id).await.unwrap();
}
