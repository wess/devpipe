//! What a browser is given, and what it must not reach with it.
//!
//! The control plane used to hand the page the box's own bearer, because a
//! websocket cannot carry an `Authorization` header and something has to go in
//! the URL. That token opens a shell, every file on the box, a proxy to any
//! port and a forward to any loopback socket. These tests are the fence: the
//! scoped token attaches to a terminal and is refused by everything else.

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "test-token";

async fn daemon() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(devpiped::serve(listener, TOKEN.to_string()));
    port
}

/// The status line of one request, which is all these assert on.
async fn status(port: u16, head: &str) -> String {
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    // Bounded: a refused websocket upgrade is answered and then the connection
    // is simply left open, so reading to EOF here waits forever. The status
    // line is the whole assertion and it arrives immediately.
    let mut raw = vec![0u8; 4096];
    let n = tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut raw))
        .await
        .expect("no answer within five seconds")
        .unwrap_or(0);
    String::from_utf8_lossy(&raw[..n])
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

async fn create_session(port: u16) -> String {
    let body = serde_json::json!({ "argv": ["/bin/cat"], "cols": 80, "rows": 24 }).to_string();
    let head = format!(
        "POST /v1/sessions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    let _ = socket.read_to_end(&mut raw).await;
    let text = String::from_utf8_lossy(&raw);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
    v["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_scoped_token_attaches_to_a_terminal() {
    let port = daemon().await;
    let id = create_session(port).await;
    let scoped = devpiped::scope::sign(TOKEN, devpiped::scope::ATTACH, 120);

    let url = format!("ws://127.0.0.1:{port}/v1/sessions/{id}/attach?token={scoped}");
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("scoped token refused");

    // The hello frame proves it is really attached rather than merely upgraded.
    let first = ws.next().await.unwrap().unwrap();
    assert!(first.to_text().unwrap().contains("hello"), "got {first:?}");
}

/// The whole reason the scoped token exists. Each of these is something the
/// full box token opens and a browser has no business reaching.
#[tokio::test]
async fn a_scoped_token_reaches_nothing_but_the_terminal() {
    let port = daemon().await;
    let scoped = devpiped::scope::sign(TOKEN, devpiped::scope::ATTACH, 120);

    let forbidden = [
        format!("GET /v1/fs/list?path=/etc&token={scoped} HTTP/1.1"),
        format!("GET /v1/fs/read?path=/etc/hosts&token={scoped} HTTP/1.1"),
        format!("GET /v1/fs/tar?path=/etc&token={scoped} HTTP/1.1"),
        format!("GET /v1/proxy/8080/?token={scoped} HTTP/1.1"),
        format!("GET /v1/sessions?token={scoped} HTTP/1.1"),
    ];

    for line in forbidden {
        let head = format!("{line}\r\nHost: x\r\nConnection: close\r\n\r\n");
        let got = status(port, &head).await;
        assert!(got.contains("401"), "{line} → {got}");
    }

    // `/v1/forward` is a websocket, so it needs a real upgrade request: the
    // extractor rejects a plain GET with 400 before the handler runs, and a 400
    // would pass a "not 200" assertion while proving nothing about the token.
    let head = format!(
        "GET /v1/forward?port=22&token={scoped} HTTP/1.1\r\nHost: x\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    let got = status(port, &head).await;
    assert!(got.contains("401"), "/v1/forward → {got}");
}

/// Spawning a shell is the one that would undo the whole exercise: a token that
/// can create a session could create one running anything.
#[tokio::test]
async fn a_scoped_token_cannot_spawn_a_shell() {
    let port = daemon().await;
    let scoped = devpiped::scope::sign(TOKEN, devpiped::scope::ATTACH, 120);
    let body = serde_json::json!({ "argv": ["/bin/sh"], "cols": 80, "rows": 24 }).to_string();
    let head = format!(
        "POST /v1/sessions?token={scoped} HTTP/1.1\r\nHost: x\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    assert!(status(port, &head).await.contains("401"));
}

/// Deleting somebody's running build is not attaching to it.
#[tokio::test]
async fn a_scoped_token_cannot_kill_a_session() {
    let port = daemon().await;
    let id = create_session(port).await;
    let scoped = devpiped::scope::sign(TOKEN, devpiped::scope::ATTACH, 120);
    let head = format!(
        "DELETE /v1/sessions/{id}?token={scoped} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    );
    assert!(status(port, &head).await.contains("401"));
}

#[tokio::test]
async fn an_expired_scoped_token_does_not_attach() {
    let port = daemon().await;
    let id = create_session(port).await;
    // Signed with a lifetime already behind us.
    let stale = devpiped::scope::sign(TOKEN, devpiped::scope::ATTACH, 0);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let head = format!(
        "GET /v1/sessions/{id}/attach?token={stale} HTTP/1.1\r\nHost: x\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    assert!(status(port, &head).await.contains("401"));
}

/// A share is scoped to the session it was made for, so being given one must
/// not become a way into every other terminal on the box.
#[tokio::test]
async fn a_session_scoped_token_does_not_open_a_sibling() {
    let port = daemon().await;
    let mine = create_session(port).await;
    let theirs = create_session(port).await;
    let scoped = devpiped::scope::sign(TOKEN, &format!("attach:{mine}"), 120);

    let ok = format!("ws://127.0.0.1:{port}/v1/sessions/{mine}/attach?token={scoped}");
    assert!(tokio_tungstenite::connect_async(ok).await.is_ok());

    let head = format!(
        "GET /v1/sessions/{theirs}/attach?token={scoped} HTTP/1.1\r\nHost: x\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    assert!(status(port, &head).await.contains("401"));
}

/// The control plane still holds the real credential and must keep working.
#[tokio::test]
async fn the_box_token_still_opens_everything() {
    let port = daemon().await;
    let head = format!(
        "GET /v1/sessions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"
    );
    assert!(status(port, &head).await.contains("200"));
}
