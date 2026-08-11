//! Drives a session on an already-running daemon the way a real client does.
//!
//! This exists because the in-process integration tests and the shipped
//! binary are not the same environment, and a bug that appears in only one of
//! them is otherwise very hard to see. It found exactly that: Ctrl+C worked
//! under `cargo test` and did nothing in the running daemon, because a daemon
//! launched in the background inherits an ignored SIGINT.
//!
//! Usage:
//!   probe ws://127.0.0.1:7788/v1/sessions/s1/attach?token=spike

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::args().nth(1).expect("usage: probe <ws-url>");
    let (mut ws, _) = connect(&url).await?;

    ws.send(Message::Binary("sleep 40\n".into())).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;

    eprintln!("--- sending 0x03 ---");
    ws.send(Message::Binary(vec![0x03].into())).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Computed, not a literal: asserting on a string the client typed would
    // match the shell echoing it back while still blocked in `sleep`.
    ws.send(Message::Binary("echo $((6*7))-alive\n".into())).await?;

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
    println!("{acc}");
    println!(
        "\n=== interrupt {} ===",
        if acc.contains("42-alive") { "WORKED" } else { "DID NOT FIRE" }
    );
    Ok(())
}

/// Connects without verifying the certificate. These are diagnostics run by
/// hand against a box we just provisioned; the client that matters pins.
async fn connect(
    url: &str,
) -> anyhow::Result<(
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
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
    let connector =
        tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config));
    Ok(tokio_tungstenite::connect_async_tls_with_config(
        url,
        None,
        false,
        Some(connector),
    )
    .await?)
}
