//! The wire between an environment and whatever is looking at it.
//!
//! One websocket message is one frame, and a frame is a channel, an opcode,
//! and bytes. Channel 0 carries JSON control. Every other channel is a *pane*,
//! and what its bytes mean is decided by the kind negotiated when it opened.
//!
//! Panes are the reason this is not a terminal protocol with extras bolted on.
//! A pty pane and, later, a file or diff or framebuffer pane differ only in a
//! kind string and how the payload is read, so adding one never touches the
//! framing and never breaks a client that does not know it exists. A client
//! asks for the panes it can draw; the environment refuses the rest by name.

use anyhow::{Result, bail};
use serde::de::DeserializeOwned;

use crate::backend::PortMap;
use serde::{Deserialize, Serialize};

/// Bumped only for a change an old client cannot ignore. New pane kinds and
/// new event variants are not that: both are negotiated by name.
///
/// 3 added the host's default image and the names of its secrets to the
/// welcome. A v2 client would accept the handshake and then fail to read the
/// message after it, which is exactly the hang the version check exists to
/// turn into a sentence. 4 added `Watch`.
pub const VERSION: u16 = 4;

/// The control channel. Never carries pane data.
pub const CONTROL: u32 = 0;

const HEADER: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
    /// Payload bytes belonging to the pane. Never interpreted here — for a pty
    /// that is terminal traffic in whichever direction the frame travelled.
    Data = 0,
    /// JSON about the pane rather than in it.
    Event = 1,
    /// The pane is finished, and its channel number is free again.
    Close = 2,
}

impl Op {
    fn from_u8(b: u8) -> Result<Op> {
        Ok(match b {
            0 => Op::Data,
            1 => Op::Event,
            2 => Op::Close,
            _ => bail!("unknown opcode {b}"),
        })
    }
}

#[derive(Debug, Clone)]
pub struct Frame {
    pub channel: u32,
    pub op: Op,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn data(channel: u32, payload: impl Into<Vec<u8>>) -> Frame {
        Frame {
            channel,
            op: Op::Data,
            payload: payload.into(),
        }
    }

    pub fn event(channel: u32, event: &PaneEvent) -> Frame {
        Frame {
            channel,
            op: Op::Event,
            payload: serde_json::to_vec(event).unwrap_or_default(),
        }
    }

    pub fn close(channel: u32) -> Frame {
        Frame {
            channel,
            op: Op::Close,
            payload: Vec::new(),
        }
    }

