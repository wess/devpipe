//! Port forwarding, end to end over real sockets.
//!
//! `ssh -L`'s replacement, and the reason it exists is worth restating: SSH
//! forwarding is what turns a box into somebody's proxy, so it is disabled
//! there and this takes the one case that was ever legitimate — reaching a dev
//! server on your own machine.
//!
//! Which makes the loopback restriction the thing most worth testing. It is
//! not a parameter, and it must stay not a parameter: an endpoint that
//! forwarded anywhere would make relaying through a box a one-liner.

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-token";

async fn daemon() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(devpiped::serve(listener, TOKEN.to_string()));
    port
}

/// Something on the box worth reaching. Echoes with a prefix, so a test can
/// tell "the bytes arrived" from "the bytes came back by some other path".
async fn echo_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 1024];
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        return;
                    }
                    let mut out = b"echo:".to_vec();
                    out.extend_from_slice(&buf[..n]);
                    if socket.write_all(&out).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

async fn open(
    daemon_port: u16,
    target: u16,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://127.0.0.1:{daemon_port}/v1/forward?port={target}&token={TOKEN}");
    let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws
}

#[tokio::test]
async fn bytes_reach_a_port_on_the_box_and_come_back() {
    let daemon_port = daemon().await;
    let app = echo_server().await;
    let mut ws = open(daemon_port, app).await;

    ws.send(Message::Binary(b"hello".to_vec())).await.unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .expect("the forward went quiet")
        .expect("the socket closed")
        .unwrap();
    assert_eq!(reply.into_data()[..], b"echo:hello"[..]);
}

#[tokio::test]
async fn a_port_with_nothing_on_it_says_so() {
    // Connection refused arriving as a bare close frame is indistinguishable
    // from the tunnel itself failing, and the two want completely different
    // things from the person reading the message.
    let daemon_port = daemon().await;
    // Bound and dropped: a port nothing is listening on, without guessing.
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let mut ws = open(daemon_port, dead).await;

    let message = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .expect("no answer at all")
        .expect("the socket closed with nothing said")
        .unwrap();
    let text = message.into_text().unwrap();
    let said: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(said["t"], "refused");
    assert_eq!(said["port"], dead);
}

#[tokio::test]
async fn a_forward_needs_the_token() {
    // The same bearer as everything else on the daemon. Without this the
    // tunnel is an open door to every loopback service on somebody's box.
    let daemon_port = daemon().await;
    let app = echo_server().await;
    let url = format!("ws://127.0.0.1:{daemon_port}/v1/forward?port={app}");
    assert!(tokio_tungstenite::connect_async(url).await.is_err());

    let wrong = format!("ws://127.0.0.1:{daemon_port}/v1/forward?port={app}&token=nope");
    assert!(tokio_tungstenite::connect_async(wrong).await.is_err());
}

#[tokio::test]
async fn the_destination_is_not_something_a_caller_can_choose() {
    // The whole security model in one test. If a `host` parameter is ever
    // added, this fails — and it should, because a box that can be told to
    // forward anywhere is an open proxy for anyone holding its token, which is
    // exactly the abuse that gets the provider account locked.
    let daemon_port = daemon().await;
    let app = echo_server().await;
    let url = format!(
        "ws://127.0.0.1:{daemon_port}/v1/forward?port={app}&host=example.com&token={TOKEN}"
    );
    let mut ws = tokio_tungstenite::connect_async(url).await.unwrap().0;

    // Connected, and still spliced to loopback: the extra parameter was
    // ignored rather than honoured.
    ws.send(Message::Binary(b"hi".to_vec())).await.unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .expect("the forward went quiet")
        .expect("the socket closed")
        .unwrap();
    assert_eq!(reply.into_data()[..], b"echo:hi"[..]);
}

#[tokio::test]
async fn many_connections_do_not_share_a_tunnel() {
    // One websocket per TCP connection, so two clients cannot read each
    // other's bytes. The alternative — multiplexing over one socket — is where
    // that bug would live, which is most of why it is not done that way.
    let daemon_port = daemon().await;
    let app = echo_server().await;

    let mut first = open(daemon_port, app).await;
    let mut second = open(daemon_port, app).await;

    first.send(Message::Binary(b"one".to_vec())).await.unwrap();
    second.send(Message::Binary(b"two".to_vec())).await.unwrap();

    let a = first.next().await.unwrap().unwrap();
    let b = second.next().await.unwrap().unwrap();
    assert_eq!(a.into_data()[..], b"echo:one"[..]);
    assert_eq!(b.into_data()[..], b"echo:two"[..]);
}

/// The bare-shell case that `dpctl connect` reattaches on.
///
/// A session created with an empty argv is reported back with the shell the
/// daemon resolved — `[]` in, `["/bin/zsh"]` out. Comparing those literally is
/// what made every `connect` open a new shell instead of returning to the one
/// already running, so the persistence the whole product rests on was invisible
/// from the CLI.
#[tokio::test]
async fn a_bare_shell_is_listed_with_a_resolved_argv() {
    let port = daemon().await;
    let created = post(
        &format!("http://127.0.0.1:{port}/v1/sessions"),
        &serde_json::json!({ "argv": [], "cols": 80, "rows": 24 }),
    )
    .await;
    assert!(created["id"].is_string());

    let listed = get(&format!("http://127.0.0.1:{port}/v1/sessions")).await;
    let argv = listed[0]["argv"].as_array().unwrap();
    assert!(!argv.is_empty(), "an empty argv came back empty; the match in dpctl assumes otherwise");
    assert_eq!(argv.len(), 1, "a login shell is one entry, which is what dpctl matches on");
}

async fn post(url: &str, body: &serde_json::Value) -> serde_json::Value {
    request("POST", url, Some(body)).await
}

async fn get(url: &str) -> serde_json::Value {
    request("GET", url, None).await
}

/// Enough HTTP for three requests, without a client crate in dev-dependencies.
async fn request(method: &str, url: &str, body: Option<&serde_json::Value>) -> serde_json::Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url.trim_start_matches("http://");
    let (host, path) = rest.split_once('/').unwrap();
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    request.push_str(&payload);

    let mut socket = tokio::net::TcpStream::connect(host).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut raw = String::new();
    socket.read_to_string(&mut raw).await.unwrap();
    let (_, json) = raw.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(json.trim()).unwrap()
}
