//! End-to-end over a real socket: spawn the server on an ephemeral port,
//! create sessions over REST, attach over a websocket, and check that the
//! things the product depends on actually hold.
//!
//! The one that matters most is `session_survives_a_detach` — everything else
//! Devpipe claims rests on it.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "test-token";

struct Server {
    port: u16,
}

impl Server {
    async fn start() -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(devpiped::serve(listener, TOKEN.to_string()));
        Server { port }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    async fn create(&self, argv: &[&str], cols: u16, rows: u16) -> String {
        let body = serde_json::json!({ "argv": argv, "cols": cols, "rows": rows });
        let res = reqwest_post(&self.url("/v1/sessions"), &body).await;
        res["id"].as_str().unwrap().to_string()
    }

    async fn attach(&self, id: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
        let url = format!(
            "ws://127.0.0.1:{}/v1/sessions/{}/attach?token={}",
            self.port, id, TOKEN
        );
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        ws
    }
}

/// A POST with a JSON body, without pulling in an HTTP client crate for four
/// requests. Hand-rolling it keeps the dev-dependency list honest.
async fn reqwest_post(url: &str, body: &serde_json::Value) -> serde_json::Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let stripped = url.strip_prefix("http://").unwrap();
    let (host, path) = stripped.split_once('/').unwrap();
    let payload = serde_json::to_vec(body).unwrap();
    let mut stream = TcpStream::connect(host).await.unwrap();
    let head = format!(
        "POST /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&payload).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    serde_json::from_str(body).unwrap_or_else(|e| panic!("bad response {text:?}: {e}"))
}

/// Read frames until the accumulated output contains `needle`, or time out.
/// Terminal output arrives in whatever chunks the pty felt like, so asserting
/// on a single frame is inherently flaky.
async fn read_until(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    needle: &str,
    timeout: Duration,
) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("timed out waiting for {needle:?}; got:\n{acc}");
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => {
                acc.push_str(&String::from_utf8_lossy(&b));
                if acc.contains(needle) {
                    return acc;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("websocket error: {e}; got:\n{acc}"),
            Ok(None) => panic!("socket closed waiting for {needle:?}; got:\n{acc}"),
            Err(_) => panic!("timed out waiting for {needle:?}; got:\n{acc}"),
        }
    }
}

#[tokio::test]
async fn child_output_reaches_an_attached_client() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh", "-c", "echo marker-alpha; sleep 30"], 80, 24).await;
    let mut ws = server.attach(&id).await;
    read_until(&mut ws, "marker-alpha", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn client_input_reaches_the_child() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh"], 80, 24).await;
    let mut ws = server.attach(&id).await;

    ws.send(Message::Binary("echo marker-bravo\n".into())).await.unwrap();
    // The shell echoes the typed line and then its output, so the marker
    // appears twice; either occurrence proves the write landed.
    read_until(&mut ws, "marker-bravo", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn resize_is_visible_to_the_child() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh"], 80, 24).await;
    let mut ws = server.attach(&id).await;

    ws.send(Message::Text(r#"{"t":"resize","cols":120,"rows":40}"#.into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    ws.send(Message::Binary("stty size\n".into())).await.unwrap();
    let out = read_until(&mut ws, "40 120", Duration::from_secs(5)).await;
    assert!(out.contains("40 120"), "child should see the new winsize");
}

/// The product promise: close the client, the work keeps running, come back
/// and the screen is still there.
#[tokio::test]
async fn session_survives_a_detach() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh"], 80, 24).await;

    let mut ws = server.attach(&id).await;
    ws.send(Message::Binary("echo marker-charlie\n".into())).await.unwrap();
    read_until(&mut ws, "marker-charlie", Duration::from_secs(5)).await;

    // Drop the socket the way a backgrounded app does: without closing.
    drop(ws);
    tokio::time::sleep(Duration::from_millis(300)).await;

    // While nobody is watching, the child keeps working.
    let mut ws = server.attach(&id).await;
    let replayed = read_until(&mut ws, "marker-charlie", Duration::from_secs(5)).await;
    assert!(
        replayed.contains("marker-charlie"),
        "reattach must replay the screen the child painted while detached"
    );

    ws.send(Message::Binary("echo marker-delta\n".into())).await.unwrap();
    read_until(&mut ws, "marker-delta", Duration::from_secs(5)).await;
}

/// Output produced with nobody attached must still be on screen at reattach.
#[tokio::test]
async fn output_while_detached_is_not_lost() {
    let server = Server::start().await;
    let id = server
        .create(&["/bin/sh", "-c", "sleep 1; echo marker-echo; sleep 30"], 80, 24)
        .await;

    // Deliberately never attach until after the child has printed.
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let mut ws = server.attach(&id).await;
    read_until(&mut ws, "marker-echo", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn two_clients_see_the_same_session() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh"], 80, 24).await;

    let mut a = server.attach(&id).await;
    let mut b = server.attach(&id).await;

    a.send(Message::Binary("echo marker-foxtrot\n".into())).await.unwrap();
    read_until(&mut a, "marker-foxtrot", Duration::from_secs(5)).await;
    read_until(&mut b, "marker-foxtrot", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn a_bad_token_is_refused() {
    let server = Server::start().await;
    let id = server.create(&["/bin/sh"], 80, 24).await;
    let url = format!(
        "ws://127.0.0.1:{}/v1/sessions/{}/attach?token=wrong",
        server.port, id
    );
    assert!(
        tokio_tungstenite::connect_async(url).await.is_err(),
        "the wrong token must not get a pty"
    );
}

/// Ctrl+C must actually interrupt, not merely echo `^C`. The echo happens
/// either way, so a test that only looks at the screen passes while the child
/// keeps running.
#[tokio::test]
async fn ctrl_c_interrupts_the_foreground_child() {
    let server = Server::start().await;
    let id = server.create(&["/bin/bash", "--norc"], 80, 24).await;
    let mut ws = server.attach(&id).await;

    ws.send(Message::Binary("sleep 45\n".into())).await.unwrap();
    read_until(&mut ws, "sleep 45", Duration::from_secs(5)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    ws.send(Message::Binary(vec![0x03].into())).await.unwrap();

    // The marker must be something the shell COMPUTES. Asserting on a literal
    // string matches the shell's echo of the typed line, which happens even
    // while the foreground child still holds the terminal — a test that looks
    // right and proves nothing.
    ws.send(Message::Binary("echo $((6*7))-interrupted\n".into())).await.unwrap();
    read_until(&mut ws, "42-interrupted", Duration::from_secs(6)).await;
}

/// Same as above, but the client resizes first — which is what a real client
/// does the moment it lays out.
#[tokio::test]
async fn ctrl_c_still_interrupts_after_a_resize() {
    let server = Server::start().await;
    let id = server.create(&["/bin/bash", "--norc"], 90, 30).await;
    let mut ws = server.attach(&id).await;
    ws.send(Message::Text(r#"{"t":"resize","cols":69,"rows":70}"#.into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    ws.send(Message::Binary("sleep 45\n".into())).await.unwrap();
    read_until(&mut ws, "sleep 45", Duration::from_secs(5)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    ws.send(Message::Binary(vec![0x03].into())).await.unwrap();
    ws.send(Message::Binary("echo $((6*8))-after-resize\n".into())).await.unwrap();
    read_until(&mut ws, "48-after-resize", Duration::from_secs(6)).await;
}
