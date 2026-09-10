//! What an environment is allowed to know.
//!
//! One file on the host, `KEY=value` a line, read at the moment a session
//! starts rather than when the environment was created. That ordering is the
//! whole design: a container created last week picks up a key rotated this
//! morning without being rebuilt, and nothing an agent runs can outlive a
//! secret being removed by more than the session it is already in.
//!
//! The values reach the environment as process environment, so they are
//! visible to anything running inside it — which is the point, and also the
//! reason this file is the narrowest thing that works: a host-wide set of
//! credentials the person who owns the host chose to lend out.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};

pub struct Secrets {
    path: PathBuf,
}

impl Secrets {
    pub fn at(dir: &Path) -> Secrets {
        Secrets {
            path: dir.join("env"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read fresh every time. This is a handful of lines off a local disk once
    /// per session start, and caching it would buy nothing but a stale key.
    pub fn load(&self) -> Vec<(String, String)> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        parse(&text)
    }

    pub fn names(&self) -> Vec<String> {
        self.load().into_iter().map(|(k, _)| k).collect()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        valid_key(key)?;
        if value.contains('\n') {
            bail!("a secret cannot contain a newline");
        }
        let mut kept: Vec<(String, String)> =
            self.load().into_iter().filter(|(k, _)| k != key).collect();
        kept.push((key.to_string(), value.to_string()));
        self.write(&kept)
    }

    pub fn remove(&self, key: &str) -> Result<bool> {
        let before = self.load();
        let after: Vec<(String, String)> =
            before.iter().filter(|(k, _)| k != key).cloned().collect();
        if after.len() == before.len() {
            return Ok(false);
        }
        self.write(&after)?;
        Ok(true)
    }

    fn write(&self, pairs: &[(String, String)]) -> Result<()> {
        let mut text = String::new();
        for (k, v) in pairs {
            text.push_str(k);
            text.push('=');
            text.push_str(v);
            text.push('\n');
        }
        crate::host::write_private(&self.path, text.as_bytes())
    }
}

/// `KEY=value`, one a line. `#` comments and blank lines are skipped, and a
/// value keeps everything after the first `=` — including more `=`, which
/// tokens are full of.
fn parse(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if valid_key(key).is_err() {
            continue;
        }
        // Quotes are how a person writes a value with spaces in a file like
        // this, and passing them through would put them in the variable.
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        pairs.push((key.to_string(), value.to_string()));
    }
    pairs
}

/// The shape the shell will accept. Enforced when it is set rather than when
/// it is used, because a name a shell cannot export is a variable nobody will
/// ever read and the person who typed it is still here.
pub fn valid_key(key: &str) -> Result<()> {
    if key.is_empty() {
        bail!("a secret needs a name");
    }
    if key.starts_with(|c: char| c.is_ascii_digit()) {
        bail!("a name cannot start with a digit");
    }
    if !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        bail!("a name can hold letters, digits and underscores");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_keeps_the_equals_signs_inside_it() {
        let pairs = parse("TOKEN=abc=def==\n");
        assert_eq!(pairs, vec![("TOKEN".into(), "abc=def==".into())]);
    }

    #[test]
    fn comments_and_blanks_are_not_secrets() {
        let pairs = parse("# a note\n\nA=1\n  \nB=2\n");
        assert_eq!(pairs.len(), 2);
    }

    #[test]
    fn quotes_are_the_writers_and_not_the_values() {
        let pairs = parse("A=\"one two\"\nB='three'\n");
        assert_eq!(pairs[0].1, "one two");
        assert_eq!(pairs[1].1, "three");
    }

    #[test]
    fn a_name_a_shell_cannot_export_is_refused() {
        assert!(valid_key("GH-TOKEN").is_err());
        assert!(valid_key("2FA").is_err());
        assert!(valid_key("GH_TOKEN").is_ok());
    }
}
