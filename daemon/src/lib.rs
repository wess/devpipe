//! Devpipe daemon: persistent terminal sessions over a websocket.
//!
//! One process per VPS, many sessions inside it. Sessions are created over
//! REST and attached over a websocket; detaching leaves the child running,
//! and reattaching replays the current screen.
//!
//! The wire format is deliberately dumb. Binary frames are raw pty bytes in
//! both directions — the client runs its own emulator, so the server has no
//! business interpreting them. Text frames are JSON control messages. Keeping
//! the two apart means no escaping, no framing header, and no ambiguity about
//! what a frame is.

mod files;
mod proxy;
mod replay;
pub mod scope;
mod session;
pub mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use session::Session;

#[derive(Clone)]
struct App {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    token: Arc<String>,
    next_id: Arc<AtomicU64>,
}

#[derive(Deserialize)]
struct CreateReq {
    #[serde(default)]
    argv: Vec<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}
fn default_cols() -> u16 { 80 }
fn default_rows() -> u16 { 24 }

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    argv: Vec<String>,
    cols: u16,
    rows: u16,
    title: String,
    alive: bool,
}

/// Control messages. Everything else on the wire is raw pty bytes.
///
/// No app-level keepalive: websocket ping/pong is a protocol frame and axum
/// already answers it, so adding our own would be a second timer measuring
/// the same thing.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientMsg {
    Resize { cols: u16, rows: u16 },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ServerMsg {
    /// Sent once on attach, before the replay bytes, so the client can size
    /// its emulator before parsing anything.
    Hello { id: String, cols: u16, rows: u16 },
    /// The client fell far enough behind that the backlog dropped frames;
    /// the bytes that follow are a fresh screen, not a continuation.
    Resync,
    Exit,
    /// Nothing is listening on that port of the box. Said in words rather than
    /// left as a close frame, because "connection refused" from a forwarded
    /// port is otherwise indistinguishable from the tunnel itself failing.
    Refused { port: u16, why: String },
}

/// Put the terminal and job-control signals back to their default
/// dispositions, so children forked from here inherit defaults.
///
/// Dispositions survive both fork and exec. A non-interactive shell that
/// starts a background job sets SIGINT and SIGQUIT to `SIG_IGN` in the child —
/// which is every way a daemon actually gets launched — and bash faithfully
/// restores that inherited ignore for each command it runs. The result is a
/// terminal where Ctrl+C looks completely correct at every layer you would
/// think to check: the byte arrives, `stty` reports `isig` and `intr = ^C`,
/// the foreground process group is right, and the line discipline does raise
/// SIGINT. The foreground job simply ignores it, and nothing can be
/// interrupted for the life of the session.
///
/// The deeper fix belongs in the child, between fork and exec, where it would
/// also cover an inherited signal mask. That is `pty`'s `pre_exec`, which
/// this crate does not own — see docs/spikes.md.
///
/// SIGPIPE, SIGHUP, SIGTERM and SIGCHLD are deliberately untouched: Rust
/// ignores SIGPIPE at startup so a write to a closed socket returns EPIPE
/// instead of killing the process, and a daemon launched under `nohup` is
/// meant to keep ignoring SIGHUP.
pub fn restore_default_signal_dispositions() {
    // SAFETY: `signal` with SIG_DFL is async-signal-safe and this runs before
    // any session thread exists.
    unsafe {
        for sig in [
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGTSTP,
            libc::SIGTTIN,
            libc::SIGTTOU,
        ] {
            libc::signal(sig, libc::SIG_DFL);
        }
    }
}

