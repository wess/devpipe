# Spike results

Four questions, asked in order of how badly a wrong answer would have hurt.
All four are answered. Numbers below are from the iPad Pro 11-inch (M4)
**simulator**, not a device — treat them as indicative, and re-measure on
hardware before trusting them.

## Spike 0 — does sinclair's VT run and render on iOS?

Yes, with no changes to `vt` at all. It cross-compiles to `aarch64-apple-ios`
and `aarch64-apple-ios-sim` as-is; its only dependencies are pure Rust.

`core/` is a C ABI over it. Swift never touches a `Cell`: it calls `feed`,
then reads a packed `[DpCell]` for the whole visible screen in one go. Ten
thousand per-cell FFI calls a frame would have cost more than the emulation.

Renderer is CoreText, with rows cached as built `CTLine`s and invalidated only
where the core reports damage, and cells coalesced into runs of shared
attributes.

| case | grid | fps | build | draw |
|---|---|---|---|---|
| vim, syntax highlighted | 92×67 | 60 | 0.61ms | 0.62ms |
| `top`, looping full-screen redraws | 92×67 | 60 | 1.9ms | 2.0ms |
| every cell a new colour, every frame | 92×67 | **20** | 20.3ms | 30.1ms |

Emulation throughput peaked at 162MB/s and was never the bottleneck.

The last row is the ceiling worth knowing about. It is not a realistic TUI —
it forces 6,164 separate text runs per frame, and CoreText cannot build that
many `CTLine`s in a frame budget. Real programs land in the first two rows. If
something does hit it (a `cat` of a heavily colourised log), the fix is a glyph
atlas on the GPU, which is what sinclair itself already does.

**Not covered:** device measurements, and 120Hz. The simulator caps at 60.

## Spike 1 — a headless daemon over a websocket

`daemon/` is a new crate over sinclair's `pty` and `vt`. Neither needed
changing. Sessions are created over REST and attached over a websocket.

The wire format is deliberately dumb: binary frames are raw pty bytes both
ways, text frames are JSON control messages. The client runs its own emulator,
so the server has no business interpreting the stream.

Reconnect does **not** replay a ring of raw bytes. A ring truncates
mid-escape-sequence and poisons the client's parser, and it has to be large
enough to contain a full-screen repaint that may have happened long ago.
Instead the daemon runs its own `vt::Terminal` over the same output and emits
ANSI that reconstructs the screen it currently holds — bounded by screen size
rather than history, and never truncating a sequence. Six round-trip tests
cover text, colour, attributes, cursor position, alt screen, and wide
characters.

**Known gap:** reattach restores the visible screen but not scrollback. The
protocol can carry it later.

## Spike 2 — the iPad drives a real session

Working end to end: session list on the left with live status, terminal on the
right, resize propagated to the pty, and the child's own title used as the
session label. Claude Code's TUI renders correctly — header, inverse-video
section bars, box-drawn input frame.

Keyboard is three separate paths, all of which had to work: `UIKeyInput` for
the software keyboard, `pressesBegan` for hardware, and an accessory row for
the keys iOS simply does not offer. The accessory row is ordered for agent
CLIs — esc, ctrl, tab, shift-tab, arrows — rather than the generic sysadmin
layout. Ctrl latches rather than requiring a hold, because a modifier you have
to hold is unusable on a touchscreen.

Verified through the app: typing, Enter, up-arrow history recall, and Ctrl+C
interrupting a running command.

**`/login` is answered** — see below. It needed a throwaway box to test
safely, which is what the droplet gave us.

**Also not covered:** UIKit actually delivering key events. The tests drive
`insertText` and `send(_:)` — the same entry points the keyboard calls — but
the delivery itself needs a real keyboard on a real device.

## Spike 3 — reconnect with the session intact

Holds. A session printing once a second was attached, the app was killed, and
twelve seconds later it was relaunched: the counter had advanced unbroken
through the disconnect, and every tick produced while nothing was attached was
on screen. Covered by tests at the daemon level too
(`session_survives_a_detach`, `output_while_detached_is_not_lost`).

---

# The bug worth remembering

**Ctrl+C did nothing, and every layer you would think to check looked correct.**

The byte arrived (traced at the pty write). `stty -a` reported `isig` and
`intr = ^C`. The foreground process group was right — `TPGID` matched the
sleeping child's pgid. The signal mask was empty. `trap -p SIGINT` in the shell
showed nothing. The kernel really did raise SIGINT.

The foreground job ignored it.

Signal *dispositions* survive both fork and exec. A non-interactive shell that
starts a background job sets SIGINT and SIGQUIT to `SIG_IGN` in the child —
which is how a daemon actually gets launched — and bash faithfully restores
that inherited ignore for every command it runs. So the disposition is invisible
from inside the shell (`trap -p` shows the shell's own table, not what children
inherit) and only shows up if you ask a child process directly:

