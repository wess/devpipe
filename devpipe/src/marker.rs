//! Messages a program inside an environment sends to whoever is looking at it.
//!
//! An agent that wants a browser opened has no way to say so: it is in a
//! container, on a machine across an ssh tunnel, and the browser is on a laptop
//! it cannot name. But it already has a channel to the person — the pty — and
//! terminals have carried out-of-band requests on that channel for decades.
//!
//! So a shim on `PATH` (installed as `xdg-open`, `open`, `BROWSER`, …) prints
//! an OSC, the keeper notices it going past, and it reaches the client as a
//! typed pane event. Nothing has to be mounted, no socket has to be reachable,
//! and it works for every tool that tries to open a browser rather than for the
//! three we thought of.
//!
//! The sequence is `ESC ] 9998 ; devpipe ; <verb> ; <rest> ST`. 9998 because
//! `vt` already claims 777 for desktop notifications and ignores everything it
//! does not know — which is also what every other terminal does with this, so
//! a session watched over plain ssh sees nothing rather than garbage.

/// Bounded because the bytes arrive from inside somebody's container. An OSC
/// that never terminates must cost a fixed amount of memory, not all of it.
const CEILING: usize = 4096;

const PREFIX: &[u8] = b"9998;devpipe;";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    /// Open this in the person's own browser. Never automatically: see
    /// `safe_url`, and then see what a client is expected to do with it.
    Open { url: String },
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Text,
    Escaped,
    /// Inside an OSC. `skipping` is set once the payload has outgrown the
    /// ceiling or stopped matching the prefix — the terminator still has to be
    /// found, or the bytes after it would be read as another sequence.
    Payload {
        collected: Vec<u8>,
        skipping: bool,
    },
}

/// Watches a byte stream for markers, across whatever chunk boundaries the pty
/// happens to produce.
#[derive(Debug, Default)]
pub struct Scanner {
    state: State,
}