/// The routes, over a fresh empty registry. Tests bind an ephemeral port and
/// call `serve` directly rather than supervising a child process.
pub fn router(token: String) -> Router {
    let app = App {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        token: Arc::new(token),
        next_id: Arc::new(AtomicU64::new(1)),
    };
    Router::new()
        .route("/v1/health", get(|| async { "ok" }))
        .route("/v1/sessions", get(list_sessions).post(create_session))
        .route("/v1/sessions/{id}", delete(kill_session))
        .route("/v1/sessions/{id}/attach", get(attach))
        .route("/v1/forward", get(forward))
        // A dev server on the box, reachable from a browser. Every method, not
        // just GET: a preview that cannot POST is a preview of a page rather
        // than of an application.
        // Files on the box, in both directions. There was no way to move one
        // at all — not a spec for an agent to read, not an artifact it made.
        .route("/v1/fs/list", get(files::list))
        .route("/v1/fs/read", get(files::read))
        .route("/v1/fs/write", put(files::write))
        .route("/v1/fs/tar", get(files::tar))
        .route("/v1/fs/mkdir", post(files::mkdir))
        .route("/v1/fs/remove", delete(files::remove))
        .route("/v1/proxy/{port}", any(proxy::proxy_root))
        // Named separately because a wildcard matches at least one segment,
        // and `/` is exactly what a browser asks for first.
        .route("/v1/proxy/{port}/", any(proxy::proxy_root))
        .route("/v1/proxy/{port}/{*rest}", any(proxy::proxy_path))
        .with_state(app)
}

/// Plain HTTP. Used by the tests, which bind loopback on an ephemeral port,
/// and by anything already behind a tunnel.
pub async fn serve(listener: tokio::net::TcpListener, token: String) -> anyhow::Result<()> {
    restore_default_signal_dispositions();
    axum::serve(listener, router(token)).await?;
    Ok(())
}

/// TLS, terminated here rather than by a reverse proxy in front. One process
/// to install and supervise on a freshly provisioned box beats two.
pub async fn serve_tls(
    addr: std::net::SocketAddr,
    token: String,
    tls: &tls::Tls,
) -> anyhow::Result<()> {
    restore_default_signal_dispositions();
    // Named, rather than left to rustls to work out.
    //
    // Two crates here pull rustls with different backends — axum-server brings
    // aws-lc-rs, tokio-tungstenite brings ring — and with both compiled in
    // rustls refuses to guess. It refuses at *runtime*, from inside a worker
    // thread, as a panic reading "Could not automatically determine the
    // process-level CryptoProvider": the daemon starts, prints its
    // certificate fingerprint, and then dies on the first connection.
    //
    // Production has never hit it because a box runs this behind Caddy with
    // DEVPIPE_INSECURE, so nothing on a box takes this path. Anything standing
    // the daemon up on its own — which is the documented default and what
    // `deploy/deploy.sh` provisions — takes it every time.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let config = axum_server::tls_rustls::RustlsConfig::from_pem(
        tls.cert_pem.clone().into_bytes(),
        tls.key_pem.clone().into_bytes(),
    )
    .await?;
    axum_server::bind_rustls(addr, config)
        .serve(router(token).into_make_service())
        .await?;
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct TokenQuery {
    token: Option<String>,
}

