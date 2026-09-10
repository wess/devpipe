//! The command line.
//!
//! Everything below the daemon addresses the tree by path — `machine`,
//! `machine/environment`, `machine/environment/session` — because the tree is
//! what a person is looking at, and what you read off it should be what you
//! type back. There is no noun to learn and no id to remember.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use tokio::net::TcpListener;

use devpipe::backend::{Backend, docker::Docker, local::Local};
use devpipe::host::{Host, state_dir};
use devpipe::machines::{DEFAULT_PORT, Machine, Machines, Reached, Spot};
use devpipe::proto::{EnvInfo, FromClient, FromServer, HostInfo};
use devpipe::tunnel::{self, Asked, Target};
use devpipe::{attach, secrets, serve, term};

/// How long one machine gets to answer before the tree prints it as
/// unreachable. A dead box must cost the view a moment, never the whole thing.
const REACH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Parser)]
#[command(
    name = "devpipe",
    version,
    about = "Remote agentic development environments",
    after_help = "Everything is addressed by path: machine/environment/session.\n\
                  Start with `add <ssh-host>`, then run it with no arguments.\n\
                  Installed as both `devpipe` and `dp`."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Show the tree: every machine, what it is running, and what is in it.
    #[command(visible_alias = "ls")]
    Tree {
        /// Narrow it: a machine, or a machine/environment.
        path: Option<String>,
        /// Stay open and redraw when anything changes, anywhere. Ctrl-C ends
        /// it.
        #[arg(long, short)]
        watch: bool,
    },
    /// Remember a machine. The name doubles as its ssh destination.
    Add {
        name: String,
        /// An ssh destination, when it is not the name itself.
        #[arg(long)]
        ssh: Option<String>,
        /// A daemon on this very machine, rather than one across ssh.
        #[arg(long, conflicts_with_all = ["ssh", "url"])]
        here: bool,
        /// A host reached some other way. Needs --token.
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        token: Option<String>,
        /// A relay this machine has dialled out to, for one you cannot ssh
        /// into. Needs --token (the host's) and --relay-token (the relay's).
        #[arg(long)]
        relay: Option<String>,
        #[arg(long)]
        relay_token: Option<String>,
        /// The port the daemon listens on over there.
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
    },
    /// Forget a machine. Nothing on it is touched.
    Forget { name: String },
    /// Make an environment: a workspace, its own ports, its own processes.
    New {
        /// `machine/name`, or just `name` when you have one machine.
        path: String,
        /// Cloned into the workspace before anyone is told it exists.
        #[arg(long)]
        repo: Option<String>,
        /// A port the environment listens on inside itself. Repeatable — two
        /// environments can both want 3000.
        #[arg(long, short)]
        port: Vec<u16>,
        #[arg(long)]
        image: Option<String>,
        /// How much memory it may use: `1g`, `512m`. Defaults to whatever the
        /// machine hands out.
        #[arg(long)]
        memory: Option<String>,
    },
    /// Open a pane on a session. Ctrl-] detaches; the session keeps running.
    Attach {
        /// `machine/environment` starts a session, `machine/environment/id`
        /// resumes one.
        path: Option<String>,
        /// What to run. Defaults to a shell inside the environment.
        #[arg(last = true)]
        argv: Vec<String>,
    },
    /// Reach an environment's ports from this machine, until ctrl-c.
    Forward {
        /// `machine/environment`.
        path: String,
        /// Which ports, as the environment sees them: `3000`, or `8080:3000`
        /// to land it somewhere else here. All of them when you name none.
        ports: Vec<String>,
    },
    /// Wake an environment.
    Start { path: String },
    /// Sleep an environment. The workspace is untouched.
    Stop { path: String },
    /// Give an environment's compute back. The workspace stays on the machine.
    Rm { path: String },
    /// The credentials every environment on a machine is lent.
    Secret {
        #[command(subcommand)]
        command: SecretCommand,
        /// Which machine. Omit when you have one.
        #[arg(long)]
        on: Option<String>,
    },
    /// Serve this machine as a host: many environments, one machine.
    Serve {
        /// Loopback by default. The supported way to reach a host from
        /// elsewhere is ssh, which is what `devpipe add` sets up.
        #[arg(long, default_value = "127.0.0.1:7455")]
        bind: String,
        /// Read from, or written to, `<state-dir>/token` when absent — a token
        /// minted per run cannot be used by anything that restarts on its own.
        #[arg(long, env = "DEVPIPE_TOKEN")]
        token: Option<String>,
        /// `docker` or `podman` gives an environment its own filesystem,
        /// processes and ports. `local` is bridge mode: one environment that
        /// *is* this machine.
        #[arg(long, default_value = "docker")]
        backend: String,
        /// What a new environment is made of when nobody names an image.
        /// Remembered, so it only has to be said once.
        #[arg(long)]
        image: Option<String>,
        /// Dial out to a relay and stay enrolled there, so clients that cannot
        /// reach this machine — a browser, anything behind NAT — can be
        /// introduced to it. Runs alongside the local listener, not instead.
        #[arg(long)]
        relay: Option<String>,
        /// The relay's secret, which is not this host's.
        #[arg(long, env = "DEVPIPE_RELAY_TOKEN")]
        relay_token: Option<String>,
        /// What this host is called at the relay. Defaults to its hostname.
        #[arg(long)]
        relay_name: Option<String>,
        /// How much memory each environment may use: `1g`, `512m`. Unset means
        /// no ceiling, which is right on a workstation and wrong on a small
        /// machine — there, one unbounded build takes the daemon with it.
        #[arg(long)]
        memory: Option<String>,
        #[arg(long)]
        state_dir: Option<PathBuf>,
    },
    /// Introduce clients to machines that dialled out.
    ///
    /// For hosts a browser has to reach, or that nothing can ssh into. It
    /// routes bytes and never learns what they mean.
    Relay {
        #[command(subcommand)]
        command: RelayCommand,
        /// Where its keys live. Beside the daemon's own state by default.
        #[arg(long, global = true)]
        state_dir: Option<PathBuf>,
    },
    /// Hold one session's pty. Started by the daemon, never by a person: it
    /// reads what to run from its stdin and serves it on a unix socket.
    #[command(hide = true)]
    Keep {
        #[arg(long)]
        runtime_dir: PathBuf,
    },
}

