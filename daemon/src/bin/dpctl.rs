//! `dpctl` — your Devpipe box, from this machine.
//!
//! The replacement for `ssh box`, and deliberately not a wrapper around it.
//!
//! Port 22 on a box answers the control plane and nobody else, so SSH is not
//! an option here even for someone who wants the fiddling. It would be the
//! wrong tool anyway: waking a box builds a *new droplet*, so its host key
//! changes every time, and anyone using SSH meets REMOTE HOST IDENTIFICATION
//! HAS CHANGED on every return. There is nothing to configure here — no key,
//! no `known_hosts`, no flags — because the transport is the same
//! authenticated WSS on 443 that the web and iOS clients already use, against
//! a hostname with a real certificate.
//!
//! Two round trips and you have a shell:
//!
//!   dpctl login
//!   dpctl connect mybox
//!
//! Everything here is synchronous until the attach, which is the only part
//! that needs to do two things at once. A CLI that spends most invocations
//! making one request should not pay for a runtime to make it.

use std::io::{IsTerminal, Read, Write};
use std::process::Command;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const USAGE: &str = "\
dpctl — your Devpipe box, from this machine

  dpctl login [--server URL]      sign in once; the token goes to the keychain
  dpctl logout                    end this device's session
  dpctl whoami                    who this machine is signed in as
  dpctl boxes                     what you have, and whether it is awake
  dpctl connect <box> [--new]     a terminal on that box
  dpctl run <box> -- <command>    one command, then exit
  dpctl port <box> <port>         reach that port of the box on localhost
                                  (use 9000:3000 to land on a different one)
  dpctl ls <box> [path]           what is in a directory on the box
  dpctl pull <box>:<path> [dest]  a file or a whole directory, onto this machine
  dpctl push <path> <box>:<path>  the other way
  dpctl edit <box>:<path>         open it in $EDITOR and send back what changed

A box that is asleep is woken and waited for. Detach from a session with
Ctrl-] — the session and everything in it keeps running on the box.
";

/// Where the account lives. Overridable for a self-hosted instance.
const DEFAULT_SERVER: &str = "https://devpipe.com";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match words.as_slice() {
        [] | ["-h"] | ["--help"] | ["help"] => {
            print!("{USAGE}");
            0
        }
        ["login", rest @ ..] => login(rest),
        ["logout"] => logout(),
        ["whoami"] => whoami(),
        ["boxes"] => boxes(),
        ["connect", name, rest @ ..] => connect(name, rest),
        ["run", name, rest @ ..] => run(name, rest),
        ["port", name, spec] => port(name, spec),
        ["ls", name] => ls(name, None),
        ["ls", name, path] => ls(name, Some(path)),
        ["pull", spec] => pull(spec, None),
        ["pull", spec, dest] => pull(spec, Some(dest)),
        ["push", local, spec] => push(local, spec),
        ["edit", spec] => edit(spec),
        other => {
            eprintln!("dpctl: unknown command `{}`\n", other.join(" "));
            eprint!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

// ---- the account -----------------------------------------------------------

/// A signed-in session against one server.
struct Account {
    server: String,
    token: String,
}

impl Account {
    /// Whatever this machine was last signed in as.
    ///
    /// The server is stored *with* the token rather than read from the
    /// environment at use time. They are one credential: a token minted by a
    /// self-hosted instance is worthless at devpipe.com and sending it there
    /// hands a stranger's server a working session for somebody else's.
    fn load() -> Result<Account, String> {
        let stored = keychain::read()
            .ok_or("This machine is not signed in. Run `dpctl login`.".to_string())?;
        let saved: Value = serde_json::from_str(&stored).unwrap_or(Value::Null);
        let server = saved
            .get("server")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_SERVER.into());
        let token = saved
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string)
            // A bare token is what an older dpctl wrote. Reading it rather than
            // demanding a fresh sign-in costs one line and saves an upgrade
            // that silently signs everybody out.
            .unwrap_or(stored);
        Ok(Account { server, token })
    }

    /// A placeholder for the direct-to-daemon path, which never calls a server.
    fn direct() -> Account {
        Account { server: String::new(), token: String::new() }
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.send(ureq::get(&format!("{}{path}", self.server)), None)
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.send(ureq::post(&format!("{}{path}", self.server)), Some(body))
    }

    fn send(&self, req: ureq::Request, body: Option<Value>) -> Result<Value, String> {
        finish(req.set("authorization", &format!("Bearer {}", self.token)), body)
    }

    /// The box with this name, however the person happened to write it.
    ///
    /// Matched on the name first and the hostname second, because `mybox` and
    /// `mybox.devpipe.com` are the same machine to everyone except a string
    /// comparison, and being told "no such box" while looking at it in the
    /// browser is the sort of thing that makes a tool feel broken.
    fn find_box(&self, name: &str) -> Result<Value, String> {
        let list = self.get("/api/boxes")?;
        let boxes = list.as_array().cloned().unwrap_or_default();
        let want = name.trim().to_lowercase();
        let hit = boxes.iter().find(|b| {
            let n = b.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let h = b.get("hostname").and_then(Value::as_str).unwrap_or("").to_lowercase();
            n == want || h == want || h.split('.').next() == Some(want.as_str())
        });
        match hit {
            Some(b) => Ok(b.clone()),
            None if boxes.is_empty() => {
                Err("You have no boxes yet. Make one at devpipe.com.".into())
            }
            None => {
                let names: Vec<&str> =
                    boxes.iter().filter_map(|b| b.get("name").and_then(Value::as_str)).collect();
                Err(format!("No box called `{name}`. You have: {}", names.join(", ")))
            }
        }
    }
}