```
python3 -c "import signal; print(signal.getsignal(signal.SIGINT))"
# 1  == SIG_IGN
```

Two things nearly hid this permanently:

1. **The first regression test passed vacuously.** It asserted that
   `back-at-the-prompt` appeared after Ctrl+C — but the shell *echoes* typed
   input whether or not it ever runs the command. Every marker in these tests
   is now computed (`echo $((6*7))` → `42`) so it cannot be confused with an
   echo.

2. **It only reproduced in the shipped binary.** Under `cargo test` the process
   runs in the foreground with default dispositions and it passes. The same
   test binary, run detached, fails. That is why `src/bin/probe.rs` exists.

Fixed in `devpiped::restore_default_signal_dispositions`, with
`tests/signal_inheritance.rs` reproducing the broken state and proving the fix.

**This belongs upstream in sinclair.** The real fix is in the child between
fork and exec — `pty`'s `pre_exec` in `crates/pty/src/unix.rs`, which already
does `setsid` + `ioctl_tiocsctty` + `dup2` and should also reset every signal
disposition to `SIG_DFL` and clear the inherited signal mask. Doing it there
would cover the mask too, which the parent-side workaround cannot, and would
fix any headless embedder of the crate — sinclair's own container and
agent-team paths included. The workaround here deliberately leaves SIGPIPE,
SIGHUP, SIGTERM and SIGCHLD alone.

---

# Linux and TLS

Both done, after the spikes.

**Linux.** The daemon builds and passes its whole suite on Linux, x86_64 and
aarch64, with no changes — including the pty and signal tests, which are the
ones that could plausibly have differed (`read()` returns `EIO` rather than `0`
at hangup, and `TIOCSCTTY` is not identical). Verified in a container rather
than by cross-compiling: a cross-compile proves a binary links and nothing
about whether it runs, which for a bug like the signal-inheritance one is no
proof at all.

**TLS**, terminated in the daemon, with the certificate pinned by the client —
see the README for why it is self-signed rather than CA-issued. Verified end to
end: the correct fingerprint attaches, a wrong one is refused and the
connection cancelled rather than falling back to system trust. ATS needs no
exception, since the daemon offers TLS 1.3 with forward secrecy and only the
chain is unusual.

Certificates persist across restarts. That is load-bearing: regenerating on
each start would change the fingerprint, and a routine restart would look to
every pinned client exactly like an attack.

# On a real box

Deployed to a DigitalOcean droplet (Debian 13, 2GB, nyc3) with
`deploy/deploy.sh`: cross-built in a container, shipped over ssh, run under
systemd. Claude Code installs and runs there unmodified.

## `/login` works headless, and the browser argument was wrong

I argued earlier that Claude Code's OAuth would want a `localhost` callback,
that `localhost` on the VPS is not `localhost` on the iPad, and that this was
the strongest reason to run a browser on the VPS. That was wrong, and it is
worth being precise about why, because it changes what the app has to build.

The flow redirects to `https://platform.claude.com/oauth/code/callback` — a
hosted HTTPS endpoint, with PKCE — and then prints:

```
Browser didn't open? Use the url below to sign in (c to copy)
https://claude.com/cai/oauth/authorize?...&code_challenge_method=S256&...
Paste code here if prompted >
```

No callback ever has to reach the box. The user opens that URL on any device,
authenticates, and pastes a code back into the terminal. Claude Code even
offers `c` to copy it.

So the client needs two ordinary things, not a browser stack:

- make a URL in terminal output tappable, and open it
- get the code back into the session, which is just paste

The VPS-side browser may still earn its place for what an *agent* does — a dev
server on `localhost:3000`, a page it needs to read — but it is not on the
critical path for authentication, and BYO-subscription does not depend on it.

## ATS makes the pinning design unworkable on its own

The self-signed-and-pin design in the section above does not survive iOS. ATS
evaluates system trust *before* the URLSession delegate is consulted and
cancels the connection when it fails:

```
Trust evaluate failure: [leaf AnchorTrusted]
ATS failed system trust
Connection 1: system TLS Trust evaluation failed(-9802)
```

The delegate never gets to say "this is the key I expected". The normal remedy
is a per-domain ATS exception, which cannot work here: droplet addresses are
not known when the app is built, so there is no list to write into
`Info.plist`.

The remedy is a DNS name per box under a domain we control and a CA-issued
certificate, which satisfies ATS natively. Pinning then goes back on top as a
second check rather than the only one — pinning a CA-issued certificate is
fine, because system trust passes first.

Until that exists the app carries `NSAllowsArbitraryLoads`, marked SPIKE ONLY
in `Info.plist`, and `PinnedTrust` is the only thing between it and any
certificate at all. That is not a shippable state.