#[derive(Subcommand)]
enum RelayCommand {
    /// Run it.
    Serve {
        /// Bind loopback and put a TLS terminator in front, or bind publicly
        /// and accept that machines dial it in the clear.
        #[arg(long, default_value = "127.0.0.1:7456")]
        bind: String,
    },
    /// Mint a key for an account. Shown once, and never again by anything —
    /// what is kept is what it hashes to.
    Grant {
        #[arg(long)]
        account: String,
        /// `enrol` for a machine, `reach` for a person. They are stolen
        /// differently, so they are separate.
        #[arg(long, default_value = "reach")]
        can: devpipe::keys::Can,
        /// What it is for, for whoever has to decide later which to revoke.
        #[arg(long, default_value = "")]
        note: String,
    },
    /// Take one back, by the prefix `keys` shows.
    Revoke { prefix: String },
    /// What has been granted. Never the keys themselves.
    Keys,
}

#[derive(Subcommand)]
enum SecretCommand {
    /// Names, never values.
    Ls,
    /// Set one. The value is read without echo unless it was written as
    /// `NAME=value`, which puts it in the shell's history.
    Set { assignment: String },
    /// Forget one. Sessions already running keep what they were given.
    Rm { name: String },
}

/// Parse, but under whichever name this was called by.
///
/// `dp` is a symlink to the same binary, and a help text that answers `dp
/// --help` with a page full of `devpipe` is a page telling you to type
/// something other than what you typed.
fn parse() -> Cli {
    let short = std::env::args_os()
        .next()
        .map(PathBuf::from)
        .and_then(|arg0| arg0.file_name().map(|n| n.to_string_lossy().into_owned()))
        .is_some_and(|name| name == "dp");
    let mut command = Cli::command();
    if short {
        command = command.name("dp");
    }
    Cli::from_arg_matches(&command.get_matches()).unwrap_or_else(|e| e.exit())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Nothing at all is the question people ask most often, so it is the one
    // that needs no argument: show me everything.
    match parse().command.unwrap_or(Command::Tree {
        path: None,
        watch: false,
    }) {
        Command::Tree { path, watch } => {
            if watch {
                watch_tree(path).await
            } else {
                tree(path).await
            }
        }
        Command::Add {
            name,
            ssh,
            here,
            url,
            token,
            relay,
            relay_token,
            port,
        } => {
            add(Adding {
                name,
                ssh,
                here,
                url,
                token,
                relay,
                relay_token,
                port,
            })
            .await
        }
        Command::Forget { name } => {
            let mut machines = Machines::open(&state_dir());
            machines.forget(&name)?;
            println!("forgot {name}");
            Ok(())
        }
        Command::New {
            path,
            repo,
            port,
            image,
            memory,
        } => {
            let spot = spot(&path)?;
            let name = spot
                .environment
                .clone()
                .context("say what to call it: devpipe new <machine>/<name>")?;
            ask(
                &spot,
                FromClient::CreateEnvironment {
                    name,
                    image,
                    ports: port,
                    repo,
                    memory,
                },
            )
            .await
        }
        Command::Start { path } => {
            let spot = spot(&path)?;
            let id = environment_of(&spot)?;
            ask(&spot, FromClient::StartEnvironment { id }).await
        }
        Command::Stop { path } => {
            let spot = spot(&path)?;
            let id = environment_of(&spot)?;
            ask(&spot, FromClient::StopEnvironment { id }).await
        }
        Command::Rm { path } => {
            let spot = spot(&path)?;
            let id = environment_of(&spot)?;
            ask(&spot, FromClient::DestroyEnvironment { id }).await
        }
        Command::Attach { path, argv } => open(path, argv).await,
        Command::Forward { path, ports } => forward(path, ports).await,
        Command::Secret { command, on } => secret(command, on).await,
        Command::Serve {
            bind,
            token,
            backend,
            image,
            relay,
            relay_token,
            relay_name,
            memory,
            state_dir: dir,
        } => {
            daemon(Serving {
                bind,
                token,
                backend,
                image,
                memory,
                dir,
                relay,
                relay_token,
                relay_name,
            })
            .await
        }
        Command::Relay { command, state_dir } => relaying(command, state_dir).await,
        Command::Keep { runtime_dir } => devpipe::keeper::run(runtime_dir).await,
    }
}