/// One request, with the server's own error text surfaced verbatim.
///
/// A refusal is usually a sentence the reader can act on — "That box is still
/// being set up", "That workspace is on another box" — and replacing it with a
/// status code throws away the only useful part of the answer.
fn finish(req: ureq::Request, body: Option<Value>) -> Result<Value, String> {
    // Identifies the row in Settings → Devices, so a laptop that goes missing
    // can be signed out by name rather than by guessing which session it is.
    let agent = format!("dpctl/{} ({})", env!("CARGO_PKG_VERSION"), hostname());
    let req = req.set("user-agent", &agent);
    let result = match body {
        Some(value) => req.send_json(value),
        None => req.call(),
    };
    match result {
        Ok(response) => {
            // 204 and friends have nothing to parse, and a caller that only
            // wanted to know it worked should not have to care.
            Ok(response.into_json::<Value>().unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(401, _)) => {
            Err("That sign-in has expired. Run `dpctl login`.".into())
        }
        Err(ureq::Error::Status(code, response)) => Err(response
            .into_json::<Value>()
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| format!("the server answered {code}"))),
        Err(e) => Err(e.to_string()),
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

// ---- commands --------------------------------------------------------------

fn login(args: &[&str]) -> i32 {
    let server = flag(args, "--server").unwrap_or_else(|| {
        std::env::var("DEVPIPE_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.into())
    });

    let email = match prompt("Email: ") {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    // Never as an argument. A password in argv is readable by `ps`, lands in
    // shell history, and is captured in a crash report.
    let password = match prompt_secret("Password: ") {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };

    let body = json!({ "email": email, "password": password });
    let out = match finish(ureq::post(&format!("{server}/api/auth/login")), Some(body)) {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    let Some(token) = out.get("token").and_then(Value::as_str) else {
        return fail("The server signed us in but sent no token.");
    };
    if let Err(e) = keychain::write(&json!({ "server": server, "token": token }).to_string()) {
        return fail(&e);
    }
    let who = out
        .get("user")
        .and_then(|u| u.get("email"))
        .and_then(Value::as_str)
        .unwrap_or(&email);
    println!("Signed in as {who}.");
    println!("This machine now shows up in Settings → Devices, and can be signed out from there.");
    0
}

fn logout() -> i32 {
    // Best effort against the server, then local whatever happened: a token
    // the server has already forgotten must not be left on disk because the
    // network was down when we tried to tell it.
    if let Ok(account) = Account::load() {
        let _ = account.post("/api/auth/logout", Value::Null);
    }
    match keychain::clear() {
        Ok(()) => {
            println!("Signed out.");
            0
        }
        Err(e) => fail(&e),
    }
}

fn whoami() -> i32 {
    let account = match Account::load() {
        Ok(a) => a,
        Err(e) => return fail(&e),
    };
    match account.get("/api/auth/me") {
        Ok(v) => {
            let user = v.get("user").unwrap_or(&v);
            let email = user.get("email").and_then(Value::as_str).unwrap_or("?");
            println!("{email} at {}", account.server);
            0
        }
        Err(e) => fail(&e),
    }
}

fn boxes() -> i32 {
    let account = match Account::load() {
        Ok(a) => a,
        Err(e) => return fail(&e),
    };
    let list = match account.get("/api/boxes") {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("No boxes yet. Make one at {}.", account.server);
        return 0;
    }
    let width = rows
        .iter()
        .filter_map(|b| b.get("name").and_then(Value::as_str))
        .map(str::len)
        .max()
        .unwrap_or(4);
    for b in rows {
        let name = b.get("name").and_then(Value::as_str).unwrap_or("?");
        let status = b.get("status").and_then(Value::as_str).unwrap_or("?");
        let host = b.get("hostname").and_then(Value::as_str).unwrap_or("");
        // The detail is the build phase while one is being made, which is the
        // only time "installing" on its own is not enough to go on.
        let detail = b.get("status_detail").and_then(Value::as_str).unwrap_or("");
        let note = if status == "ready" || detail.is_empty() {
            String::new()
        } else {
            format!(" ({detail})")
        };
        println!("{name:<width$}  {status}{note}  {host}");
    }
    0
}

fn run(name: &str, args: &[&str]) -> i32 {
    // Everything after `--` is the command, untouched. Without the separator a
    // flag meant for the remote command is eaten by this one.
    let argv: Vec<String> = match args.iter().position(|a| *a == "--") {
        Some(i) => args[i + 1..].iter().map(|s| s.to_string()).collect(),
        None => args.iter().map(|s| s.to_string()).collect(),
    };
    if argv.is_empty() {
        return fail("Nothing to run. Try: dpctl run mybox -- ls ~/work");
    }
    attach_to(name, argv, true)
}

fn connect(name: &str, args: &[&str]) -> i32 {
    // An empty argv is the box's own login shell, whatever the owner chose.
    attach_to(name, Vec::new(), args.contains(&"--new"))
}

/// A box that is awake, and how to speak to its daemon.
struct Reached {
    account: Account,
    id: i64,
    url: String,
    token: String,
    /// Set only in direct mode, where there is no control plane to ask.
    bare: bool,
}

impl Reached {
    /// The box's live sessions.
    ///
    /// Normally the control plane answers, because it is the thing that knows
    /// which box belongs to whom. In direct mode it is not running, so the
    /// daemon's own REST endpoint answers instead — the control plane is a
    /// proxy for exactly this call, so the two agree by construction.
    fn sessions(&self) -> Result<Value, String> {
        if self.bare {
            return finish(
                ureq::get(&format!("{}/v1/sessions", self.http())).set(
                    "authorization",
                    &format!("Bearer {}", self.token),
                ),
                None,
            );
        }
        self.account.get(&format!("/api/boxes/{}/sessions", self.id))
    }

    fn create_session(&self, argv: &[String], cols: u16, rows: u16) -> Result<Value, String> {
        let body = json!({ "argv": argv, "cols": cols, "rows": rows });
        if self.bare {
            return finish(
                ureq::post(&format!("{}/v1/sessions", self.http())).set(
                    "authorization",
                    &format!("Bearer {}", self.token),
                ),
                Some(body),
            );
        }
        self.account.post(&format!("/api/boxes/{}/sessions", self.id), body)
    }

    /// The same daemon over plain HTTP. `wss` and `ws` are `https` and `http`
    /// carrying a different upgrade, and the daemon serves both on one port.
    fn http(&self) -> String {
        self.url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1)
    }
}

/// Find the box, wake it if it is asleep, and ask where its daemon is.
///
/// Waking is the thing SSH could never do. A box asleep is a box whose droplet
/// does not exist; asking for a shell — or a port — is a perfectly clear
/// instruction to bring it back, and making somebody open a browser to press a
/// button first is the friction this tool exists to remove.
fn reach(name: &str) -> Result<Reached, String> {
    // Straight at a daemon, skipping the control plane entirely:
    //
    //   DEVPIPE_DIRECT=ws://127.0.0.1:7788 DEVPIPE_TOKEN=... dpctl port x 3000
    //
    // For working on the daemon itself, where there is no account and no box —
    // the same reason `probe` exists. Not a way around authentication: the
    // daemon still demands its own token, this only skips asking a server
    // which box is which.
    if let Ok(direct) = std::env::var("DEVPIPE_DIRECT") {
        let token = std::env::var("DEVPIPE_TOKEN")
            .map_err(|_| "DEVPIPE_DIRECT needs DEVPIPE_TOKEN as well.".to_string())?;
        return Ok(Reached { account: Account::direct(), id: 0, url: direct, token, bare: true });
    }
    let account = Account::load()?;
    let target = account.find_box(name)?;
    let id = target.get("id").and_then(Value::as_i64).unwrap_or(0);
    let status = target.get("status").and_then(Value::as_str).unwrap_or("");

    if status == "asleep" {
        eprintln!("{name} is asleep. Waking it — this takes about three minutes.");
        account.post(&format!("/api/boxes/{id}/wake"), Value::Null)?;
        wait_until_ready(&account, id)?;
    } else if status != "ready" {
        return Err(format!(
            "{name} is {status}, not ready. `dpctl boxes` will show what it is doing."
        ));
    }

    let conn = account.get(&format!("/api/boxes/{id}/connection"))?;
    let (Some(url), Some(token)) = (
        conn.get("url").and_then(Value::as_str),
        conn.get("token").and_then(Value::as_str),
    ) else {
        return Err("The server did not say how to reach that box.".into());
    };
    Ok(Reached { id, url: url.to_string(), token: token.to_string(), account, bare: false })
}

/// Find the box, get a session, and hand over the terminal.
fn attach_to(name: &str, argv: Vec<String>, fresh: bool) -> i32 {
    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };

    let (cols, rows) = window_size();
    let session = match pick_session(&reached, &argv, fresh, cols, rows) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };

    let ws = format!("{}/v1/sessions/{session}/attach", reached.url);
    match pump(&ws, &reached.token, cols, rows) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// `ssh -L`, without the ssh.
///
/// The spec is `3000` for the same port at both ends, or `9000:3000` when the
/// one you want locally is taken — which it usually is, because the reason to
/// run something on a box is often that it clashes with what is already on
/// your laptop.
fn port(name: &str, spec: &str) -> i32 {
    let (local, remote) = match spec.split_once(':') {
        Some((l, r)) => (l.parse::<u16>().ok(), r.parse::<u16>().ok()),
        None => (spec.parse::<u16>().ok(), spec.parse::<u16>().ok()),
    };
    let (Some(local), Some(remote)) = (local, remote) else {
        return fail("A port looks like `3000`, or `9000:3000` to land on a different one.");
    };
    if remote == 0 {
        return fail("Port 0 is not a port.");
    }

    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };
    match listen(local, remote, &reached.url, &reached.token, name) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// Polls until the box is ready, or long enough that something is wrong.
fn wait_until_ready(account: &Account, id: i64) -> Result<(), String> {
    // Four minutes. A wake measured at about 180 seconds in production, and a
    // limit under that turns an ordinary slow morning into an error.
    for _ in 0..80 {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let list = account.get("/api/boxes")?;
        let found = list
            .as_array()
            .and_then(|rows| rows.iter().find(|b| b.get("id").and_then(Value::as_i64) == Some(id)))
            .cloned();
        let Some(b) = found else { continue };
        match b.get("status").and_then(Value::as_str).unwrap_or("") {
            "ready" => {
                eprintln!("\rAwake.                    ");
                return Ok(());
            }
            "asleep" | "installing" | "queued" => {
                if let Some(d) = b.get("status_detail").and_then(Value::as_str)
                    && !d.is_empty() {
                        eprint!("\r{d}                    ");
                        let _ = std::io::stderr().flush();
                    }
            }
            other => return Err(format!("The box went to `{other}` instead of waking.")),
        }
    }
    Err("The box did not come back in four minutes. Check devpipe.com.".into())
}

/// The session to attach to: the one already running, or a new one.
///
/// Reusing by default is the whole point of the product — the work outlives
/// the connection, and a `connect` that started a fresh shell every time would
/// throw that away exactly as `ssh` does.
fn pick_session(
    reached: &Reached,
    argv: &[String],
    fresh: bool,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if !fresh {
        let existing = reached.sessions()?;
        let alive = existing
            .as_array()
            .and_then(|rows| {
                // The newest first: sessions are named in creation order, so
                // the last match is the one most recently worked in.
                rows.iter().rfind(|s| {
                    if s.get("alive").and_then(Value::as_bool) != Some(true) {
                        return false;
                    }
                    // Only a session of the same shape. Reattaching a bare
                    // `connect` to somebody's running `claude` would drop the
                    // user into an agent they did not ask for.
                    let theirs: Vec<&str> = s
                        .get("argv")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    // An empty argv means "the login shell", and the daemon
                    // resolves that before it reports it — a plain `connect`
                    // asks for `[]` and is listed back as `["/bin/zsh"]`.
                    // Comparing the two literally never matched, so every
                    // `connect` opened a new shell and the persistence this
                    // command exists for was invisible.
                    if argv.is_empty() {
                        return theirs.len() <= 1;
                    }
                    theirs == argv.iter().map(String::as_str).collect::<Vec<_>>()
                })
            })
            .and_then(|s| s.get("id").and_then(Value::as_str).map(str::to_string));
        if let Some(id) = alive {
            eprintln!("Reattaching to {id}. Ctrl-] to detach.");
            return Ok(id);
        }
    }
    let made = reached.create_session(argv, cols, rows)?;
    let sid = made
        .get("id")
        .and_then(Value::as_str)
        .ok_or("The box made a session but did not name it.")?;
    eprintln!("Session {sid}. Ctrl-] to detach.");
    Ok(sid.to_string())
}

// ---- the terminal ----------------------------------------------------------

/// Detach. Ctrl-] because telnet used it and nothing else wants it — and it is
/// not `~.`, which only works at the start of a line and surprises everyone.
const DETACH: u8 = 0x1d;

/// Puts the terminal back the way it was found, including on the way out of a
/// panic. Leaving a shell in raw mode is the rudest thing a program like this
/// can do: no echo, no line editing, and no obvious way to fix it.
struct Raw(libc::termios);

impl Raw {
    fn on() -> Option<Raw> {
        if !std::io::stdin().is_terminal() {
            return None;
        }
        unsafe {
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut saved) != 0 {
                return None;
            }
            let mut raw = saved;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) != 0 {
                return None;
            }
            Some(Raw(saved))
        }
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0);
        }
    }
}

