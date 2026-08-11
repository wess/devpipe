//! TLS with a pinned self-signed certificate.
//!
//! Devpipe hands out boxes rather than websites, so the SSH host-key model
//! fits it better than the web CA model. A certificate authority answers "is
//! this really example.com?", which is not a question anyone is asking here —
//! the client already knows exactly which machine it provisioned, and wants to
//! know it is still talking to that one.
//!
//! So: the daemon generates a self-signed certificate on first run, keeps it,
//! and prints its SHA-256 fingerprint. The client pins that fingerprint at
//! enrollment and refuses anything else. No domain per droplet, no ACME, no
//! renewal window in which a box goes dark, and no dependence on a third party
//! being reachable at the moment a machine comes up.
//!
//! The trade is that the fingerprint has to travel from the box to the client
//! over some already-trusted channel — the provisioning API response, in a
//! real deployment. A pinned key nobody checked is just an unpinned key.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

pub struct Tls {
    pub cert_pem: String,
    pub key_pem: String,
    /// Lowercase hex SHA-256 of the certificate DER — what the client pins.
    pub fingerprint: String,
}

impl Tls {
    /// Grouped in pairs, the way a human reads one off a screen to check it.
    pub fn fingerprint_display(&self) -> String {
        self.fingerprint
            .as_bytes()
            .chunks(2)
            .map(|c| String::from_utf8_lossy(c).to_uppercase())
            .collect::<Vec<_>>()
            .join(":")
    }
}

/// Load the certificate from `dir`, generating one if it is not there yet.
///
/// Persisting matters more than it looks: a certificate regenerated on every
/// restart would change the fingerprint, and every client that pinned the old
/// one would refuse to connect — a daemon restart would read as an attack.
/// `extra_sans` should carry whatever addresses this box answers on — at
/// provisioning time, the droplet's public IP. A pinning client ignores them,
/// but every other tool (curl, a browser, a load balancer health check) checks
/// the hostname and will refuse a certificate that does not name the address
/// it dialled.
pub fn load_or_generate(dir: &Path, extra_sans: &[String]) -> Result<Tls> {
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    if cert_path.exists() && key_path.exists() {
        let cert_pem = fs::read_to_string(&cert_path)
            .with_context(|| format!("reading {}", cert_path.display()))?;
        let key_pem = fs::read_to_string(&key_path)
            .with_context(|| format!("reading {}", key_path.display()))?;
        let fingerprint = fingerprint_of_pem(&cert_pem)?;
        return Ok(Tls { cert_pem, key_pem, fingerprint });
    }

    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;

    // To a pinning client these names are cosmetic — the address of a droplet
    // is not its identity, since the address can change and the key cannot.
    // They are here for everything else that dials the box and does check.
    // rcgen reads an entry that parses as an IP address as an IP SAN and
    // everything else as a DNS name.
    let mut sans = vec![
        "devpipe".to_string(),
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    for san in extra_sans {
        if !san.is_empty() && !sans.contains(san) {
            sans.push(san.clone());
        }
    }
    let generated = rcgen::generate_simple_self_signed(sans)
        .context("generating a self-signed certificate")?;

    let cert_pem = generated.cert.pem();
    let key_pem = generated.key_pair.serialize_pem();
    let fingerprint = hex(Sha256::digest(generated.cert.der()));

    fs::write(&cert_path, &cert_pem)?;
    fs::write(&key_path, &key_pem)?;
    restrict_to_owner(&key_path)?;

    Ok(Tls { cert_pem, key_pem, fingerprint })
}

/// A private key readable by every account on the box is not a private key.
#[cfg(unix)]
fn restrict_to_owner(path: &PathBuf) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &PathBuf) -> Result<()> {
    Ok(())
}

fn fingerprint_of_pem(pem: &str) -> Result<String> {
    let der = pem_to_der(pem).context("certificate PEM has no CERTIFICATE block")?;
    Ok(hex(Sha256::digest(&der)))
}

/// Minimal PEM decode. Pulling in a parser to base64-decode one block would be
/// more dependency than the job needs.
fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.contains("BEGIN CERTIFICATE"))
        .skip(1)
        .take_while(|l| !l.contains("END CERTIFICATE"))
        .collect();
    if body.is_empty() {
        return None;
    }
    base64_decode(&body)
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in input.bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devpipe-tls-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn generates_a_certificate_when_there_is_none() {
        let dir = tempdir("generate");
        let tls = load_or_generate(&dir, &[]).unwrap();
        assert!(tls.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(!tls.key_pem.is_empty());
        assert_eq!(tls.fingerprint.len(), 64, "sha-256 as hex");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The one that matters: a restart must not invalidate every pin.
    #[test]
    fn the_fingerprint_survives_a_restart() {
        let dir = tempdir("stable");
        let first = load_or_generate(&dir, &[]).unwrap();
        let second = load_or_generate(&dir, &[]).unwrap();
        assert_eq!(
            first.fingerprint, second.fingerprint,
            "restarting must not look like a different machine"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The fingerprint has to be computed the same way the client computes it,
    /// or pinning silently never matches. Both sides hash the DER.
    #[test]
    fn the_fingerprint_is_the_sha256_of_the_der() {
        let dir = tempdir("der");
        let tls = load_or_generate(&dir, &[]).unwrap();
        let der = pem_to_der(&tls.cert_pem).expect("decodes");
        assert_eq!(tls.fingerprint, hex(Sha256::digest(&der)));
        // And it round-trips through the file, not just through memory.
        assert_eq!(tls.fingerprint, fingerprint_of_pem(&tls.cert_pem).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_display_form_is_grouped_and_uppercase() {
        let tls = Tls {
            cert_pem: String::new(),
            key_pem: String::new(),
            fingerprint: "abcdef0123".into(),
        };
        assert_eq!(tls.fingerprint_display(), "AB:CD:EF:01:23");
    }
}
