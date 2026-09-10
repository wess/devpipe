# Devpipe

Coding agents want a real computer — a filesystem that persists, ports they can
listen on, a toolchain, and the freedom to break things. Giving each one your
laptop does not work, and giving each one a VPS costs three minutes and a
volume to reconcile. Devpipe puts many of them on one machine you already have,
and lets you attach to any of them from anywhere.

It is arranged as a tree:

```
machine            a box you can ssh into, running one daemon
  environment      a workspace, its own ports, its own processes
    session        a harness, a dev server, a shell
```

Everything is addressed by path — `box-a/api`, `box-a/api/3f2a1b` — so what you
read off the tree is what you type back. There is no id to remember.

Sessions belong to their environment, not to the connection and not to the
daemon. Closing a laptop costs nothing, and so does upgrading Devpipe
underneath a running session.

## Put it on a box

Any Linux machine you can ssh into, with systemd and either docker or podman.
It does not need a public port, or a domain, or a certificate. A $12 VPS is
enough to start; the base image wants about 3GB of disk before anything of
yours is on it.

```sh
ssh box 'curl -fsSL https://raw.githubusercontent.com/wess/devpipe/main/deploy/provision.sh | sh'
```

That installs a container runtime if there is none, installs `devpipe`, and
starts it as a user service bound to `127.0.0.1:7455`. Nothing listens on a
public interface: the daemon speaks plaintext websocket on loopback, and the
only thing reaching it from outside is ssh.

On your laptop, the same installer without the service:

```sh
curl -fsSL https://raw.githubusercontent.com/wess/devpipe/main/deploy/install.sh | sh
```

## Use it

Installed as both `devpipe` and `dp` — the same binary, `dp` a symlink to it.

```sh
dp add box-a                   # the name is its ssh alias
dp add box-b
dp                             # the tree: every machine, everything on it

dp new box-a/api --repo git@github.com:you/api.git --port 3000
dp attach box-a/api            # ctrl-] to detach; the session stays
dp tree --watch                # stays open, redraws when anything changes
```

`dp add` opens the ssh forward, reads the machine's token off the far
side, checks it answers, and only then writes it down. There is no certificate
to arrange and no token to paste around. With one machine registered you can
drop the prefix: `dp attach api`.

Two environments can both want port 3000 — each gets a private network
namespace and a host port of the kernel's choosing, which the tree prints.

Give an environment a ceiling with `--memory`, and give a whole machine a
default with `devpipe serve --memory 2g`. On a small box this is not optional:
an agent running an unbounded build will otherwise have the kernel pick a
victim, and on a machine where the daemon *is* the product, the victim is
often the daemon. Every environment also gets a 4096-process limit whether you
ask or not.

A dev server inside an environment reaches your browser with `dp forward`:

```sh
dp forward box-a/api            # every port it publishes
dp forward box-a/api 3000       # just this one
dp forward box-a/api 8080:3000  # 3000 in there, 8080 here
```

The number you type is the one the server inside thinks it is listening on;
what the kernel picked on the machine is nobody's business. Runs until ctrl-c,
and says so if ssh goes away underneath it.

`dp tree --watch` is live rather than polled: the daemon announces every
change to whoever asked to watch, including sessions that end while nothing is
attached to them. A machine that goes down becomes a line in the tree and comes
back on its own.

The machine list is `~/.devpipe/machines.toml`, short enough to edit by hand:

```toml
[[machine]]
name = "box-a"
ssh = "wess@box-a"
```

## Secrets

Set once on the host, lent to every environment at the moment a session starts.
A key rotated this morning reaches a container created last week; nothing is
rebuilt and nothing is typed into a shell.

```sh
dp secret set ANTHROPIC_API_KEY --on box-a   # prompts, without echo
dp secret ls --on box-a                      # names, never values
```

`--on` is optional when you have one machine.

They live in `~/.devpipe/env` on the host, mode 0600, and are never read back
out over the socket.

## Signing an agent in

An environment has no browser and no display, and the person who would look at
one is on a laptop the container cannot name. Measured against Claude Code
2.1.267 and Codex, on 2026-09-10:

| | What it does | What to do |
|---|---|---|
| **Claude Code** | Prints the URL, then waits at `Paste code here if prompted >`. Its callback is hosted at `platform.claude.com`, not localhost. | Open the URL, approve, paste the code back into the pane. Nothing else needed. |
| **Codex** | Prints the URL, but its callback is `http://localhost:1455` — a localhost on your laptop, where nothing is listening. | `codex login --device-auth`. Codex says so itself when the flow starts. |
| **Anything else** | Usually shells out to `xdg-open` / `$BROWSER`. | Handled: see below. |

Neither of the first two shells out to a browser at all, so the shim below is
not what makes them work — a printed URL and a paste is. What makes *that* work
is that every session is a real pty, so the URL is selectable text.

For everything that does try to open a browser, `xdg-open`, `open`, `$BROWSER`
and friends in the base image are `deploy/docker/devpipe-open`, which emits an
OSC that reaches the attached client as a typed `Open` event rather than
failing silently. `dp attach` prints it; a graphical client should draw a
button — and should never follow it on its own, because anything in the
environment can emit that sequence. Only `http` and `https` survive the daemon.

