//! Who a relay will speak to.
//!
//! A single shared secret was right for one person proving the thing works and
//! wrong the moment there are two: it let anyone holding it enrol a machine
//! under any name and reach anybody else's. This is the smallest thing that
//! is not that — an account per key, and a key that says what it is for.
//!
//! **Stored as hashes, unlike the host's own token.** A machine's token file is
//! that machine's own secret and there is nothing to be gained by hiding it
//! from the machine. A relay's file is everybody's, so a copy of it should not
//! be usable — it should only be enough to check an answer against.
//!
//! Two purposes rather than one, because they are stolen differently. An
//! enrolment key sits on a box forever; a reach key belongs to a person at a
//! keyboard. A box that is taken should not become a way into every other box
//! its owner has.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Can {
    /// A machine, announcing itself. Long-lived, and lives on the machine.
    Enrol,
    /// A person, asking for one of theirs. Belongs at a keyboard.
    Reach,
}

impl Can {
    pub fn as_str(&self) -> &'static str {
        match self {
            Can::Enrol => "enrol",
            Can::Reach => "reach",
        }
    }
}

impl std::str::FromStr for Can {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Can> {
        match s {
            "enrol" | "enroll" => Ok(Can::Enrol),
            "reach" => Ok(Can::Reach),
            other => bail!("a key is for `enrol` or `reach`, not {other}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Key {
    /// Hex sha256 of the token. The token itself is shown once, when it is
    /// granted, and never again by anything here.
    pub hash: String,
    pub account: String,
    pub can: Can,
    /// What it is for, in the words of whoever granted it. The only way to
    /// tell two keys apart when deciding which to revoke.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl Key {
    /// Enough to name it in a list without being enough to use it.
    pub fn short(&self) -> &str {
        &self.hash[..12]
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    keys: Vec<Key>,
}

pub struct Keys {
    path: PathBuf,
    keys: Vec<Key>,
}

impl Keys {
    pub fn open(dir: &Path) -> Keys {
        let path = dir.join("relay.json");
        let keys = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok())
            .map(|f| f.keys)
            .unwrap_or_default();
        Keys { path, keys }
    }

    pub fn all(&self) -> &[Key] {
        &self.keys
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Which account this token belongs to, for this purpose.
    ///
    /// Compared in constant time and against every candidate rather than
    /// short-circuiting on the first match: the timing of a loop that stops
    /// early is a measurement of how far down the list a key is.
    pub fn account_for(&self, token: &str, can: Can) -> Option<String> {
        let presented = hash(token);
        let mut found: Option<String> = None;
        for key in &self.keys {
            let same: bool = key.hash.as_bytes().ct_eq(presented.as_bytes()).into();
            if same && key.can == can {
                found = Some(key.account.clone());
            }
        }
        found
    }

    /// Mint one. The token is returned exactly once — what is kept is what it
    /// hashes to, which cannot be handed back out by mistake.
    pub fn grant(&mut self, account: &str, can: Can, note: &str) -> Result<String> {
        if account.is_empty() {
            bail!("a key belongs to an account");
        }
        let token = crate::host::random_id(24);
        self.keys.push(Key {
            hash: hash(&token),
            account: account.to_string(),
            can,
            note: note.to_string(),
        });
        self.save()?;
        Ok(token)
    }

    /// By the prefix a listing shows, because nothing can show the token.
    pub fn revoke(&mut self, prefix: &str) -> Result<usize> {
        if prefix.len() < 6 {
            bail!("say more of the hash than that: {prefix}");
        }
        let before = self.keys.len();
        self.keys.retain(|k| !k.hash.starts_with(prefix));
        let gone = before - self.keys.len();
        if gone > 0 {
            self.save()?;
        }
        Ok(gone)
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_vec_pretty(&File {
            keys: self.keys.clone(),
        })?;
        crate::host::write_private(&self.path, &text)
    }
}

pub fn hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("devpipe-keys-{}", crate::host::random_id(8)))
    }

    #[test]
    fn a_granted_key_opens_its_own_purpose_and_no_other() {
        let dir = scratch();
        let mut keys = Keys::open(&dir);
        let token = keys.grant("wess", Can::Enrol, "beta box").unwrap();

        assert_eq!(
            keys.account_for(&token, Can::Enrol).as_deref(),
            Some("wess")
        );
        // A machine's key must not become a way to reach every other machine
        // its owner has.
        assert!(keys.account_for(&token, Can::Reach).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_token_is_never_written_down() {
        let dir = scratch();
        let mut keys = Keys::open(&dir);
        let token = keys.grant("wess", Can::Reach, "").unwrap();
        let written = std::fs::read_to_string(dir.join("relay.json")).unwrap();
        assert!(
            !written.contains(&token),
            "a copy of the relay's file must not be usable as its keys"
        );
        assert!(written.contains(&hash(&token)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_revoked_key_stops_working() {
        let dir = scratch();
        let mut keys = Keys::open(&dir);
        let token = keys.grant("wess", Can::Reach, "laptop").unwrap();
        let short = keys.all()[0].short().to_string();

        assert_eq!(keys.revoke(&short).unwrap(), 1);
        assert!(keys.account_for(&token, Can::Reach).is_none());

        // And it stayed revoked, rather than only in memory.
        let again = Keys::open(&dir);
        assert!(again.account_for(&token, Can::Reach).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A prefix short enough to match keys somebody did not mean is a way to
    /// revoke the wrong one, and revocation has no undo.
    #[test]
    fn a_prefix_too_short_to_mean_one_key_is_refused() {
        let dir = scratch();
        let mut keys = Keys::open(&dir);
        keys.grant("wess", Can::Reach, "").unwrap();
        assert!(keys.revoke("ab").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_nobody_granted_belongs_to_nobody() {
        let dir = scratch();
        let keys = Keys::open(&dir);
        assert!(keys.account_for("made-up", Can::Enrol).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
