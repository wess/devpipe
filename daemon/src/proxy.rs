//! A port on this box, answered over the box's one inbound door.
//!
//! `/v1/forward` already carries a TCP connection to loopback, and it is the
//! right shape for `ssh -L`: the thing at the other end is a program on
//! somebody's laptop that wants a socket. It is the wrong shape for a browser,
//! which wants a *site* — an origin it can load, with the dev server's own
//! absolute paths still resolving and its websocket still upgrading.
//!
//! So this is a reverse proxy rather than a tunnel. The control plane maps a
//! preview hostname onto `/v1/proxy/{port}/…` here, and the dev server sees an
//! ordinary request arriving on loopback.
//!
//! **Loopback only, for the same reason `forward` is.** The destination is not
//! a parameter. An endpoint that proxied to an arbitrary host would make every
//! box an open relay for whoever holds its token — and the complaint lands on
//! the provider account every customer's box is created under.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::uri::InvalidUri;
use axum::http::{HeaderMap, Request, Response as HttpResponse, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;

use crate::{App, TokenQuery, authorized};

/// Everything after the port, and the query the browser sent.
///
/// The bearer is taken out of the query before forwarding. It arrives that way
/// on websocket upgrades, where a client cannot set a header, and the program
/// being previewed has no business seeing the credential for the machine it is
/// running on.
fn upstream_uri(rest: &str, query: Option<&str>) -> Result<Uri, InvalidUri> {
    let kept: Vec<&str> = query
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty() && !p.starts_with("token="))
        .collect();
    let path = if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{rest}")
    };
    if kept.is_empty() {
        path.parse()
    } else {
        format!("{path}?{}", kept.join("&")).parse()
    }
}

pub async fn proxy_root(
    state: State<App>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
    port: Path<u16>,
    req: Request<Body>,
) -> Response {
    run(state, headers, query, port.0, String::new(), req).await
}

pub async fn proxy_path(
    state: State<App>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
    path: Path<(u16, String)>,
    req: Request<Body>,
) -> Response {
    let (port, rest) = path.0;
    run(state, headers, query, port, rest, req).await
}

async fn run(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    port: u16,
    rest: String,
    req: Request<Body>,
) -> Response {
    if !authorized(&app, &headers, &q) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if port == 0 {
        return (StatusCode::BAD_REQUEST, "port 0 is not a port").into_response();
    }

    let Ok(uri) = upstream_uri(&rest, req.uri().query()) else {
        return (StatusCode::BAD_REQUEST, "that path cannot be forwarded").into_response();
    };

    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => s,
        // The wording matters more here than anywhere else in this file. The
        // overwhelmingly common cause is that nothing is listening yet, and a
        // bare 502 sends somebody to look at the proxy instead of at their own
        // `npm run dev`.
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Nothing is listening on port {port} of this box ({e})."),
            )
                .into_response();
        }
    };
    let _ = stream.set_nodelay(true);

    let (mut sender, connection) = match hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
    {
        Ok(pair) => pair,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("port {port}: {e}")).into_response(),
    };
    // `with_upgrades` rather than the plain future: without it a 101 from the
    // dev server is a dead end, and a dev server without its websocket is a
    // page that loads once and never live-reloads again.
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });

    let (mut parts, body) = req.into_parts();
    parts.uri = uri;
    // Taken out rather than forwarded: this is the handle on *our* half of the
    // connection, and it is what the splice below needs once both ends have
    // agreed to upgrade.
    let downstream_upgrade = parts.extensions.remove::<OnUpgrade>();
    // Loopback HTTP/1.1 requires a Host, and the one the browser sent names the
    // preview hostname rather than anything on this machine. Dev servers check
    // it: Vite refuses a host that is not in `allowedHosts`, which presents as
    // a blank page and is indistinguishable from the proxy being broken.
    parts
        .headers
        .insert(header::HOST, format!("127.0.0.1:{port}").parse().unwrap());

    let mut upstream = match sender.send_request(Request::from_parts(parts, body)).await {
        Ok(res) => res,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("port {port}: {e}")).into_response(),
    };

    if upstream.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut upstream);
        let (parts, _) = upstream.into_parts();
        if let Some(downstream_upgrade) = downstream_upgrade {
            // Both halves, joined by hand: once a connection has upgraded there
            // is no HTTP left to proxy, only bytes.
            tokio::spawn(async move {
                let (Ok(down), Ok(up)) = tokio::join!(downstream_upgrade, upstream_upgrade) else {
                    return;
                };
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(down), &mut TokioIo::new(up))
                        .await;
            });
        }
        return HttpResponse::from_parts(parts, Body::empty());
    }

    let (mut parts, incoming) = upstream.into_parts();
    // Says this answer came through the proxy rather than from the daemon's own
    // router. A box that has not been rebuilt since this endpoint existed
    // answers 404 to everything here, which is indistinguishable from a dev
    // server's own 404 — and sends somebody to debug their routes when the real
    // answer is that the machine needs waking.
    parts
        .headers
        .insert("x-devpipe-proxy", "1".parse().unwrap());
    HttpResponse::from_parts(parts, Body::new(incoming))
}

#[cfg(test)]
mod tests {
    use super::upstream_uri;

    #[test]
    fn keeps_the_path_and_query() {
        let uri = upstream_uri("assets/app.js", Some("v=3")).unwrap();
        assert_eq!(uri.to_string(), "/assets/app.js?v=3");
    }

    #[test]
    fn roots_a_bare_path() {
        assert_eq!(upstream_uri("", None).unwrap().to_string(), "/");
    }

    /// The credential never reaches the program being previewed.
    #[test]
    fn drops_the_token() {
        let uri = upstream_uri("hmr", Some("token=secret&id=4")).unwrap();
        assert_eq!(uri.to_string(), "/hmr?id=4");
        let only = upstream_uri("hmr", Some("token=secret")).unwrap();
        assert_eq!(only.to_string(), "/hmr");
    }
}
