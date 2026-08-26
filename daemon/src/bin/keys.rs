//! Send keystrokes to a session and dump what comes back.
//!
//! Driving a TUI from the host is the only way to script it — the client is a
//! simulator with no keyboard attached to it.
//!
//! Usage:
//!   keys <ws-url> <text>...
//!
//! `\r` sends Return, `\e` sends Escape, `\t` Tab, `\x03` Ctrl+C. Multiple
//! arguments are sent in order with a short gap, so a TUI has time to redraw
//! between them.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn unescape(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        match chars.next() {
            Some('r') => out.push(b'\r'),
            Some('n') => out.push(b'\n'),
            Some('t') => out.push(b'\t'),
            Some('e') => out.push(0x1b),
            Some('x') => {
                let hex: String = chars.by_ref().take(2).collect();
                if let Ok(b) = u8::from_str_radix(&hex, 16) {
                    out.push(b);
                }
            }
            Some(other) => out.push(other as u8),
            None => out.push(b'\\'),
        }
    }
    out
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("usage: keys <ws-url> <text>...");
    let sends: Vec<String> = args.collect();

    let (mut ws, _) = connect(&url).await?;

    // Let the replay land before typing into it.
    tokio::time::sleep(Duration::from_millis(700)).await;
    for s in &sends {
        ws.send(Message::Binary(unescape(s).into())).await?;
        tokio::time::sleep(Duration::from_millis(900)).await;
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    let mut acc = String::new();
    while tokio::time::Instant::now() < deadline {
        let left = deadline - tokio::time::Instant::now();
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => acc.push_str(&String::from_utf8_lossy(&b)),
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
    // Strip escape sequences so the output is readable in a log.
    let mut plain = String::new();
    let mut chars = acc.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            while let Some(&n) = chars.peek() {
                chars.next();
                if n.is_ascii_alphabetic() || n == '~' {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    println!("{plain}");
    Ok(())
}

/// Connects without verifying the certificate. These are diagnostics run by
/// hand against a box we just provisioned; the client that matters pins.
async fn connect(
    url: &str,
) -> anyhow::Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::handshake::client::Response,
)> {
    #[derive(Debug)]
    struct NoVerify;
    impl rustls::client::danger::ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &[rustls::pki_types::CertificateDer<'_>],
            _: &rustls::pki_types::ServerName<'_>,
            _: &[u8],
            _: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            rustls::crypto::aws_lc_rs::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }

    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(NoVerify))
        .with_no_client_auth();
    let connector = tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config));
    Ok(tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(connector)).await?)
}
