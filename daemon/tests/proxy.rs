//! A dev server on the box, reached the way a browser reaches a site.
//!
//! `forward.rs` covers the tunnel a laptop uses. This covers the other half:
//! the control plane maps a preview hostname onto `/v1/proxy/{port}/…`, so
//! what matters here is that an ordinary HTTP request survives the trip intact
//! — path, query, method, body, status — and that a websocket upgrade does
//! too, because a dev server whose live-reload socket dies is a page that
//! silently stops updating.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "test-token";

async fn daemon() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(devpiped::serve(listener, TOKEN.to_string()));
    port
}

/// A dev server, near enough. Answers every request with a line describing
/// what it received, so a test can assert on what actually arrived rather than
/// on what was sent.
async fn dev_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                let first = raw.lines().next().unwrap_or("").to_string();
                let host = raw
                    .lines()
                    .find(|l| l.to_lowercase().starts_with("host:"))
                    .unwrap_or("")
                    .to_string();

                // A live-reload socket, if that is what this is.
                if raw.to_lowercase().contains("upgrade: websocket") {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                              Connection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n",
                        )
                        .await;
                    // Raw bytes from here on, which is the point of an upgrade.
                    let mut relay = vec![0u8; 1024];
                    while let Ok(got) = socket.read(&mut relay).await {
                        if got == 0 {
                            return;
                        }
                        let mut out = b"pong:".to_vec();
                        out.extend_from_slice(&relay[..got]);
                        if socket.write_all(&out).await.is_err() {
                            return;
                        }
                    }
                    return;
                }

                let body = format!(
                    "{first}\n{host}\n{}",
                    raw.split("\r\n\r\n").nth(1).unwrap_or("")
                );
                let _ = socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    port
}

/// One request, and everything the box said back — status line included.
async fn through(daemon_port: u16, request: &str) -> String {
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", daemon_port))
        .await
        .unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut raw = String::new();
    socket.read_to_string(&mut raw).await.unwrap();
    raw
}

#[tokio::test]
async fn a_page_comes_back_with_its_path_and_query_intact() {
    let daemon_port = daemon().await;
    let app = dev_server().await;
    let answer = through(
        daemon_port,
        &format!(
            "GET /v1/proxy/{app}/assets/app.js?v=3 HTTP/1.1\r\nHost: p-abc.devpipe.com\r\n\
             Authorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(
        answer.contains("GET /assets/app.js?v=3 HTTP/1.1"),
        "{answer}"
    );
}

#[tokio::test]
async fn the_dev_server_is_told_it_is_being_asked_on_loopback() {
    // Vite and webpack-dev-server both check Host and refuse names they do not
    // recognise, which presents as a blank page rather than as an error — so
    // forwarding the preview hostname unchanged looks exactly like the proxy
    // being broken.
    let daemon_port = daemon().await;
    let app = dev_server().await;
    let answer = through(
        daemon_port,
        &format!(
            "GET /v1/proxy/{app}/ HTTP/1.1\r\nHost: p-abc.devpipe.com\r\n\
             Authorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    // Lowercased on the way out: hyper normalises header names, and the dev
    // server echoes back what it actually received.
    assert!(
        answer
            .to_lowercase()
            .contains(&format!("host: 127.0.0.1:{app}")),
        "{answer}"
    );
    assert!(!answer.contains("p-abc.devpipe.com"), "{answer}");
}

#[tokio::test]
async fn a_post_keeps_its_body() {
    let daemon_port = daemon().await;
    let app = dev_server().await;
    let answer = through(
        daemon_port,
        &format!(
            "POST /v1/proxy/{app}/api/save HTTP/1.1\r\nHost: p-abc.devpipe.com\r\n\
             Authorization: Bearer {TOKEN}\r\nContent-Length: 11\r\nConnection: close\r\n\r\n\
             hello=world"
        ),
    )
    .await;
    assert!(answer.contains("POST /api/save"), "{answer}");
    assert!(answer.contains("hello=world"), "{answer}");
}

#[tokio::test]
async fn a_preview_needs_the_token() {
    let daemon_port = daemon().await;
    let app = dev_server().await;
    let answer = through(
        daemon_port,
        &format!("GET /v1/proxy/{app}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
}

#[tokio::test]
async fn a_port_with_nothing_on_it_says_which_port() {
    let daemon_port = daemon().await;
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let answer = through(
        daemon_port,
        &format!(
            "GET /v1/proxy/{dead}/ HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\
             Connection: close\r\n\r\n"
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 502"), "{answer}");
    assert!(answer.contains(&format!("port {dead}")), "{answer}");
}

/// The live-reload socket, which is the half that quietly does not work if the
/// proxy forgets `with_upgrades`.
#[tokio::test]
async fn a_websocket_upgrade_passes_through() {
    let daemon_port = daemon().await;
    let app = dev_server().await;

    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", daemon_port))
        .await
        .unwrap();
    socket
        .write_all(
            format!(
                "GET /v1/proxy/{app}/hmr HTTP/1.1\r\nHost: p-abc.devpipe.com\r\n\
                 Authorization: Bearer {TOKEN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                 Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let n = socket.read(&mut byte).await.unwrap();
        assert!(n > 0, "the connection closed before the handshake finished");
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");

    // Past the handshake there is no HTTP left, only bytes — in both
    // directions, which is what a splice has to prove.
    socket.write_all(b"ping").await.unwrap();
    let mut back = vec![0u8; 9];
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        socket.read_exact(&mut back),
    )
    .await
    .expect("the upgraded connection went quiet")
    .unwrap();
    assert_eq!(&back, b"pong:ping");
}