fn spot(path: &str) -> Result<Spot> {
    Spot::parse(path, &Machines::open(&state_dir()))
}

fn environment_of(spot: &Spot) -> Result<String> {
    spot.environment
        .clone()
        .context("name an environment: devpipe <verb> <machine>/<environment>")
}

// ------------------------------------------------------------------ the tree

async fn tree(path: Option<String>) -> Result<()> {
    let machines = Machines::open(&state_dir());
    if machines.is_empty() {
        println!("No machines yet.\n");
        println!("  devpipe add <ssh-host>      a box you can ssh into");
        println!("  devpipe add laptop --here   the daemon on this machine");
        return Ok(());
    }

    let narrowed = match &path {
        Some(path) => Some(Spot::parse(path, &machines)?),
        None => None,
    };
    let wanted: Vec<&Machine> = match &narrowed {
        Some(spot) => vec![spot.machine(&machines)?],
        None => machines.all().iter().collect(),
    };

    // All of them at once. Four machines answering one after another is four
    // ssh handshakes of waiting, and the whole point of the view is that it
    // takes one glance.
    let looking = wanted.iter().map(|machine| async move {
        let reached = tokio::time::timeout(REACH_TIMEOUT, machine.reach()).await;
        let seen = match reached {
            Ok(Ok(reached)) => Ok(reached.host),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("did not answer in time".to_string()),
        };
        (machine, seen)
    });

    let only = narrowed.as_ref().and_then(|s| s.environment.clone());
    let mut first = true;
    for (machine, seen) in futures_util::future::join_all(looking).await {
        if !first {
            println!();
        }
        first = false;
        match seen {
            // A machine that is down is a line in the tree, not the end of the
            // command. With four of them, one being off must not cost the view.
            Err(why) => println!("{}\n  unreachable — {why}", machine.name),
            Ok(host) => print_machine(&machine.name, &host, only.as_deref()),
        }
    }
    Ok(())
}

fn print_machine(name: &str, host: &HostInfo, only: Option<&str>) {
    let count = host.environments.len();
    println!(
        "{name}   {} · {}",
        host.backend,
        match count {
            0 => "empty".to_string(),
            1 => "1 environment".to_string(),
            n => format!("{n} environments"),
        }
    );
    if !host.secrets.is_empty() {
        println!("  lending {}", host.secrets.join(" "));
    }
    if count == 0 {
        println!("  devpipe new {name}/<name>");
        return;
    }
    for environment in &host.environments {
        if only.is_some_and(|wanted| wanted != environment.name && wanted != environment.id) {
            continue;
        }
        print_environment(environment);
    }
}