fn window_size() -> (u16, u16) {
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            return (ws.ws_col, ws.ws_row);
        }
    }
    (80, 24)
}

/// stdin here, the socket there, until one of them stops.
///
/// The only part of this program that needs a runtime, and the only part that
/// needs to do two things at once: bytes arriving from the box have nothing to
/// do with bytes being typed, and either can be idle for hours.
fn pump(url: &str, token: &str, cols: u16, rows: u16) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        let request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
            .map_err(|e| e.to_string())
            .and_then(|mut r| {
                let value = format!("Bearer {token}")
                    .parse()
                    .map_err(|_| "bad token".to_string())?;
                r.headers_mut().insert("authorization", value);
                Ok(r)
            })?;
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("Could not reach the box: {e}"))?;
        let (mut tx, mut rx) = socket.split();

        tx.send(Message::Text(json!({"t":"resize","cols":cols,"rows":rows}).to_string()))
            .await
            .map_err(|e| e.to_string())?;

        // Raw only once the socket is up: failing to connect should leave the
        // shell exactly as it was, with the error readable on a normal line.
        let _raw = Raw::on();

        // stdin on its own thread rather than tokio's, which backs it with a
        // blocking pool anyway. A read parked in there cannot be cancelled, so
        // owning the thread means shutdown never waits on a keystroke.
        let (keys, mut typed) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 4096];
            while let Ok(n) = stdin.read(&mut buf) {
                if n == 0 || keys.blocking_send(buf[..n].to_vec()).is_err() {
                    return;
                }
            }
        });

        let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .map_err(|e| e.to_string())?;
        let mut out = std::io::stdout();
        let mut detached = false;
        let mut stdin_done = false;

        loop {
            tokio::select! {
                message = rx.next() => match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        out.write_all(&bytes).map_err(|e| e.to_string())?;
                        out.flush().map_err(|e| e.to_string())?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        // `exit` is the child ending, which is the one server
                        // message that means this program is done.
                        if serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| v.get("t").and_then(Value::as_str).map(str::to_string))
                            .as_deref()
                            == Some("exit")
                        {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(format!("The connection dropped: {e}")),
                    None => break,
                },
                chunk = typed.recv(), if !stdin_done => match chunk {
                    Some(bytes) => {
                        if let Some(cut) = bytes.iter().position(|b| *b == DETACH) {
                            if cut > 0 {
                                let _ = tx.send(Message::Binary(bytes[..cut].to_vec())).await;
                            }
                            detached = true;
                            break;
                        }
                        if tx.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    // Nothing left to type is not a reason to hang up. The
                    // command is still running and its output is still coming;
                    // closing here truncates it, which is what
                    // `dpctl run box -- cmd` looks like in a pipeline and what
                    // any use of this under `< file` would do. The socket ends
                    // when the far side says so.
                    None => stdin_done = true,
                },
                _ = winch.recv() => {
                    let (cols, rows) = window_size();
                    let msg = json!({"t":"resize","cols":cols,"rows":rows}).to_string();
                    if tx.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            }
        }

        drop(_raw);
        if detached {
            eprintln!("\r\nDetached. Everything on the box keeps running.");
        }
        Ok(())
    })
}