Every session also gets `DEVPIPE=1`, `DEVPIPE_ENVIRONMENT` and
`DEVPIPE_SESSION`, so a tool or a shell rc can tell it is on a remote machine
and pick the flow that works there.

The blunt alternative, and often the right one: `dp secret set ANTHROPIC_API_KEY`,
or `claude setup-token` once and set the result as a secret. Then no agent ever
has to log in again.

## What an environment is made of

`ghcr.io/wess/devpipe-base:trixie` — Debian with Rust, Node, Bun, Python, git,
the usual build tooling, and Claude Code already on it. About 2.5GB, pulled
once per host. `deploy/docker/base.Dockerfile` builds it; `devpipe serve
--image` points a machine at something else, and `dp new --image` at something
else for one environment.

Nothing about Devpipe requires that image. Any image with a shell works, and an
image that sets `DEVPIPE_SHELL` gets that shell instead of `/bin/sh`.

## Machines a browser can reach

ssh is the default and the better path: nothing sits in the middle, and
devpipe.com could disappear without a session dropping. A browser cannot open
one, so a host that wants to be reachable from the web dials **out** instead:

```sh
# somewhere public
devpipe relay grant --account wess --can enrol --note "box-a"
devpipe relay grant --account wess --can reach --note "laptop"
devpipe relay serve --bind 0.0.0.0:7456

# on the machine, alongside its own listener rather than instead of it
devpipe serve --relay wss://relay.example.com --relay-token <enrol key> --relay-name box-a

# from anywhere
dp add box-a --relay wss://relay.example.com --relay-token <reach key> --token <the host's>
```

Behind the app, the relay mints those keys from a sign-in instead
(`devpipe relay serve --sessions http://127.0.0.1:3000/api/auth/me`). The
browser's session cookie is `HttpOnly` — the page cannot read it or forward it
— but it rides the websocket upgrade, so the relay reads it there and asks the
app whose it is. Nothing sensitive passes through JavaScript, and the relay
never sees a password.

A key is shown once, because the relay keeps only what it hashes to. Asking
again replaces it, and the one it replaces stops working.

Keys belong to an account, and machines are scoped to it — two people can both
have a `box-a` and neither can reach the other's by knowing what it is called.
Asking for somebody else's gets the same sentence as asking for one that does
not exist, because anything else answers "does this person have a box called
that" for whoever asks.

A machine's key and a person's key are separate, because they are stolen
differently: an enrolment key sits on a box forever, and a box that is taken
should not become a way into every other box its owner has.

`devpipe relay keys` lists what has been granted and `revoke` takes one back by
the prefix it shows. The keys themselves are stored as hashes: a machine's
token file is that machine's own secret, but a relay's file is everybody's, so
a copy of it is not enough to use.

The relay introduces a client to a machine and then copies bytes. It does not
parse them and must not learn how — after the introduction the two ends speak
the same protocol they always did, so adding a pane kind never touches it.
Presence is the connection itself: no heartbeat, no timeout to tune, and a
machine that drops stops being offered the moment it does.

**Using the relay means trusting the relay, and ssh mode does not.** TLS
terminates there, so a tampered-with relay can read the host token going past.
That is the honest cost of the only design a browser can take part in, which is
why this is a second path and not a replacement. Ending it properly means the
client and the daemon doing their own handshake inside the tunnel.

## Sessions

Each session is a *keeper*: a detached process holding the pty behind a unix
socket in the runtime directory. `devpipe serve` relays between the websocket
and that socket and holds nothing a restart can lose, so an upgrade, a crash,
or `Restart=always` doing its job leaves the work running. A reattaching client
gets the current screen replayed from a mirror the keeper maintains, not a ring
of raw bytes — a byte ring starts mid-escape and the client's parser eats the
text after it as parameters.

One line of `deploy/devpipe.service` is what makes that true: `KillMode=process`.
systemd's default signals every process in the unit's cgroup, keepers included,
which turns a restart into exactly the thing keepers exist to prevent. sshd
does the same for the same reason.

What does not survive: a reboot, and stopping the environment. A pty into a
container that is not running is a pty into nothing, whoever is holding it.

## Bridge mode

`devpipe serve --backend local` makes one environment that *is* the machine —
no container, no isolation, the user's own files and shell. It is for a box
somebody already owns and works on. It holds exactly one environment, because
nothing would separate a second one from the first.

## What is not here yet

Devpipe is 0.1. The daemon, the CLI and the tree are real and tested; the
things below are known gaps rather than surprises.

- **Files move by git.** There is no `dp cp`, and no file pane.
- **A port has to be declared when the environment is made.** `--port 3000` at
  `dp new` time; a container's published ports cannot change afterwards.
- **A workspace is the only copy of itself.** If the machine dies, so does
  anything not pushed.
- **One client at a time, really.** A second attach to the same session works
  but the two fight over the terminal size; there is no follower mode.
- **No web or desktop client.** The pane protocol was built for them, the relay
  gives them a way in, and `dp` is the reference implementation — but neither
  client exists yet.
- **Account names come from whatever the app calls people.** The relay asks
  `/auth/me` and uses the username it gets back; there is no user table here.

## Building it

```sh
cargo test          # container tests skip when no runtime answers
cargo run -- serve --backend local
```

`DEVPIPE_TEST_IMAGE` picks the image the container tests run against.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