fn print_environment(environment: &EnvInfo) {
    let ports: Vec<String> = environment
        .ports
        .iter()
        .map(|p| format!("{} → localhost:{}", p.inside, p.outside))
        .collect();
    println!(
        "  {:<20} {:<9} {}{}",
        environment.name,
        environment.status,
        ports.join("  "),
        environment
            .memory
            .as_deref()
            .map(|m| format!("  [{m}]"))
            .unwrap_or_default()
    );
    for session in &environment.sessions {
        // The title is what the program inside called itself, which is the
        // most useful thing anyone can say about a running session.
        let what = if session.title.is_empty() {
            session
                .argv
                .first()
                .map(|a| a.rsplit('/').next().unwrap_or(a).to_string())
                .unwrap_or_else(|| "session".into())
        } else {
            session.title.clone()
        };
        println!("    {:<18} {}", session.id, what);
    }
}

// ------------------------------------------------------------- the live tree

/// How long to wait after a change before redrawing, so a burst — an
/// environment starting three sessions — costs one repaint rather than three.
const SETTLE: Duration = Duration::from_millis(80);

/// How long before trying a machine that went away again.
const RETRY: Duration = Duration::from_secs(5);

async fn watch_tree(path: Option<String>) -> Result<()> {
    let machines = Machines::open(&state_dir());
    if machines.is_empty() {
        bail!("no machines yet — `devpipe add <name>` first");
    }
    let wanted: Vec<Machine> = match &path {
        Some(path) => vec![Spot::parse(path, &machines)?.machine(&machines)?.clone()],
        None => machines.all().to_vec(),
    };

    // One shared picture, written by one task per machine and read by the
    // painter. A machine that is down holds its last words here rather than
    // disappearing from the list.
    let seen: Arc<std::sync::Mutex<std::collections::BTreeMap<String, Result<HostInfo, String>>>> =
        Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
    let (changed, mut changes) = tokio::sync::mpsc::channel::<()>(64);

    for machine in wanted {
        let seen = seen.clone();
        let changed = changed.clone();
        tokio::spawn(async move { follow(machine, seen, changed).await });
    }
    drop(changed);

    while changes.recv().await.is_some() {
        // Drain whatever else arrived while we were being told about the
        // first thing.
        tokio::time::sleep(SETTLE).await;
        while changes.try_recv().is_ok() {}

        let picture = seen.lock().unwrap().clone();
        // Home and clear-below rather than clear-all: this leaves the
        // scrollback alone, so ctrl-C does not wipe what was on screen before.
        print!("\x1b[H\x1b[J");
        for (name, host) in &picture {
            match host {
                Ok(host) => print_machine(name, host, None),
                Err(why) => println!("{name}\n  unreachable — {why}"),
            }
            println!();
        }
        println!("watching {} machine(s) · ctrl-c to stop", picture.len());
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
    Ok(())
}

/// Keep one machine's corner of the picture current, forever.
async fn follow(
    machine: Machine,
    seen: Arc<std::sync::Mutex<std::collections::BTreeMap<String, Result<HostInfo, String>>>>,
    changed: tokio::sync::mpsc::Sender<()>,
) {
    loop {
        let outcome = follow_once(&machine, &seen, &changed).await;
        // Whatever went wrong, say so in the tree rather than on top of it,
        // and try again. A box that reboots should come back on its own.
        seen.lock().unwrap().insert(
            machine.name.clone(),
            Err(match outcome {
                Err(e) => e.to_string(),
                Ok(()) => "connection closed".to_string(),
            }),
        );
        if changed.send(()).await.is_err() {
            return;
        }
        tokio::time::sleep(RETRY).await;
    }
}

async fn follow_once(
    machine: &Machine,
    seen: &Arc<std::sync::Mutex<std::collections::BTreeMap<String, Result<HostInfo, String>>>>,
    changed: &tokio::sync::mpsc::Sender<()>,
) -> Result<()> {
    let mut reached = machine.reach().await?;
    seen.lock()
        .unwrap()
        .insert(machine.name.clone(), Ok(reached.host.clone()));
    changed.send(()).await?;

    reached.client.say(FromClient::Watch { on: true }).await?;
    while let Some(said) = reached.client.control().await? {
        // Before the lock, because answering it is a round trip and a mutex
        // held across one is a mutex held while four other machines wait.
        if matches!(said, FromServer::Stale) {
            // Deltas cannot repair a client that missed some.
            reached.client.say(FromClient::Describe).await?;
            continue;
        }

        {
            let mut picture = seen.lock().unwrap();
            let Some(Ok(host)) = picture.get_mut(&machine.name) else {
                break;
            };
            match said {
                FromServer::Environment { environment } => match host
                    .environments
                    .iter_mut()
                    .find(|e| e.id == environment.id)
                {
                    Some(existing) => *existing = environment,
                    None => host.environments.push(environment),
                },
                FromServer::EnvironmentGone { id } => host.environments.retain(|e| e.id != id),
                FromServer::Welcome { host: fresh, .. } => *host = fresh,
                // Pongs, and answers to things this client never asked.
                _ => continue,
            }
            host.environments.sort_by(|a, b| a.name.cmp(&b.name));
        }
        changed.send(()).await?;
    }
    Ok(())
}

// ------------------------------------------------------------------ machines

/// Everything `add` was given. A struct because seven positional arguments is
/// a place mistakes live.
struct Adding {
    name: String,
    ssh: Option<String>,
    here: bool,
    url: Option<String>,
    token: Option<String>,
    relay: Option<String>,
    relay_token: Option<String>,
    port: u16,
}

async fn add(adding: Adding) -> Result<()> {
    let Adding {
        name,
        ssh,
        here,
        url,
        token,
        relay,
        relay_token,
        port,
    } = adding;
    let dir = state_dir();
    let machine = if let Some(relay) = relay {
        Machine {
            name: name.clone(),
            ssh: None,
            url: None,
            token: Some(token.context("a relayed machine needs --token, the host's own")?),
            relay: Some(relay),
            relay_token: Some(relay_token.context("a relayed machine needs --relay-token")?),
            port,
        }
    } else if here {
        // The daemon on this very machine keeps its token in a file this user
        // can already read, so there is nothing to ask for.
        let path = dir.join("token");
        let token = std::fs::read_to_string(&path)
            .with_context(|| format!("no daemon here: {} does not exist", path.display()))?;
        Machine {
            name: name.clone(),
            ssh: None,
            url: Some(format!("ws://127.0.0.1:{port}")),
            token: Some(token.trim().to_string()),
            relay: None,
            relay_token: None,
            port,
        }
    } else if let Some(url) = url {
        Machine {
            name: name.clone(),
            ssh: None,
            url: Some(url),
            token: Some(token.context("a --url needs a --token")?),
            relay: None,
            relay_token: None,
            port,
        }
    } else {
        Machine {
            // The overwhelmingly common case: the name is already an alias in
            // ~/.ssh/config, so there is nothing else to type.
            ssh: Some(ssh.unwrap_or_else(|| name.clone())),
            name: name.clone(),
            url: None,
            token,
            relay: None,
            relay_token: None,
            port,
        }
    };

    // Tried before it is written. A machine in the file that has never
    // answered is a thing to debug later, and later is worse.
    println!("reaching {} ({})…", machine.name, machine.describe_route());
    let reached = machine
        .reach()
        .await
        .with_context(|| format!("could not reach {name}"))?;
    let host = reached.host.clone();
    drop(reached);

    let mut machines = Machines::open(&dir);
    machines.add(machine)?;
    println!();
    print_machine(&name, &host, None);
    Ok(())
}

// ------------------------------------------------------------- one-shot verbs

async fn ask(spot: &Spot, asking: FromClient) -> Result<()> {
    let machines = Machines::open(&state_dir());
    let machine = spot.machine(&machines)?;
    let mut reached = machine.reach().await?;

    reached.client.say(asking).await?;
    let answer = reached.client.control().await?;
    match answer {
        Some(FromServer::Environment { environment }) => {
            print_environment(&environment);
            Ok(())
        }
        Some(FromServer::EnvironmentGone { id }) => {
            println!("gone {id}");
            Ok(())
        }
        Some(FromServer::Error { message }) => bail!("{message}"),
        _ => bail!("the machine said nothing useful"),
    }
}

async fn open(path: Option<String>, argv: Vec<String>) -> Result<()> {
    let machines = Machines::open(&state_dir());
    let spot = match &path {
        Some(path) => Spot::parse(path, &machines)?,
        None => Spot::default(),
    };
    let machine = spot.machine(&machines)?;

    // Whatever it took to get here — an ssh forward, a plain url, a relay
    // introduction — is settled by `reach`, and attaching cannot tell which.
    let reached = machine.reach().await?;
    let Reached {
        client,
        host,
        tunnel,
    } = reached;
    let ending = attach::run(
        client,
        host,
        spot.environment.clone(),
        spot.session.clone(),
        argv,
    )
    .await;
    // Last: it is the thing holding the forward open, when there is one.
    drop(tunnel);
    ending
}

/// Bring an environment's ports to this machine.
///
/// The environment already publishes what it was created with to a port on its
/// own machine's loopback, chosen by the kernel so that two environments can
/// both want 3000. This is the second half of that: one ssh carrying those
/// host-side ports here, so the number in the browser is the number the dev
/// server thinks it is listening on.
async fn forward(path: String, ports: Vec<String>) -> Result<()> {
    let machines = Machines::open(&state_dir());
    let spot = Spot::parse(&path, &machines)?;
    let machine = spot.machine(&machines)?;
    let wanted = environment_of(&spot)?;

    let reached = machine.reach().await?;
    let environment = reached
        .host
        .environments
        .iter()
        .find(|e| e.name == wanted || e.id == wanted)
        .with_context(|| format!("no environment {wanted} on {}", machine.name))?
        .clone();
    drop(reached);

    let asked: Vec<Asked> = if ports.is_empty() {
        environment
            .ports
            .iter()
            .map(|p| Asked {
                here: None,
                inside: p.inside,
            })
            .collect()
    } else {
        ports
            .iter()
            .map(|p| tunnel::parse_port(p))
            .collect::<Result<_>>()?
    };
    let matched = tunnel::resolve(&environment.name, &environment.ports, &asked)?;

    let mut pairs = Vec::new();
    let mut shown = Vec::new();
    for (want, outside) in matched {
        // Their number if they asked for one, the environment's own if it is
        // free, and something rather than a refusal otherwise — the point is
        // to see the thing, and being told a port is busy is not that.
        let local = match want.here {
            Some(here) if !tunnel::port_is_free(here) => bail!("port {here} is in use here"),
            Some(here) => here,
            None if tunnel::port_is_free(want.inside) => want.inside,
            None => {
                let spare = tunnel::free_port()?;
                eprintln!("devpipe: {} is busy here, using {spare}", want.inside);
                spare
            }
        };
        pairs.push((local, outside));
        shown.push((local, want.inside));
    }

    let target = machine
        .ssh
        .as_deref()
        .map(Target::parse)
        .with_context(|| format!("{} is not reached over ssh", machine.name))?;
    let mut tunnel = target.forward_all(&pairs).await?;

    for (local, inside) in &shown {
        println!("http://localhost:{local}  →  {}:{inside}", environment.name);
    }
    println!("ctrl-c to stop");

    // Held until then: dropping it takes the forwards down. Watching ssh as
    // well, because a carrier that died looks exactly like an idle one and
    // sitting here looking busy would be a lie.
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                eprintln!("devpipe: forwarding stopped");
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if tunnel.has_gone() {
                    bail!("ssh to {} went away", machine.name);
                }
            }
        }
    }
}

