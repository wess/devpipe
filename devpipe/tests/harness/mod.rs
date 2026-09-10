//! Shared plumbing for the end-to-end tests: a host on an ephemeral port, and
//! the handful of protocol moves every test makes.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use devpipe::backend::{Backend, docker::Docker, local::Local};
use devpipe::host::{Host, random_id};
use devpipe::proto::{self, Frame, FromClient, FromServer, HostInfo, Op, Pane};
use devpipe::serve;

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type Sink = SplitSink<Socket, Message>;
pub type Source = SplitStream<Socket>;

pub const PANE: u32 = 1;
pub const TOKEN: &str = "test-token";
/// Generous, because a container start is on the other side of some of these.
/// It only decides how long a hang takes to become a failure.
pub const PATIENCE: Duration = Duration::from_secs(60);

pub struct TestHost {
    pub addr: SocketAddr,
    pub dir: PathBuf,
    pub host: Arc<Host>,
    /// Set when a test drops this host only to open the same directory again
    /// — a daemon restart, which must not take the state with it.
    pub keep_state: bool,
    serving: tokio::task::JoinHandle<()>,
}

impl Drop for TestHost {
    fn drop(&mut self) {
        // The daemon stops. Whether anything else does is what the rest of
        // this is about.
        self.serving.abort();
        if self.keep_state {
            // A restart: the keepers are exactly what has to still be there
            // on the way back up.
            return;
        }
        // Sessions outlive the daemon on purpose, which in a test means they
        // outlive the test. Ending them here is the difference between a suite
        // that cleans up after itself and a machine slowly filling with idle
        // shells.
        for environment in self.host.all() {
            environment.close_now();
        }
        let _ = std::fs::remove_dir_all(self.host.runtime());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn scratch() -> PathBuf {
    std::env::temp_dir().join(format!("devpipe-test-{}", random_id(8)))
}

pub async fn serve_host(dir: PathBuf, backend: Arc<dyn Backend>) -> TestHost {
    // `current_exe` here is the test binary, which does not know how to hold a
    // pty. The daemon passes `None` and gets itself.
    let host = Host::open(
        &dir,
        backend,
        Some(TOKEN.into()),
        Some(test_image()),
        None,
        Some(env!("CARGO_BIN_EXE_devpipe").into()),
    )
    .await
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let serving = host.clone();
    let serving = tokio::spawn(async move {
        let _ = serve::run(listener, serving).await;
    });
    TestHost {
        addr,
        dir,
        host,
        keep_state: false,
        serving,
    }
}

/// A host with one `local` environment: the bridge case, and the cheap one to
/// test the pane protocol against.
pub async fn local_host() -> TestHost {
    let host = serve_host(scratch(), Arc::new(Local)).await;
    host.host
        .create("bridge".into(), None, vec![], None, None)
        .await
        .unwrap();
    host
}

/// The image the container tests run on. Overridable because a machine that
/// cannot reach a registry can still have something usable already pulled, and
/// a test suite that hangs on the network is worse than one that skips.
pub fn test_image() -> String {
    std::env::var("DEVPIPE_TEST_IMAGE").unwrap_or_else(|_| "alpine:3".into())
}

/// A runtime that answers *and* an image it already holds or can fetch. Both,
/// because `docker create` pulls, and a pull with nowhere to go does not fail
/// — it waits, and takes the test run with it.
pub fn docker_cli() -> Option<String> {
    let image = test_image();
    for cli in ["docker", "podman"] {
        if !ran(cli, &["info"], 20) {
            continue;
        }
        if ran(cli, &["image", "inspect", &image], 20) || ran(cli, &["pull", &image], 120) {
            return Some(cli.to_string());
        }
        eprintln!("{cli} is here but {image} is not, and cannot be fetched; skipping");
        return None;
    }
    None
}

fn ran(cli: &str, args: &[&str], seconds: u64) -> bool {
    let Ok(mut child) = std::process::Command::new(cli)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub async fn docker_host(cli: &str) -> TestHost {
    serve_host(scratch(), Arc::new(Docker::new(cli))).await
}

pub async fn greet(addr: SocketAddr, token: &str) -> (Sink, Source, Option<HostInfo>) {
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    let (mut sink, mut source) = socket.split();
    send(
        &mut sink,
        Frame::control(&FromClient::Hello {
            version: proto::VERSION,
            token: token.into(),
            client: "test".into(),
        }),
    )
    .await;
    match control(&mut source).await {
        Some(FromServer::Welcome { host, .. }) => (sink, source, Some(host)),
        _ => (sink, source, None),
    }
}

pub async fn open(
    sink: &mut Sink,
    source: &mut Source,
    environment: Option<String>,
    session: Option<String>,
    argv: &[&str],
) -> String {
    send(
        sink,
        Frame::control(&FromClient::Open {
            channel: PANE,
            pane: Pane::Pty {
                environment,
                session,
                argv: argv.iter().map(|a| a.to_string()).collect(),
                cols: 80,
                rows: 24,
            },
        }),
    )
    .await;
    match control(source).await {
        Some(FromServer::Opened { session, .. }) => session,
        other => panic!("expected the pane to open, got {other:?}"),
    }
}

pub async fn send(sink: &mut Sink, frame: Frame) {
    sink.send(Message::Binary(frame.encode().into()))
        .await
        .unwrap();
}

pub async fn next(source: &mut Source) -> Option<Frame> {
    loop {
        let msg = tokio::time::timeout(PATIENCE, source.next())
            .await
            .expect("the host went quiet")?;
        match msg.unwrap() {
            Message::Binary(bytes) => return Some(Frame::decode(&bytes).unwrap()),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

pub async fn control(source: &mut Source) -> Option<FromServer> {
    while let Some(frame) = next(source).await {
        if frame.channel == proto::CONTROL {
            return Some(frame.json().unwrap());
        }
    }
    None
}

/// Waits for a path to appear on the *host*.
///
/// The bind mount makes this the honest way to know a command inside an
/// environment actually ran. A terminal echoes what was typed, so waiting for
/// the text of a command to show up in the output proves only that somebody
/// typed it — which is how the first version of these tests passed while the
/// write it was checking had not happened.
pub async fn wait_for_file(path: &std::path::Path) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while tokio::time::Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Everything the pane paints until `needle` shows up, so a test never depends
/// on output arriving in one particular chunk.
pub async fn painted(source: &mut Source, needle: &str) -> String {
    let mut seen = String::new();
    while let Some(frame) = next(source).await {
        if frame.channel == PANE && frame.op == Op::Data {
            seen.push_str(&String::from_utf8_lossy(&frame.payload));
            if seen.contains(needle) {
                return seen;
            }
        }
        if frame.channel == PANE && frame.op == Op::Close {
            panic!("the pane closed before {needle:?} appeared; saw {seen:?}");
        }
    }
    panic!("the socket closed before {needle:?} appeared; saw {seen:?}");
}