// ---- forwarding ------------------------------------------------------------

/// Accepts on localhost and gives each connection its own tunnel.
///
/// One websocket per TCP connection rather than one multiplexed socket with a
/// stream id. Multiplexing means inventing a framing layer, a close protocol
/// and a flow-control story, all of which the websocket already has — and the
/// thing being forwarded is a dev server, where connection counts are in the
/// tens rather than the thousands.
///
/// Bound to loopback, never `0.0.0.0`. A forward bound to every interface
/// republishes the box's private port to whatever network the laptop is on,
/// which is a coffee shop about half the time.
fn listen(local: u16, remote: u16, url: &str, token: &str, name: &str) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    let ws = format!("{url}/v1/forward?port={remote}");
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", local))
            .await
            .map_err(|e| format!("Could not listen on localhost:{local}: {e}"))?;
        eprintln!("localhost:{local} → {name}:{remote}. Ctrl-C to stop.");

        loop {
            let (socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let ws = ws.clone();
            let token = token.to_string();
            tokio::spawn(async move {
                if let Err(e) = tunnel(socket, &ws, &token).await {
                    // Per connection, not fatal: a dev server restarting should
                    // cost the request in flight and nothing else.
                    eprintln!("dpctl: {e}");
                }
            });
        }
    })
}