    /// A control message. Control is just channel 0's data, so nothing in the
    /// codec special-cases it.
    pub fn control<T: Serialize>(msg: &T) -> Frame {
        Frame::data(CONTROL, serde_json::to_vec(msg).unwrap_or_default())
    }

    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        Ok(serde_json::from_slice(&self.payload)?)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER + self.payload.len());
        out.extend_from_slice(&self.channel.to_be_bytes());
        out.push(self.op as u8);
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Frame> {
        if bytes.len() < HEADER {
            bail!("frame shorter than its header");
        }
        let channel = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        Ok(Frame {
            channel,
            op: Op::from_u8(bytes[4])?,
            payload: bytes[HEADER..].to_vec(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromClient {
    Hello {
        version: u16,
        token: String,
        client: String,
    },
    Open {
        channel: u32,
        pane: Pane,
    },
    Close {
        channel: u32,
    },
    CreateEnvironment {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ports: Vec<u16>,
        /// Cloned into the workspace before the environment is announced, so a
        /// client that gets an `Environment` back gets one with the code in it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
        /// Overrides the host's ceiling for this one environment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        memory: Option<String>,
    },
    StartEnvironment {
        id: String,
    },
    StopEnvironment {
        id: String,
    },
    DestroyEnvironment {
        id: String,
    },
    /// The host's secrets, which every environment on it is lent at the moment
    /// a session starts. Setting one is a write to a 0600 file beside the
    /// state, not a change to any container.
    SetSecret {
        key: String,
        value: String,
    },
    RemoveSecret {
        key: String,
    },
    ListSecrets,
    /// The whole host again, answered with a `Welcome`.
    ///
    /// What a watcher does after `Stale`: deltas cannot repair a client that
    /// missed some, and reconnecting would mean building the ssh tunnel again
    /// for information already on the other end of the one it has.
    Describe,
    /// Send me everything that changes on this host, not only the answers to
    /// what I asked.
    ///
    /// Opt-in rather than always-on, because a client running one command and
    /// reading one reply would otherwise have to tell an unrelated broadcast
    /// apart from its own answer — and they look identical.
    Watch {
        on: bool,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromServer {
    Welcome {
        version: u16,
        host: HostInfo,
    },
    Opened {
        channel: u32,
        environment: String,
        session: String,
    },
    Closed {
        channel: u32,
        reason: String,
    },
    /// One environment, whenever it changes — including when somebody else
    /// changed it, for clients that asked to `Watch`. A tree stays current
    /// from these rather than re-asking, which is what makes two clients on
    /// one host agree without polling.
    Environment {
        environment: EnvInfo,
    },
    EnvironmentGone {
        id: String,
    },
    /// Names only. A value that has been set is never read back out over a
    /// socket — the file on the host is the one copy, and a listing is
    /// something people do with somebody standing behind them.
    Secrets {
        names: Vec<String>,
    },
    Error {
        message: String,
    },
    /// You missed something. Ask again rather than trusting what you have —
    /// a watcher that fell behind cannot be caught up by more deltas.
    Stale,
    Pong,
}

/// The machine, and everything it is holding. One of these per user:
/// `<user>.devpipe.com` is a host, not an environment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    pub id: String,
    pub host: String,
    pub backend: String,
    /// Pane kinds this build can serve, so a client can hide what it would
    /// only be refused.
    pub panes: Vec<String>,
    /// What a new environment is made of when nobody names an image.
    pub image: String,
    /// The names of the host's secrets. Never the values.
    pub secrets: Vec<String>,
    pub environments: Vec<EnvInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvInfo {
    pub id: String,
    /// A DNS label: this is what appears in `<project>.<user>.devpipe.com`.
    pub name: String,
    pub backend: String,
    pub image: String,
    pub status: String,
    pub workspace: String,
    /// The memory ceiling, if it has one. Shown because an environment that
    /// keeps dying wants this to be the first thing anybody checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    pub ports: Vec<PortMap>,
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Pane {
    Pty {
        /// Which environment on this host. Absent means the only one there
        /// is, which is how bridge mode stays a one-word command.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        environment: Option<String>,
        /// An existing session to attach to. Absent starts a new one, which is
        /// the difference between resuming work and beginning it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        argv: Vec<String>,
        cols: u16,
        rows: u16,
    },
}

impl Pane {
    pub fn kind(&self) -> &'static str {
        match self {
            Pane::Pty { .. } => "pty",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum PaneEvent {
    Resize {
        cols: u16,
        rows: u16,
    },
    Title {
        title: String,
    },
    /// Something in the environment asked for a browser — an agent signing in,
    /// almost always. See `marker.rs` for how it asked.
    ///
    /// A client must not follow this on its own. The environment is full of
    /// processes that can emit it, so the person has to see where it goes and
    /// choose to go there.
    Open {
        url: String,
    },
    Exit,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_survives_the_round_trip() {
        let f = Frame::data(7, b"hello".to_vec());
        let back = Frame::decode(&f.encode()).unwrap();
        assert_eq!(back.channel, 7);
        assert_eq!(back.op, Op::Data);
        assert_eq!(back.payload, b"hello");
    }

    #[test]
    fn an_empty_payload_is_a_valid_frame() {
        let back = Frame::decode(&Frame::close(3).encode()).unwrap();
        assert_eq!(back.op, Op::Close);
        assert!(back.payload.is_empty());
    }

    #[test]
    fn a_truncated_frame_is_refused_rather_than_guessed() {
        assert!(Frame::decode(&[0, 0, 0]).is_err());
    }

    #[test]
    fn control_is_channel_zero() {
        let f = Frame::control(&FromClient::Ping);
        assert_eq!(f.channel, CONTROL);
        assert!(matches!(f.json::<FromClient>().unwrap(), FromClient::Ping));
    }

    /// Pane payloads are bytes, not text: a pty emits arbitrary escapes and
    /// half-formed UTF-8 mid-write, and any encoding step here would corrupt
    /// them.
    #[test]
    fn arbitrary_bytes_pass_through_intact() {
        let raw: Vec<u8> = (0u8..=255).collect();
        let back = Frame::decode(&Frame::data(1, raw.clone()).encode()).unwrap();
        assert_eq!(back.payload, raw);
    }

    #[test]
    fn a_pane_open_names_its_kind_and_its_environment() {
        let msg = FromClient::Open {
            channel: 1,
            pane: Pane::Pty {
                environment: Some("web".into()),
                session: None,
                argv: vec![],
                cols: 80,
                rows: 24,
            },
        };
        let wire = serde_json::to_string(&msg).unwrap();
        assert!(wire.contains(r#""kind":"pty""#), "{wire}");
        assert!(wire.contains(r#""environment":"web""#), "{wire}");
        let back: FromClient = serde_json::from_str(&wire).unwrap();
        match back {
            FromClient::Open { pane, .. } => assert_eq!(pane.kind(), "pty"),
            _ => panic!("wrong variant"),
        }
    }

    /// A client that omits the environment is asking for the only one. The
    /// field has to survive being absent rather than defaulting to a string.
    #[test]
    fn an_unnamed_environment_stays_unnamed() {
        let wire = r#"{"kind":"pty","cols":80,"rows":24}"#;
        let pane: Pane = serde_json::from_str(wire).unwrap();
        let Pane::Pty {
            environment,
            session,
            ..
        } = pane;
        assert!(environment.is_none());
        assert!(session.is_none());
    }
}