impl Scanner {
    pub fn new() -> Scanner {
        Scanner::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Marker> {
        let mut found = Vec::new();
        for &byte in bytes {
            self.step(byte, &mut found);
        }
        found
    }

    fn step(&mut self, byte: u8, found: &mut Vec<Marker>) {
        match &mut self.state {
            State::Text => {
                if byte == 0x1b {
                    self.state = State::Escaped;
                }
            }
            State::Escaped => {
                self.state = match byte {
                    b']' => State::Payload {
                        collected: Vec::new(),
                        skipping: false,
                    },
                    // An escape immediately followed by another one is the
                    // start of the second sequence, not a lost byte.
                    0x1b => State::Escaped,
                    _ => State::Text,
                };
            }
            State::Payload {
                collected,
                skipping,
            } => {
                // BEL, or the ESC of a String Terminator. Both end an OSC, and
                // both are what real terminals accept.
                if byte == 0x07 || byte == 0x1b {
                    if !*skipping && let Some(marker) = parse(collected) {
                        found.push(marker);
                    }
                    // ESC here begins `ESC \`; treating it as the start of a
                    // fresh escape handles that and anything else that follows.
                    self.state = if byte == 0x1b {
                        State::Escaped
                    } else {
                        State::Text
                    };
                    return;
                }
                if *skipping {
                    return;
                }
                collected.push(byte);
                // Give up as soon as it cannot be ours, so an 8MB OSC 52
                // clipboard write costs a comparison rather than a buffer.
                let far = collected.len();
                if collected.len() > CEILING
                    || (far <= PREFIX.len() && collected[..] != PREFIX[..far])
                {
                    *skipping = true;
                    collected.clear();
                }
            }
        }
    }
}

fn parse(collected: &[u8]) -> Option<Marker> {
    let rest = collected.strip_prefix(PREFIX)?;
    let text = std::str::from_utf8(rest).ok()?;
    let (verb, rest) = text.split_once(';')?;
    match verb {
        "open" => safe_url(rest).map(|url| Marker::Open { url }),
        // A verb from a newer shim than this daemon. Ignored rather than
        // guessed at, and silently, because the person cannot fix it.
        _ => None,
    }
}

/// What a client may be asked to open.
///
/// Anything at all can print this escape — the agent, a build script, a
/// dependency's postinstall. A `javascript:` or `file:` URL handed to a web
/// client with devpipe's name attached to it is the difference between a
/// convenience and a delivery mechanism, so the scheme is checked here rather
/// than trusted to whatever draws the button.
fn safe_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.len() > 2048 {
        return None;
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    if rest.is_empty() {
        return None;
    }
    // Control characters travelling inside a URL end up in a log, a title, or
    // an anchor's text, none of which expect them.
    if url.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Vec<Marker> {
        let mut scanner = Scanner::new();
        let mut found = Vec::new();
        for chunk in chunks {
            found.extend(scanner.feed(chunk));
        }
        found
    }

    #[test]
    fn a_whole_marker_in_one_chunk_is_seen() {
        let found = scan(&[b"\x1b]9998;devpipe;open;https://claude.ai/oauth\x1b\\"]);
        assert_eq!(
            found,
            vec![Marker::Open {
                url: "https://claude.ai/oauth".into()
            }]
        );
    }

    #[test]
    fn bell_terminates_it_too() {
        let found = scan(&[b"\x1b]9998;devpipe;open;https://example.com\x07"]);
        assert_eq!(found.len(), 1);
    }

    /// A pty hands over whatever the kernel had. A sequence split down the
    /// middle is the normal case, not the edge one.
    #[test]
    fn a_marker_split_across_chunks_is_still_seen() {
        let found = scan(&[
            b"before\x1b]9998;dev",
            b"pipe;open;https://cla",
            b"ude.ai/x\x1b\\after",
        ]);
        assert_eq!(
            found,
            vec![Marker::Open {
                url: "https://claude.ai/x".into()
            }]
        );
    }

    #[test]
    fn ordinary_output_is_not_a_marker() {
        assert!(scan(&[b"just some text\r\n\x1b[1;32mgreen\x1b[m"]).is_empty());
    }

    /// The sequences a real session is full of must not be mistaken for ours,
    /// and must not stop the next real marker being seen.
    #[test]
    fn other_osc_sequences_are_skipped_without_swallowing_what_follows() {
        let found = scan(&[
            b"\x1b]0;a title\x07",
            b"\x1b]52;c;AAAABBBBCCCC\x1b\\",
            b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
            b"\x1b]9998;devpipe;open;https://claude.ai/after\x1b\\",
        ]);
        assert_eq!(
            found,
            vec![Marker::Open {
                url: "https://claude.ai/after".into()
            }]
        );
    }

    /// Anything in the environment can print this. A scheme that is not the
    /// web is not a link, whatever the client would do with it.
    #[test]
    fn only_http_urls_survive() {
        for hostile in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "vscode://x",
            "",
        ] {
            let seq = format!("\x1b]9998;devpipe;open;{hostile}\x1b\\");
            assert!(
                scan(&[seq.as_bytes()]).is_empty(),
                "{hostile} should not open"
            );
        }
    }

    #[test]
    fn an_unterminated_sequence_cannot_grow_without_bound() {
        let mut scanner = Scanner::new();
        scanner.feed(b"\x1b]9998;devpipe;open;https://x/");
        for _ in 0..1000 {
            assert!(scanner.feed(&[b'a'; 64]).is_empty());
        }
        // And the stream recovers: the next real marker is still found.
        let found = scanner.feed(b"\x1b\\\x1b]9998;devpipe;open;https://ok/\x1b\\");
        assert_eq!(
            found,
            vec![Marker::Open {
                url: "https://ok/".into()
            }]
        );
    }

    #[test]
    fn a_verb_this_build_does_not_know_is_ignored() {
        assert!(scan(&[b"\x1b]9998;devpipe;summon;https://example.com\x1b\\"]).is_empty());
    }
}
