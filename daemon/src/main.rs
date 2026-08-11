//! Thin binary over the library. Everything worth testing lives in lib.rs so
//! the integration tests can bind an ephemeral port and call `serve` instead
//! of supervising a child process.

use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Answer --version instead of starting a server. A provisioning script
    // that asks a daemon its version and gets a server that never exits is a
    // hang with no obvious cause.
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("devpiped {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let token = std::env::var("DEVPIPE_TOKEN").unwrap_or_else(|_| "devpipe".into());
    let addr = std::env::var("DEVPIPE_ADDR").unwrap_or_else(|_| "0.0.0.0:7788".into());

    // TLS is the default. Plain HTTP stays available for loopback work and for
    // running behind something that already terminates TLS, but it has to be
    // asked for by name — a terminal multiplexer that quietly serves itself
    // unencrypted is worse than one that refuses to start.
    if std::env::var_os("DEVPIPE_INSECURE").is_some() {
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        eprintln!("devpiped listening on http://{addr} (INSECURE, no TLS)");
        return devpiped::serve(listener, token).await;
    }

    let dir = std::env::var("DEVPIPE_TLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("tls"));
    // Name the address we actually bind to, so tooling that checks hostnames
    // can reach us too. DEVPIPE_SANS carries the public address at
    // provisioning time, when the box learns what it is.
    let mut sans: Vec<String> = std::env::var("DEVPIPE_SANS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(host) = addr.rsplit_once(':').map(|(h, _)| h) {
        if host != "0.0.0.0" && host != "[::]" {
            sans.push(host.trim_matches(['[', ']']).to_string());
        }
    }
    let tls = devpiped::tls::load_or_generate(&dir, &sans)?;

    eprintln!("devpiped listening on wss://{addr}");
    eprintln!("certificate: {}", dir.join("cert.pem").display());
    eprintln!("pin this fingerprint in the client:");
    eprintln!("  {}", tls.fingerprint);
    eprintln!("  {}", tls.fingerprint_display());

    devpiped::serve_tls(addr.parse()?, token, &tls).await
}