/// Whatever credential the request carried, from either place it can be.
///
/// The query form exists because it is the one thing every websocket client can
/// do; the header is what everything else uses.
fn presented<'a>(headers: &'a HeaderMap, q: &'a TokenQuery) -> Option<&'a str> {
    if let Some(t) = q.token.as_deref() {
        return Some(t);
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

/// Constant time, because `==` on a secret leaks where two values diverge and
/// this runs on every request. A 32-byte random token is not realistically
/// recoverable that way over a network, which is the reason this was not
/// noticed sooner and not a reason to keep it.
fn same_secret(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// **The box's full credential**, which opens everything this daemon serves: a
/// shell, every file, a proxy to any port, a forward to any loopback socket.
///
/// Only the control plane should ever hold one. Anything a browser is given
/// goes through `authorized_attach` instead.
pub(crate) fn authorized(app: &App, headers: &HeaderMap, q: &TokenQuery) -> bool {
    presented(headers, q).map(|t| same_secret(t, app.token.as_str())).unwrap_or(false)
}

/// The full credential, **or** a scoped token that says only "attach to this".
///
/// This is the one endpoint with the weaker check, and deliberately: a browser
/// cannot set a header on a websocket, so whatever admits it to a terminal ends
/// up in a URL — in the page, in history, in the box's access log. Making that
/// value expire in two minutes and reach nothing but a pty is the difference
/// between a leak that costs a terminal session and one that costs the box.
pub(crate) fn authorized_attach(
    app: &App,
    headers: &HeaderMap,
    q: &TokenQuery,
    session: &str,
) -> bool {
    let Some(t) = presented(headers, q) else {
        return false;
    };
    same_secret(t, app.token.as_str()) || scope::allows_attach(app.token.as_str(), t, session)
}

async fn create_session(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(req): Json<CreateReq>,
) -> Response {
    if !authorized(&app, &headers, &q) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let id = format!("s{}", app.next_id.fetch_add(1, Ordering::Relaxed));
    match Session::spawn(id.clone(), req.argv, req.cols, req.rows) {
        Ok(s) => {
            let info = info_for(&s);
            app.sessions.write().unwrap().insert(id, s);
            (StatusCode::CREATED, Json(info)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn list_sessions(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !authorized(&app, &headers, &q) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut out: Vec<SessionInfo> =
        app.sessions.read().unwrap().values().map(info_for).collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Json(out).into_response()
}

async fn kill_session(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    if !authorized(&app, &headers, &q) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match app.sessions.write().unwrap().remove(&id) {
        Some(s) => {
            s.kill();
            StatusCode::NO_CONTENT.into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn info_for(s: &Arc<Session>) -> SessionInfo {
    let (cols, rows) = s.size();
    SessionInfo {
        id: s.id.clone(),
        argv: s.argv.clone(),
        cols,
        rows,
        title: s.title(),
        alive: s.is_alive(),
    }
}

#[derive(Deserialize)]
struct ForwardQuery {
    port: u16,
    token: Option<String>,
}

/// The port a dev server is on, reachable from your own machine.
///
/// This is `ssh -L`'s replacement, and it exists because `ssh -L` is gone:
/// forwarding is what turns a box into somebody's proxy, so SSH gets
/// `DisableForwarding yes` and this takes the one case that was ever
/// legitimate. Riding the daemon's socket also means no second inbound port,
/// no second credential, and no second thing to get wrong.
///
/// **Loopback only, and that is the whole security model here.** The
/// destination is not a parameter — it is always `127.0.0.1` on the box. An
/// endpoint that forwarded to an arbitrary host would be an open proxy for
/// anyone holding the box token: not a privilege escalation, since the owner
/// already has a shell, but it would make relaying through a box a one-liner
/// rather than something you have to set up on purpose. `security/abuse.ts`
/// explains why that distinction is the one that matters — the complaint
/// lands on the provider account every customer's box is created under.
async fn forward(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<ForwardQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let auth = TokenQuery { token: q.token.clone() };
    if !authorized(&app, &headers, &auth) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if q.port == 0 {
        return (StatusCode::BAD_REQUEST, "port 0 is not a port").into_response();
    }
    ws.on_upgrade(move |socket| splice(socket, q.port))
}

/// One forwarded connection: the websocket at one end, a loopback TCP socket
/// at the other, until either stops.
async fn splice(socket: WebSocket, port: u16) {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Connected before anything is piped, so a closed port is reported as a
    // close frame the client can explain rather than a socket that accepts
    // bytes and silently discards them.
    let upstream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => s,
        Err(e) => {
            let mut socket = socket;
            let _ = socket
                .send(Message::Text(
                    json(&ServerMsg::Refused { port, why: e.to_string() }).into(),
                ))
                .await;
            return;
        }
    };
    // Nagle off: a forwarded connection is mostly small request and response
    // frames, and batching them adds a round trip of latency to every one.
    let _ = upstream.set_nodelay(true);

    let (mut read, mut write) = upstream.into_split();
    let (mut tx, mut rx) = socket.split();

    let mut down = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.close().await;
    });

    let mut up = tokio::spawn(async move {
        while let Some(Ok(message)) = rx.next().await {
            match message {
                Message::Binary(bytes)
                    if write.write_all(&bytes).await.is_err() => {
                        break;
                    }
                Message::Close(_) => break,
                _ => {}
            }
        }
        // Half-close rather than drop: a client that has finished sending is
        // often still waiting to be answered, and tearing the socket down here
        // truncates the response.
        let _ = write.shutdown().await;
    });

    // Either direction ending ends the pair. A forwarded connection has no
    // meaning with one half of it gone.
    tokio::select! {
        _ = &mut down => up.abort(),
        _ = &mut up => down.abort(),
    }
}

async fn attach(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized_attach(&app, &headers, &q, &id) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session) = app.sessions.read().unwrap().get(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ws.on_upgrade(move |socket| drive(socket, session))
}

/// One attached client. Ends when the socket closes; the session does not
/// care either way.
async fn drive(socket: WebSocket, session: Arc<Session>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut tx, mut rx) = socket.split();

    // Subscribe before replaying. The other order drops everything the child
    // printed in between, which is exactly the output a user is waiting on
    // when they reattach to a running build.
    let mut feed = session.subscribe();

    let (cols, rows) = session.size();
    let hello = ServerMsg::Hello { id: session.id.clone(), cols, rows };
    if tx.send(Message::Text(json(&hello).into())).await.is_err() {
        return;
    }
    if tx.send(Message::Binary(session.replay().into())).await.is_err() {
        return;
    }

    let writer = session.clone();
    // Told by the loop below when the child has gone, so the announcement is
    // written by the task that owns the sink.
    let (child_gone, mut gone) = tokio::sync::oneshot::channel::<()>();
    let mut finished = Some(child_gone);
    let mut pump = tokio::spawn(async move {
        loop {
            let received = tokio::select! {
                // Biased so buffered output always wins a tie: the last thing a
                // command printed must reach the client before the notice that
                // it finished, or `dpctl run` loses its final line.
                biased;
                chunk = feed.recv() => chunk,
                _ = &mut gone => {
                    let _ = tx.send(Message::Text(json(&ServerMsg::Exit).into())).await;
                    break;
                }
            };
            match received {
                Ok(chunk) => {
                    if tx.send(Message::Binary(chunk.as_slice().to_vec().into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    // The client is too slow to be fed a gap. Tell it, then
                    // send a whole screen so it is correct rather than merely
                    // caught up.
                    let notice = json(&ServerMsg::Resync);
                    if tx.send(Message::Text(notice.into())).await.is_err() {
                        break;
                    }
                    if tx.send(Message::Binary(writer.replay().into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => {
                    let _ = tx.send(Message::Text(json(&ServerMsg::Exit).into())).await;
                    break;
                }
            }
        }
    });

    // The child dying is the one thing a client cannot work out for itself.
    //
    // `Exit` used to be sent only when the broadcast channel closed, which
    // happens when the *session* is dropped — and a session stays in the map
    // after its child is gone, so that never fired for a command that simply
    // finished. Every client was left waiting on a socket that would never say
    // anything again: the web terminal showed a live session, and
    // `dpctl run box -- cmd` hung forever after printing its output.
    //
    // Polled rather than signalled because `alive` is an AtomicBool and giving
    // it a Notify means threading one through the pty reader for a quarter of a
    // second of latency nobody can perceive.
    // `interval_at`, not `interval`: the latter completes its first tick
    // immediately, so a command that finishes fast — which is every `dpctl run`
    // — was declared over before the pump had written a single byte.
    let beat = std::time::Duration::from_millis(250);
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + beat, beat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = &mut pump => break,
            _ = heartbeat.tick() => {
                if !session.is_alive() {
                    // Whatever the child printed on its way out is already in
                    // the broadcast; yielding lets the pump drain it before the
                    // close, so the last line of output is not lost to the
                    // notice that the command finished.
                    // The pump announces it, because the pump owns the sink.
                    // It drains whatever the child printed on its way out
                    // first — see the `biased` there.
                    let _ = finished.take().map(|f| f.send(()));
                    // Give it a tick to write the frame before the socket goes.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    break;
                }
            }
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                match msg {
                    Message::Binary(b) => session.write(&b),
                    Message::Text(t) => match serde_json::from_str::<ClientMsg>(&t) {
                        Ok(ClientMsg::Resize { cols, rows }) => session.resize(cols, rows),
                        Err(_) => {}
                    },
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    pump.abort();
}


fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
}