/// One accepted connection, spliced to the box's port over its own socket.
async fn tunnel(socket: tokio::net::TcpStream, url: &str, token: &str) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
            .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {token}").parse().map_err(|_| "bad token".to_string())?,
    );
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("could not open a tunnel: {e}"))?;

    let _ = socket.set_nodelay(true);
    let (mut read, mut write) = socket.into_split();
    let (mut tx, mut rx) = ws.split();

    let mut up = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.close().await;
    });

    let mut down = tokio::spawn(async move {
        while let Some(Ok(message)) = rx.next().await {
            match message {
                Message::Binary(bytes)
                    if write.write_all(&bytes).await.is_err() => {
                        break;
                    }
                // The daemon says so in words when nothing is listening on the
                // box, because a refused connection arriving as a bare close
                // frame is indistinguishable from the tunnel itself failing.
                Message::Text(text) => {
                    if let Some(why) = serde_json::from_str::<Value>(&text)
                        .ok()
                        .filter(|v| v.get("t").and_then(Value::as_str) == Some("refused"))
                        .and_then(|v| v.get("why").and_then(Value::as_str).map(str::to_string))
                    {
                        eprintln!("dpctl: nothing is listening on the box: {why}");
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = write.shutdown().await;
    });

    tokio::select! {
        _ = &mut up => down.abort(),
        _ = &mut down => up.abort(),
    }
    Ok(())
}

// ---- odds and ends ---------------------------------------------------------

fn flag(args: &[&str], name: &str) -> Option<String> {
    args.iter().position(|a| *a == name).and_then(|i| args.get(i + 1)).map(|s| s.to_string())
}

fn prompt(label: &str) -> Result<String, String> {
    print!("{label}");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

/// A password, without echoing it to a terminal somebody is sharing.
fn prompt_secret(label: &str) -> Result<String, String> {
    print!("{label}");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let restore = unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut term) == 0 {
            let saved = term;
            term.c_lflag &= !libc::ECHO;
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term);
            Some(saved)
        } else {
            None
        }
    };
    let mut line = String::new();
    let read = std::io::stdin().read_line(&mut line);
    if let Some(saved) = restore {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &saved);
        }
    }
    println!();
    read.map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

