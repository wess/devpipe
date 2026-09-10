//! A host holds environments, and keeps holding them.

mod harness;

use std::sync::Arc;

use devpipe::backend::local::Local;
use harness::*;

/// The whole point of this iteration. The old design put one VPS behind each
/// environment; losing the daemon meant reconciling snapshots and volumes.
/// Here the state file is the only thing that has to survive, and it does.
#[tokio::test]
async fn environments_outlive_the_daemon() {
    let dir = scratch();
    let mut first = serve_host(dir.clone(), Arc::new(Local)).await;
    first.keep_state = true;
    let made = first
        .host
        .create("survivor".into(), None, vec![], None, None)
        .await
        .unwrap();
    let id = made.spec.id.clone();
    // Forget everything in memory, exactly as a restart would.
    drop(first);

    let again = serve_host(dir.clone(), Arc::new(Local)).await;
    let (_sink, _source, welcome) = greet(again.addr, TOKEN).await;
    let listed = welcome.expect("welcome").environments;
    assert_eq!(
        listed.len(),
        1,
        "the environment should be adopted: {listed:?}"
    );
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].name, "survivor");
}

/// The name ends up in `<project>.<user>.devpipe.com`, so anything DNS cannot
/// carry has to be refused while the person who typed it is still watching.
#[tokio::test]
async fn a_name_dns_cannot_carry_is_refused() {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    for bad in [
        "Web",
        "my project",
        "-leading",
        "trailing-",
        "",
        "under_score",
    ] {
        assert!(
            host.host
                .create(bad.into(), None, vec![], None, None)
                .await
                .is_err(),
            "{bad:?} should not be a name"
        );
    }
    assert!(
        host.host
            .create("web-2".into(), None, vec![], None, None)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_name_is_claimed_once() {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    host.host
        .create("web".into(), None, vec![], None, None)
        .await
        .unwrap();
    let again = host
        .host
        .create("web".into(), None, vec![], None, None)
        .await;
    assert!(again.is_err(), "a second environment cannot take the name");
}

/// Nothing separates two local environments — same ports, same files, same
/// processes — so offering a second one would only be a way to lose work.
#[tokio::test]
async fn the_local_backend_holds_exactly_one_environment() {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    host.host
        .create("mine".into(), None, vec![], None, None)
        .await
        .unwrap();
    let second = host
        .host
        .create("also-mine".into(), None, vec![], None, None)
        .await;
    assert!(
        second.is_err(),
        "local is the host; there is only one of it"
    );
}

/// Naming nothing is how bridge mode stays a one-word command, and it must
/// stop working the moment that is ambiguous rather than pick for you.
#[tokio::test]
async fn the_only_environment_needs_no_name() {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    assert!(
        host.host.get(None).is_err(),
        "with none, there is nothing to mean"
    );
    host.host
        .create("only".into(), None, vec![], None, None)
        .await
        .unwrap();
    assert_eq!(host.host.get(None).unwrap().spec.name, "only");
    assert_eq!(host.host.get(Some("only")).unwrap().spec.name, "only");
}
