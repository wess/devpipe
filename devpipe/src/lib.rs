//! Devpipe: remote agentic development environments.
//!
//! A *host* is one machine, and it holds many *environments* — the thing this
//! iteration is built around, because the previous one provisioned a VPS per
//! environment at three minutes and a block volume each. An environment is a
//! workspace, a process tree, a private port space and a toolchain, and what
//! provides that is a `Backend`: a container today, the host itself in bridge
//! mode, a microVM later without anything above noticing.
//!
//! A client opens one socket to the host and asks for *panes* — today a pty,
//! later files, diffs, run events — which the host multiplexes back. Panes on
//! one socket may belong to different environments.
//!
//! Sessions belong to their environment rather than to the connection, so
//! closing a laptop lid costs nothing. They do not belong to the *daemon*
//! either: each is a keeper process holding its own pty behind a unix socket,
//! so an upgrade or a crash of `devpipe serve` is something the work survives.
//! See `keeper.rs`.

pub mod attach;
pub mod backend;
pub mod client;
pub mod environment;
pub mod host;
pub mod keeper;
pub mod machines;
pub mod marker;
pub mod proto;
pub mod replay;
pub mod secrets;
pub mod serve;
pub mod session;
pub mod term;
pub mod tunnel;
