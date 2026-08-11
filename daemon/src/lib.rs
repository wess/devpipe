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

mod replay;
mod session;
pub mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
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
struct TokenQuery {
    token: Option<String>,
}

/// Bearer header or `?token=`. The query form exists because it is the one
/// thing every websocket client can do; the header is what the real client
/// uses.
fn authorized(app: &App, headers: &HeaderMap, q: &TokenQuery) -> bool {
    if let Some(t) = q.token.as_deref() {
        if t == app.token.as_str() {
            return true;
        }
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == app.token.as_str())
        .unwrap_or(false)
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
        app.sessions.read().unwrap().values().map(|s| info_for(s)).collect();
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

async fn attach(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(&app, &headers, &q) {
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
    let mut pump = tokio::spawn(async move {
        loop {
            match feed.recv().await {
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

    loop {
        tokio::select! {
            _ = &mut pump => break,
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
