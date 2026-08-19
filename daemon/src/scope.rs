//! Narrow, short-lived tokens for the one credential a browser has to hold.
//!
//! The box's own bearer opens everything this daemon serves: a pty, every file
//! under `/v1/fs`, a proxy to any listening port, a forward to any loopback
//! socket. That is the right shape for the control plane, which is trusted with
//! the box outright. It is the wrong shape for a browser, and it was being
//! handed to one — a websocket cannot carry an `Authorization` header, so
//! attaching to a terminal meant putting the full credential in the page.
//!
//! What a browser actually needs is one sentence: *this person may attach to a
//! session on this box for the next two minutes*. That is what these are.
//!
//! `<scope>.<expiry>.<signature>`, HMAC-SHA256, **keyed by the box token**.
//! That choice is what makes the scheme cost nothing to operate: the control
//! plane already stores the box token and the daemon already holds it, so there
//! is no key to distribute, nothing to rotate separately, and no state here to
//! lose on restart. A box whose token is rotated stops honouring the tokens
//! minted against the old one, which is exactly the behaviour you want.
//!
//! Not encryption. The scope and the expiry are readable by anyone holding the
//! token; neither is a secret. The signature is what makes it unforgeable, and
//! the short life is what makes a stolen one nearly worthless.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// Attach to any session on this box.
pub const ATTACH: &str = "attach";

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Signs `<scope>.<expiry>`. Present in the daemon so the tests can mint what
/// the control plane mints, and so the two implementations are checked against
/// each other rather than against a comment.
pub fn sign(key: &str, scope: &str, ttl_seconds: u64) -> String {
    let body = format!("{scope}.{}", now() + ttl_seconds);
    let sig = mac(key, &body);
    format!("{body}.{sig}")
}

fn mac(key: &str, body: &str) -> String {
    let mut m = HmacSha256::new_from_slice(key.as_bytes()).expect("hmac accepts any key length");
    m.update(body.as_bytes());
    URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
}

/// The scope a token carries, or nothing.
///
/// Nothing covers every way this fails — wrong shape, bad signature, expired —
/// because none of them is a distinction a caller can act on, and telling them
/// apart is what an oracle is.
fn scope_of(key: &str, presented: &str, at: u64) -> Option<String> {
    let cut = presented.rfind('.')?;
    if cut < 1 {
        return None;
    }
    let body = &presented[..cut];
    let sig = &presented[cut + 1..];

    // Constant time, from the crate rather than by hand: `==` on a MAC leaks
    // where two values diverge, and this one is checked on every reconnect.
    let bytes = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let mut m = HmacSha256::new_from_slice(key.as_bytes()).expect("hmac accepts any key length");
    m.update(body.as_bytes());
    m.verify_slice(&bytes).ok()?;

    let at_dot = body.rfind('.')?;
    if at_dot < 1 {
        return None;
    }
    let expires: u64 = body[at_dot + 1..].parse().ok()?;
    if expires < at {
        return None;
    }
    Some(body[..at_dot].to_string())
}

/// Whether `presented` admits the holder to `session`'s socket.
///
/// A token scoped to bare `attach` reaches any session on the box, which is the
/// form the control plane mints: the box has one owner, so naming a session
/// buys nothing against them. `attach:<id>` exists for the case where it does
/// buy something — a share handed to somebody else.
pub fn allows_attach(key: &str, presented: &str, session: &str) -> bool {
    match scope_of(key, presented, now()) {
        Some(scope) => scope == ATTACH || scope == format!("{ATTACH}:{session}"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "box-token-of-no-particular-length";

    #[test]
    fn a_freshly_signed_attach_token_admits_any_session() {
        let t = sign(KEY, ATTACH, 120);
        assert!(allows_attach(KEY, &t, "s1"));
        assert!(allows_attach(KEY, &t, "s99"));
    }

    #[test]
    fn a_session_scoped_token_admits_only_that_session() {
        let t = sign(KEY, "attach:s1", 120);
        assert!(allows_attach(KEY, &t, "s1"));
        assert!(!allows_attach(KEY, &t, "s2"));
    }

    #[test]
    fn another_boxs_key_does_not_verify() {
        let t = sign(KEY, ATTACH, 120);
        assert!(!allows_attach("some-other-box-token", &t, "s1"));
    }

    #[test]
    fn an_expired_token_is_refused() {
        let body = format!("{ATTACH}.{}", now() - 1);
        let t = format!("{body}.{}", mac(KEY, &body));
        assert!(!allows_attach(KEY, &t, "s1"));
    }

    /// The expiry is inside the signed body, so moving it invalidates the
    /// signature. Worth asserting rather than assuming: an implementation that
    /// signed only the scope would pass every other test in this file.
    #[test]
    fn the_expiry_cannot_be_extended() {
        let t = sign(KEY, ATTACH, 1);
        let sig = t.rsplit('.').next().unwrap();
        let forged = format!("{ATTACH}.{}.{sig}", now() + 86_400);
        assert!(!allows_attach(KEY, &forged, "s1"));
    }

    /// The box token itself is not one of these and must not be mistaken for
    /// one — it has no expiry and no scope, and the whole point is that the two
    /// are different kinds of credential.
    #[test]
    fn the_raw_box_token_is_not_a_scoped_token() {
        assert!(!allows_attach(KEY, KEY, "s1"));
    }

    /// The control plane mints these and this verifies them, in two languages.
    /// A shared vector is what keeps them the same scheme: change the body
    /// format, the digest or the encoding on either side and this fails here,
    /// rather than by refusing every terminal in production.
    ///
    /// The twin is `the format is the one the daemon verifies` in
    /// `tests/boxscope.test.ts`.
    #[test]
    fn the_format_matches_the_control_planes() {
        const VECTOR: &str = "attach.1800000000.arwHhRBqLMB0eloPxi83LaWr2JHvc-A1JwgxThDnm5s";
        // Checked against a fixed instant rather than the clock, so this is a
        // test of the format and not a thing that starts failing in 2027.
        assert_eq!(scope_of(KEY, VECTOR, 1_700_000_000).as_deref(), Some(ATTACH));
        assert_eq!(scope_of(KEY, VECTOR, 1_900_000_000), None, "expiry not enforced");
    }

    #[test]
    fn nonsense_is_refused_rather_than_panicking() {
        for junk in ["", ".", "..", "attach", "attach.", "attach.x.y", "a.1.!!!!"] {
            assert!(!allows_attach(KEY, junk, "s1"), "{junk:?} was accepted");
        }
    }
}