async fn secret(command: SecretCommand, on: Option<String>) -> Result<()> {
    let asking = match command {
        SecretCommand::Ls => FromClient::ListSecrets,
        SecretCommand::Rm { name } => FromClient::RemoveSecret { key: name },
        SecretCommand::Set { assignment } => {
            let (key, value) = match assignment.split_once('=') {
                Some((key, value)) => (key.to_string(), value.to_string()),
                None => {
                    let value = term::read_secret(&format!("{assignment}: "))?;
                    (assignment, value)
                }
            };
            // Refused here as well as on the machine, so a name a shell cannot
            // export never becomes a round trip.
            secrets::valid_key(&key)?;
            if value.is_empty() {
                bail!("an empty value is a removal; say `devpipe secret rm {key}`");
            }
            FromClient::SetSecret { key, value }
        }
    };

    let machines = Machines::open(&state_dir());
    let spot = Spot {
        machine: on,
        ..Spot::default()
    };
    let machine = spot.machine(&machines)?;
    let mut reached = machine.reach().await?;
    reached.client.say(asking).await?;
    let answer = reached.client.control().await?;
    match answer {
        Some(FromServer::Secrets { names }) => {
            if names.is_empty() {
                println!("{} lends its environments nothing yet", machine.name);
            }
            for name in names {
                println!("{name}");
            }
            Ok(())
        }
        Some(FromServer::Error { message }) => bail!("{message}"),
        _ => bail!("the machine said nothing useful"),
    }
}