fn fail(message: &str) -> i32 {
    eprintln!("dpctl: {message}");
    1
}

/// Where the session token lives.
///
/// The system keychain when there is one, because this is the credential for
/// the whole account and a file in `$HOME` is readable by anything the user
/// runs. `security` rather than a crate: it is the same reasoning as the vault
/// client shelling out to `curl` — no new dependency tree for one call, and
/// nothing linked in that has to be kept current.
mod keychain {
    use std::io::Write;
    use std::process::{Command, Stdio};

    const SERVICE: &str = "devpipe";
    const ACCOUNT: &str = "dpctl";

    fn file() -> Option<std::path::PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
        Some(base.join("devpipe").join("token"))
    }

    fn has_security() -> bool {
        cfg!(target_os = "macos") && Command::new("which").arg("security").output().is_ok_and(|o| o.status.success())
    }

    pub fn read() -> Option<String> {
        if has_security() {
            let out = Command::new("security")
                .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
                .output()
                .ok()?;
            if out.status.success() {
                let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
            return None;
        }
        let token = std::fs::read_to_string(file()?).ok()?.trim().to_string();
        (!token.is_empty()).then_some(token)
    }

    pub fn write(payload: &str) -> Result<(), String> {
        if has_security() {
            // On stdin via -w with no value: passing the token in argv would
            // put the account's credential where `ps` can read it.
            let mut child = Command::new("security")
                .args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", payload])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            let status = child.wait().map_err(|e| e.to_string())?;
            if status.success() {
                return Ok(());
            }
        }
        let path = file().ok_or("No home directory to store a token in.")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        // Before the write, not after: a token is readable by everyone on the
        // machine for the moment in between.
        permit(&f)?;
        f.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(unix)]
    fn permit(f: &std::fs::File) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
    }

    #[cfg(not(unix))]
    fn permit(_: &std::fs::File) -> Result<(), String> {
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        if has_security() {
            let _ = Command::new("security")
                .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if let Some(path) = file() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}

// ---- files ----------------------------------------------------------------

/// Moving a file between a box and this machine.
///
/// The gap was total: not a spec to hand an agent, not an artifact it made, not
/// the one file you would rather fix in your own editor. The workarounds were a
/// git round-trip for things that are not code, or a heredoc down a terminal.
///
/// It goes over the daemon's own door with the daemon's own bearer — the same
/// one `connect` and `port` use — rather than reopening SSH, which a box locks
/// down on purpose and whose host key changes on every wake.

/// `box:/path` — scp's spelling, because that is the shape people expect.
fn split_remote(spec: &str) -> Option<(&str, &str)> {
    let (name, path) = spec.split_once(':')?;
    if name.is_empty() || path.is_empty() { None } else { Some((name, path)) }
}

/// Percent-encoding for a query value. Everything but the unreserved set, so a
/// path with a space, a `#`, or a `&` in it survives the trip.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The daemon speaks HTTPS on the same name it speaks websockets on.
fn http_base(reached: &Reached) -> String {
    reached.url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1)
}