# The onboarding path

Built after the spikes, once `/login` turned out to be a URL and a code.

**Tapping a URL.** `vt` already had `link_at`, which covers OSC 8 hyperlinks
*and* URLs merely printed as text — the latter being what an OAuth prompt
actually emits. Exposed through the FFI as `dp_term_link_at`. A tap opens the
link in an `SFSafariViewController` sheet; holding underlines the exact span
that would open, because a tap target nobody can see is a tap target nobody
tries. Only `http` and `https` are opened: a terminal will happily print
`javascript:` or `file://`, and neither should be handed to the system from a
tap on remote output.

**Pasting the code back.** A `paste` key on the accessory row, bracketed so a
shell treats it as pasted rather than typed. The OAuth step ends by asking for
a code that is, by construction, already on the clipboard.

**Reconnecting.** Not a nicety on iOS: the system suspends a backgrounded app
and the socket dies with it, so every trip to another app ends the connection.
Without this the persistence the daemon provides is invisible — the session
really is still running, but the only way to see it again is to force-quit and
relaunch.

Reconnection is driven by three things rather than a timer alone: returning to
the foreground, the network path becoming satisfiable again, and an exponential
backoff capped at fifteen seconds with jitter so a daemon restart is not met by
every client retrying in lockstep. A generation counter discards callbacks from
a socket that has already been replaced, which would otherwise queue a second
reconnect and race the first. `stop()` sets a flag that suppresses all of it,
so switching sessions does not look like a network failure. The pty size is
re-asserted on every attach, or a reconnected session keeps whatever size it
was created with.

Verified by backgrounding the app for fourteen seconds against a session
printing once a second: it reattached on its own and the counter had run
straight through.

**Not verified:** the tap through to a real browser and back. That needs a
device and a human finger.

# What the first real provisioning runs found

Every piece had unit tests and none of it had run as a chain. Five boxes later:

- **A version probe that never returns.** The script asked `devpiped --version`
  to report what it had installed. `devpiped` ignored argv and started serving,
  so the command substitution never came back and setup hung there forever with
  no error. `devpiped` now answers `--version`, and the script no longer asks.
- **The agent CLI installed for the wrong user.** cloud-init runs as root, so
  `claude` landed in `/root/.local/bin` — off the PATH of the `devpipe` user who
  actually gets the terminal. Worse, `/login` would have written credentials
  into root's home where the user could never read them. Tools that keep state
  in `$HOME` now install as the user who will run them.
- **Every phase header arrived twice.** The background shipper and the
  per-phase flush both read the cursor with no lock, so they sent overlapping
  ranges.
- **The reported phase was always "boot".** The shipper forks before the first
  phase is set, so its copy of the variable never changed. The phase lives in a
  file now.
- **Non-ASCII in the script came out mangled.** Box-drawing characters arrived
  double-encoded regardless of the box's locale, because the script reaches the
  machine through cloud-init's user_data. Notably, UTF-8 in *tool output* is
  fine — Claude's own installer prints a tick that renders correctly. The
  script now uses ASCII markers.
- **Boxes were unreachable.** No SSH key was passed, so the box that wedged
  could not be inspected at all. Keys are now configurable in admin.

A box goes from nothing to a working terminal in about two minutes.

# Open issues before this is more than a spike

- **Path dependencies.** `core/` and `daemon/` both reference
  `../../sinclair/crates/*` by path, so Devpipe does not build without
  sinclair checked out beside it. Submodule or published crates.
- **Auth is one shared bearer token**, and the query-parameter form puts it in
  URLs. Fine for a spike, not for accounts.
- **Scrollback is not restored on reattach** (see Spike 1).
- **Sessions die with the daemon.** They survive a client disconnecting, which
  is the product promise, but not a daemon restart or upgrade — the ptys are
  its children. Fixing that means moving them out of the process.
- **Everything runs as root** on the box.
- **The worst-case render ceiling** (see Spike 0).


## Firecracker microVMs — evaluated, not adopted

Measured on a DigitalOcean `s-2vcpu-4gb` in nyc3, Firecracker v1.16.1, 2026-08-12,
then removed. Kept only so nobody pays to learn it twice:

- Nested virtualisation **works** on stock droplets — `/dev/kvm` is present.
- Cold boot to guest kernel ~240ms; **restore from snapshot ~22ms**.
- The snapshot memory file is exactly guest RAM and is not sparse.

It was dropped for one reason: a microVM host bills 24/7 whether anyone signs up
or not, and a slept droplet bills nothing. $48/mo buys ~5,400 box-hours, so
packing only wins past roughly **180 box-hours of free usage a day** — about a
hundred daily-active free users. Below that it costs more than the idle-reclaim
that already exists, for weeks of extra infrastructure.

Worth revisiting at that volume, or if wake latency becomes the complaint.
