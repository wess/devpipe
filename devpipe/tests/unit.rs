//! The systemd unit is part of the product, and one line of it is load-bearing
//! in a way that no amount of Rust can defend.

/// Keepers exist so a restart of the daemon does not end every session on the
/// host. systemd's default `KillMode=control-group` signals every process in
/// the unit's cgroup, which includes them — and putting a keeper in its own
/// *process* group, which the daemon does, is a different thing and does not
/// help.
///
/// This was found on a real box, not here: the feature had passed its own
/// tests for a week by killing the daemon directly, which is not how a service
/// restarts.
#[test]
fn the_unit_does_not_take_the_sessions_with_it() {
    let unit = include_str!("../../deploy/devpipe.service");
    assert!(
        unit.lines().any(|l| l.trim() == "KillMode=process"),
        "deploy/devpipe.service must set KillMode=process, or systemd kills \
         every keeper when the daemon restarts"
    );
}

/// A daemon on a public interface is an environment on a public interface, and
/// an environment is a shell. Reaching one from elsewhere is ssh's job.
#[test]
fn the_unit_binds_loopback() {
    let unit = include_str!("../../deploy/devpipe.service");
    let exec = unit
        .lines()
        .find(|l| l.starts_with("ExecStart="))
        .expect("the unit should start something");
    assert!(exec.contains("127.0.0.1:"), "{exec}");
}