// --------------------------------------------------------------------- relay

async fn relaying(command: RelayCommand, dir: Option<PathBuf>) -> Result<()> {
    let dir = dir.unwrap_or_else(state_dir);
    let mut keys = devpipe::keys::Keys::open(&dir);

    match command {
        RelayCommand::Grant { account, can, note } => {
            let token = keys.grant(&account, can, &note)?;
            // On its own line and nowhere else. This is the only time it
            // exists outside whoever is about to paste it somewhere.
            println!("{token}");
            eprintln!("devpipe: granted to {account} for {}", can.as_str());
            Ok(())
        }
        RelayCommand::Revoke { prefix } => {
            match keys.revoke(&prefix)? {
                0 => bail!("no key starts with {prefix}"),
                1 => eprintln!("devpipe: revoked"),
                n => eprintln!("devpipe: revoked {n} keys"),
            }
            Ok(())
        }
        RelayCommand::Keys => {
            if keys.is_empty() {
                println!("no keys yet · devpipe relay grant --account <name> --can enrol");
                return Ok(());
            }
            println!("{:<14} {:<16} {:<7} NOTE", "KEY", "ACCOUNT", "CAN");
            for key in keys.all() {
                println!(
                    "{:<14} {:<16} {:<7} {}",
                    key.short(),
                    key.account,
                    key.can.as_str(),
                    key.note
                );
            }
            Ok(())
        }
        RelayCommand::Serve { bind } => {
            if keys.is_empty() {
                // Rather than starting something nothing can talk to and
                // leaving the reason to be discovered from a refused socket.
                bail!(
                    "no keys yet, so nothing could enrol or connect: \
                     `devpipe relay grant --account <name> --can enrol`"
                );
            }
            let listener = TcpListener::bind(&bind).await?;
            eprintln!("devpipe: relay on ws://{}", listener.local_addr()?);
            eprintln!("devpipe: {} key(s) · {}", keys.all().len(), dir.display());
            devpipe::relay::run(listener, devpipe::relay::Relay::new(keys)).await
        }
    }
}

