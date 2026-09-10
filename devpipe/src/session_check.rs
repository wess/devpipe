//! Asking the app who somebody is.
//!
//! The relay has accounts but no idea who anyone is, and the app has sign-in
//! but no way to mint a relay key. This is the join: the relay hands a browser's
//! session cookie back to the app's own `/auth/me` and believes what it is told.
//!
//! It works because a browser sends its cookies on a websocket handshake the
//! same way it sends them on a fetch. The cookie is `HttpOnly`, so the page's
//! own JavaScript cannot read it and cannot pass it along — but it rides the
//! upgrade request regardless, which means the relay can check a session that
//! the page itself is unable to hold.
//!
//! Hand-rolled rather than a HTTP client dependency, and that is a judgement
//! about scope: one GET, to one fixed URL, on loopback, with a body this only
//! reads two fields out of. A crate for that would be the largest thing in the
//! dependency list, added for forty lines of work.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Cap on what will be read back. The app is trusted, but "trusted" and
/// "allowed to make this process allocate without limit" are different things.
const CEILING: usize = 64 * 1024;

const PATIENCE: Duration = Duration::from_secs(5);

/// Where to ask, split once at startup rather than per request.
#[derive(Debug, Clone)]
pub struct Asking {
    host: String,
    port: u16,
    path: String,
}

impl Asking {
    /// `http://127.0.0.1:3000/api/auth/me`.
    ///
    /// Loopback only, deliberately. This request carries somebody's session
    /// cookie, and sending that anywhere it could be observed would be a worse
    /// bug than the one this feature fixes.
    pub fn parse(url: &str) -> Result<Asking> {
        let rest = url
            .strip_prefix("http://")
            .context("the session check must be plain http on loopback")?;
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, format!("/{path}")),
            None => (rest, "/".to_string()),
        };
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host.to_string(), port.parse().unwrap_or(80)),
            None => (authority.to_string(), 80),
        };
        if host != "127.0.0.1" && host != "localhost" && host != "::1" {
            bail!("the session check has to be on loopback, not {host}");
        }
        Ok(Asking { host, port, path })
    }

    /// Who this cookie belongs to, or nobody.
    pub async fn who(&self, cookie: &str) -> Result<String> {
        if cookie.is_empty() || cookie.len() > 8192 {
            bail!("no usable session");
        }
        // A header value with a newline in it is somebody trying to write their
        // own request; there is no legitimate cookie that contains one.
        if cookie.contains(['\r', '\n']) {
            bail!("that is not a cookie");
        }

        let mut stream = tokio::time::timeout(
            PATIENCE,
            TcpStream::connect((self.host.as_str(), self.port)),
        )
        .await
        .context("the app did not answer in time")??;

        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nCookie: {}\r\nAccept: application/json\r\n\
             Connection: close\r\n\r\n",
            self.path, self.host, cookie
        );
        stream.write_all(request.as_bytes()).await?;

        let mut said = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = tokio::time::timeout(PATIENCE, stream.read(&mut chunk)).await??;
            if n == 0 {
                break;
            }
            said.extend_from_slice(&chunk[..n]);
            if said.len() > CEILING {
                bail!("the app said more than makes sense");
            }
        }

        let text = String::from_utf8_lossy(&said);
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .context("the app did not answer with a status")?;
        if status != 200 {
            bail!("not signed in");
        }
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .context("the app sent no body")?;

        account_in(body).context("the app did not say who that is")
    }
}

/// The account name out of whatever shape `/auth/me` returns.
///
/// Tolerant on purpose: this reads an API that lives in another repository and
/// another language, and the difference between `{user:{…}}` and `{…}` is not
/// worth a deployment being broken over. It refuses rather than guesses when
/// there is no name at all.
fn account_in(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let person = value.get("user").unwrap_or(&value);
    for field in ["username", "email", "id"] {
        match person.get(field) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(serde_json::Value::Number(n)) => return Some(n.to_string()),
            _ => continue,
        }
    }
    None
}

/// One cookie out of a `Cookie:` header.
pub fn cookie_named(header: &str, name: &str) -> Option<String> {
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_check_that_leaves_the_machine_is_refused() {
        assert!(Asking::parse("http://example.com/api/auth/me").is_err());
        assert!(Asking::parse("https://127.0.0.1/api/auth/me").is_err());
        assert!(Asking::parse("http://127.0.0.1:3000/api/auth/me").is_ok());
    }

    #[test]
    fn the_path_and_port_survive_parsing() {
        let asking = Asking::parse("http://127.0.0.1:3000/api/auth/me").unwrap();
        assert_eq!(asking.port, 3000);
        assert_eq!(asking.path, "/api/auth/me");
    }

    /// Two shapes, because the API this reads lives in another repository and
    /// a deployment should not break over which one it chose.
    #[test]
    fn either_shape_of_answer_yields_a_name() {
        assert_eq!(
            account_in(r#"{"user":{"username":"wess","email":"a@b.c"}}"#).as_deref(),
            Some("wess")
        );
        assert_eq!(
            account_in(r#"{"username":"wess"}"#).as_deref(),
            Some("wess")
        );
        assert_eq!(account_in(r#"{"id":42}"#).as_deref(), Some("42"));
    }

    #[test]
    fn an_answer_with_nobody_in_it_is_refused() {
        assert!(account_in(r#"{"ok":true}"#).is_none());
        assert!(account_in("not json").is_none());
    }

    #[test]
    fn a_cookie_is_picked_out_of_the_header_it_shares() {
        let header = "other=1; dp_session=abc123; another=2";
        assert_eq!(
            cookie_named(header, "dp_session").as_deref(),
            Some("abc123")
        );
        assert!(cookie_named(header, "nothing").is_none());
    }

    /// A newline in a header value is somebody writing their own request.
    #[tokio::test]
    async fn a_cookie_with_a_newline_never_reaches_a_socket() {
        let asking = Asking::parse("http://127.0.0.1:1/api/auth/me").unwrap();
        let refused = asking
            .who("a\r\nX-Admin: yes")
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains("not a cookie"), "{refused}");
    }
}