fn fs_url(reached: &Reached, endpoint: &str, path: &str) -> String {
    format!("{}/v1/fs/{endpoint}?path={}", http_base(reached), encode(path))
}

/// What the daemon said went wrong, rather than a bare status code.
fn box_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(_, response) => {
            let said = response.into_string().unwrap_or_default();
            let said = said.trim();
            if said.is_empty() { "the box refused that".into() } else { said.to_string() }
        }
        other => other.to_string(),
    }
}

fn authed(req: ureq::Request, reached: &Reached) -> ureq::Request {
    req.set("authorization", &format!("Bearer {}", reached.token))
}

fn ls(name: &str, path: Option<&str>) -> i32 {
    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };
    let url = fs_url(&reached, "list", path.unwrap_or("~"));
    let listing: Value = match authed(ureq::get(&url), &reached).call() {
        Ok(r) => r.into_json().unwrap_or(Value::Null),
        Err(e) => return fail(&box_error(e)),
    };

    println!("{}", listing.get("path").and_then(Value::as_str).unwrap_or(""));
    for entry in listing.get("entries").and_then(Value::as_array).into_iter().flatten() {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        let dir = entry.get("dir").and_then(Value::as_bool).unwrap_or(false);
        let link = entry.get("link").and_then(Value::as_bool).unwrap_or(false);
        let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
        // The mark goes on the name rather than in a column: a listing is read
        // down the left edge, and a size column nobody asked for pushes the
        // only thing anybody is looking for off to the right.
        let mark = if link { "@" } else if dir { "/" } else { "" };
        if dir {
            println!("  {name}{mark}");
        } else {
            println!("  {name}{mark}  {}", human(size));
        }
    }
    0
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{size:.1} {}", UNITS[unit]) }
}

/// A file or a directory, off the box and onto this machine.
fn pull(spec: &str, dest: Option<&str>) -> i32 {
    let Some((name, remote)) = split_remote(spec) else {
        return fail("A pull looks like `dpctl pull mybox:~/notes.md .`");
    };
    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };

    // Asked once, so the two shapes are not two round trips and a guess.
    let listed = authed(ureq::get(&fs_url(&reached, "list", remote)), &reached).call();
    let is_dir = listed.is_ok();

    let leaf = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("download");
    let dest = std::path::PathBuf::from(dest.unwrap_or("."));
    let target = if dest.is_dir() { dest.join(leaf) } else { dest };

    if is_dir {
        // Straight into tar rather than through a temporary file: a project is
        // the common case and it does not want to land on disk twice.
        let response = match authed(ureq::get(&fs_url(&reached, "tar", remote)), &reached).call() {
            Ok(r) => r,
            Err(e) => return fail(&box_error(e)),
        };
        let into = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
        if let Err(e) = std::fs::create_dir_all(into) {
            return fail(&format!("{}: {e}", into.display()));
        }
        let spawned = std::process::Command::new("tar")
            .arg("-xzf")
            .arg("-")
            .arg("-C")
            .arg(into)
            .stdin(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => return fail(&format!("tar: {e}")),
        };
        let mut reader = response.into_reader();
        let mut stdin = child.stdin.take().expect("piped");
        if let Err(e) = std::io::copy(&mut reader, &mut stdin) {
            return fail(&format!("the download stopped: {e}"));
        }
        drop(stdin);
        match child.wait() {
            Ok(status) if status.success() => {
                println!("{} -> {}", spec, into.join(leaf).display());
                0
            }
            Ok(_) => fail("tar could not unpack that"),
            Err(e) => fail(&format!("tar: {e}")),
        }
    } else {
        let response = match authed(ureq::get(&fs_url(&reached, "read", remote)), &reached).call() {
            Ok(r) => r,
            Err(e) => return fail(&box_error(e)),
        };
        if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty())
            && let Err(e) = std::fs::create_dir_all(parent)
        {
            return fail(&format!("{}: {e}", parent.display()));
        }
        let mut file = match std::fs::File::create(&target) {
            Ok(f) => f,
            Err(e) => return fail(&format!("{}: {e}", target.display())),
        };
        match std::io::copy(&mut response.into_reader(), &mut file) {
            Ok(bytes) => {
                println!("{} -> {} ({})", spec, target.display(), human(bytes));
                0
            }
            Err(e) => fail(&format!("the download stopped: {e}")),
        }
    }
}

