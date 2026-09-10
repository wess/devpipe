//! The client half of the socket, shared by everything that talks to a host.
//!
//! `attach` needs the two halves separately so it can select over input,
//! resize and output at once, so this hands them over rather than wrapping
//! them. It exists to keep the handshake in one place: every client, including
//! the desktop and web ones, has to greet the same way.

use anyhow::{Result, bail};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::proto::{self, Frame, FromClient, FromServer, HostInfo};

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type Outgoing = SplitSink<Socket, Message>;
pub type Incoming = SplitStream<Socket>;

pub struct Client {
    pub sink: Outgoing,
    pub source: Incoming,
}

impl Client {
    pub async fn connect(url: &str, token: &str) -> Result<(Client, HostInfo)> {
        let (socket, _) = tokio_tungstenite::connect_async(url).await?;
        Client::over(socket, token).await
    }

    /// Greet a host on a socket somebody else opened.
    ///
    /// A relay splices a client to a machine and then stops taking part, so
    /// from here the handshake is the ordinary one and the host token is still
    /// the client's to present. The relay carried the introduction; it is not
    /// a party to what follows.
    pub async fn over(socket: Socket, token: &str) -> Result<(Client, HostInfo)> {
        let (sink, source) = socket.split();
        let mut client = Client { sink, source };

        client
            .say(FromClient::Hello {
                version: proto::VERSION,
                token: token.into(),
                client: format!("devpipe-cli/{}", env!("CARGO_PKG_VERSION")),
            })
            .await?;

        match client.control().await? {
            Some(FromServer::Welcome { host, .. }) => Ok((client, host)),
            Some(FromServer::Error { message }) => bail!("{message}"),
            _ => bail!("the host did not greet back"),
        }
    }

    pub async fn say(&mut self, msg: FromClient) -> Result<()> {
        self.send(Frame::control(&msg)).await
    }

    pub async fn send(&mut self, frame: Frame) -> Result<()> {
        self.sink
            .send(Message::Binary(frame.encode().into()))
            .await?;
        Ok(())
    }

    /// The next control message, skipping pane traffic. Only safe before any
    /// pane is open, which is exactly when the one-shot commands run.
    pub async fn control(&mut self) -> Result<Option<FromServer>> {
        while let Some(frame) = next_frame(&mut self.source).await? {
            if frame.channel == proto::CONTROL {
                return Ok(Some(frame.json()?));
            }
        }
        Ok(None)
    }

    pub async fn close(mut self) {
        let _ = self.sink.close().await;
    }
}

pub async fn next_frame(source: &mut Incoming) -> Result<Option<Frame>> {
    while let Some(msg) = source.next().await {
        match msg? {
            Message::Binary(bytes) => return Ok(Some(Frame::decode(&bytes)?)),
            Message::Close(_) => return Ok(None),
            _ => continue,
        }
    }
    Ok(None)
}
