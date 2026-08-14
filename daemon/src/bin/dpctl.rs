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

/// Find the box, wake it if it is asleep, get a session, and hand over the
/// terminal.
fn attach_to(name: &str, argv: Vec<String>, fresh: bool) -> i32 {
    let account = match Account::load() {
        Ok(a) => a,
        Err(e) => return fail(&e),
    };
    let target = match account.find_box(name) {
        Ok(b) => b,
        Err(e) => return fail(&e),
    };

    let id = target.get("id").and_then(Value::as_i64).unwrap_or(0);
    let status = target.get("status").and_then(Value::as_str).unwrap_or("");

    // Waking is the thing SSH could never do. A box asleep is a box whose
    // droplet does not exist; asking for a shell is a perfectly clear
    // instruction to bring it back, and making somebody open a browser to
    // press a button first is the friction this tool exists to remove.
    if status == "asleep" {
        eprintln!("{name} is asleep. Waking it — this takes about three minutes.");
        if let Err(e) = account.post(&format!("/api/boxes/{id}/wake"), Value::Null) {
            return fail(&e);
        }
        if let Err(e) = wait_until_ready(&account, id) {
            return fail(&e);
        }
    } else if status != "ready" {
        return fail(&format!(
            "{name} is {status}, not ready. `dpctl boxes` will show what it is doing."
        ));
    }

    let conn = match account.get(&format!("/api/boxes/{id}/connection")) {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    let (Some(url), Some(token)) = (
        conn.get("url").and_then(Value::as_str),
        conn.get("token").and_then(Value::as_str),
    ) else {
        return fail("The server did not say how to reach that box.");
    };

    let (cols, rows) = window_size();
    let session = match pick_session(&account, id, &argv, fresh, cols, rows) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };

    let ws = format!("{url}/v1/sessions/{session}/attach");
    match pump(&ws, token, cols, rows) {
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
    account: &Account,
    id: i64,
    argv: &[String],
    fresh: bool,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if !fresh {
        let existing = account.get(&format!("/api/boxes/{id}/sessions"))?;
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
                    let theirs = s.get("argv").and_then(Value::as_array).cloned().unwrap_or_default();
                    theirs.iter().filter_map(Value::as_str).eq(argv.iter().map(String::as_str))
                })
            })
            .and_then(|s| s.get("id").and_then(Value::as_str).map(str::to_string));
        if let Some(id) = alive {
            eprintln!("Reattaching to {id}. Ctrl-] to detach.");
            return Ok(id);
        }
    }
    let made = account.post(
        &format!("/api/boxes/{id}/sessions"),
        json!({ "argv": argv, "cols": cols, "rows": rows }),
    )?;
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
                chunk = typed.recv() => match chunk {
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
                    None => break,
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