/// A file or a directory, off this machine and onto the box.
///
/// A directory goes up one file at a time rather than as an archive, which is
/// slower and is the point: unpacking an archive on the box means trusting the
/// names inside it, as root. Downloads have no such problem, which is why they
/// are allowed the shortcut.
fn push(local: &str, spec: &str) -> i32 {
    let Some((name, remote)) = split_remote(spec) else {
        return fail("A push looks like `dpctl push ./notes.md mybox:~/notes.md`");
    };
    let source = std::path::PathBuf::from(local);
    let meta = match std::fs::metadata(&source) {
        Ok(m) => m,
        Err(e) => return fail(&format!("{local}: {e}")),
    };
    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };

    if meta.is_file() {
        return match put_one(&reached, &source, remote) {
            Ok(bytes) => {
                println!("{local} -> {spec} ({})", human(bytes));
                0
            }
            Err(e) => fail(&e),
        };
    }

    let mut sent = 0u64;
    let mut files = 0u64;
    let mut stack = vec![source.clone()];
    while let Some(dir) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => return fail(&format!("{}: {e}", dir.display())),
        };
        for item in read.flatten() {
            let path = item.path();
            // Not followed. A link pointing outside the tree would copy
            // somebody's whole home directory onto a box by accident.
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(relative) = path.strip_prefix(&source) else { continue };
            let target = format!("{}/{}", remote.trim_end_matches('/'), relative.to_string_lossy());
            match put_one(&reached, &path, &target) {
                Ok(bytes) => {
                    sent += bytes;
                    files += 1;
                    eprint!("\r{files} file{}, {}   ", if files == 1 { "" } else { "s" }, human(sent));
                }
                Err(e) => {
                    eprintln!();
                    return fail(&e);
                }
            }
        }
    }
    eprintln!();
    println!("{local} -> {spec} ({files} file{}, {})", if files == 1 { "" } else { "s" }, human(sent));
    0
}

fn put_one(reached: &Reached, source: &std::path::Path, remote: &str) -> Result<u64, String> {
    let file = std::fs::File::open(source).map_err(|e| format!("{}: {e}", source.display()))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    authed(ureq::put(&fs_url(reached, "write", remote)), reached)
        .set("content-type", "application/octet-stream")
        .send(file)
        .map_err(box_error)?;
    Ok(size)
}

/// Fetch it, open it in your editor, and send it back if it changed.
///
/// The whole reason to want a shared filesystem, in the one case that is worth
/// having without one: a file on the box that you would rather fix yourself
/// than describe to an agent.
fn edit(spec: &str) -> i32 {
    let Some((name, remote)) = split_remote(spec) else {
        return fail("An edit looks like `dpctl edit mybox:~/src/main.rs`");
    };
    let reached = match reach(name) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };

    let before = match authed(ureq::get(&fs_url(&reached, "read", remote)), &reached).call() {
        Ok(r) => {
            let mut buf = Vec::new();
            if let Err(e) = std::io::copy(&mut r.into_reader(), &mut buf) {
                return fail(&format!("the download stopped: {e}"));
            }
            buf
        }
        Err(e) => return fail(&box_error(e)),
    };

    let leaf = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("file");
    let scratch = std::env::temp_dir().join(format!("dpctl-{}-{leaf}", std::process::id()));
    if let Err(e) = std::fs::write(&scratch, &before) {
        return fail(&format!("{}: {e}", scratch.display()));
    }

    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".to_string());
    // Through a shell, because EDITOR is often more than a program name —
    // `code --wait`, `emacsclient -nw`.
    let ran = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&scratch)
        .status();
    match ran {
        Ok(status) if status.success() => {}
        Ok(_) => {
            let _ = std::fs::remove_file(&scratch);
            return fail("the editor exited badly; nothing was sent back");
        }
        Err(e) => {
            let _ = std::fs::remove_file(&scratch);
            return fail(&format!("{editor}: {e}"));
        }
    }

    let after = std::fs::read(&scratch).unwrap_or_default();
    let _ = std::fs::remove_file(&scratch);
    if after == before {
        println!("unchanged");
        return 0;
    }
    // Written whole and renamed on the box, so an agent reading it never sees
    // half a file.
    match authed(ureq::put(&fs_url(&reached, "write", remote)), &reached)
        .set("content-type", "application/octet-stream")
        .send_bytes(&after)
    {
        Ok(_) => {
            println!("{spec} ({})", human(after.len() as u64));
            0
        }
        Err(e) => fail(&box_error(e)),
    }
}