// -------------------------------------------------------------------- daemon

struct Serving {
    bind: String,
    token: Option<String>,
    backend: String,
    image: Option<String>,
    memory: Option<String>,
    dir: Option<PathBuf>,
    relay: Option<String>,
    relay_token: Option<String>,
    relay_name: Option<String>,
}

async fn daemon(serving: Serving) -> Result<()> {
    let Serving {
        bind,
        token,
        backend,
        image,
        memory,
        dir,
        relay,
        relay_token,
        relay_name,
    } = serving;
    let backend: Arc<dyn Backend> = match backend.as_str() {
        "local" => Arc::new(Local),
        "docker" | "podman" => Arc::new(Docker::new(backend)),
        other => bail!("unknown backend {other}"),
    };
    let dir = dir.unwrap_or_else(state_dir);
    let host = Host::open(&dir, backend.clone(), token, image, memory, None).await?;

    let listener = TcpListener::bind(&bind).await?;
    let addr = listener.local_addr()?;
    eprintln!(
        "devpipe: host {} · {} backend · {} environment(s) · {}",
        host.id,
        backend.kind(),
        host.all().len(),
        dir.display()
    );
    eprintln!("devpipe: images from {}", host.image());
    eprintln!("devpipe: listening on ws://{addr}");
    // Not the token itself. It is in a file the owner can read, and a daemon
    // that prints it puts it in every journal that scrapes the unit's output.
    eprintln!("devpipe: token in {}", dir.join("token").display());

    // Alongside the listener, never instead of it. A host that can be reached
    // directly should still be, because that path has nothing in the middle.
    if let Some(relay) = relay {
        let token = relay_token.context("--relay needs --relay-token")?;
        let name = relay_name.unwrap_or_else(|| host.describe_name());
        eprintln!("devpipe: enrolling at {relay} as {name}");
        let enrolling = host.clone();
        tokio::spawn(async move {
            let _ = devpipe::relay::dial_out(relay, token, name, enrolling).await;
        });
    }

    serve::run(listener, host).await
}
