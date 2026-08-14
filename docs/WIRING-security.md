# Wiring, and what each part is trusting

Referenced from `src/security/ratelimit.ts`, which needs somewhere to say what
has to be true outside this repo for the rate limiter to mean anything.

Everything here is a property of how the processes are wired together rather
than of any one of them. Each is the kind that fails silently: nothing throws,
nothing logs, the feature just quietly stops doing its job.

## The control plane

Two processes on one host, behind Caddy.

```
     :443  Caddy ── /dist/*  ─→ file_server (/var/www/devpipe)
                 └─ everything ─→ 127.0.0.1:3001  devpipe-web
                                        └─ /api/* ─→ 127.0.0.1:3000  devpipe-api
```

Both bind loopback, set in `site/deploy.sh` as `HOST=127.0.0.1` and
`WEB_HOST=127.0.0.1`. **This is load bearing and not an optimisation.**

`clientIp` in `src/security/ratelimit.ts` reads the *right-most* entry of
`x-forwarded-for`, because Caddy appends the peer it actually saw and everything
to the left of that is whatever the client felt like sending. That reasoning
only holds while Caddy is the sole route in. A caller that can reach :3000
directly writes the whole header itself, gets a fresh bucket for every value it
invents, and is not rate limited at all — on sign-in, registration, password
reset, and username claiming. Nothing in the API can distinguish that from a
real proxy hop.

So: if either process is ever bound to a public interface, close the port at the
firewall. There is no firewall in `deploy/` today; loopback binding is the whole
of the control.

The defaults in the source are `0.0.0.0` for both, for local development. A
deploy that does not go through `site/deploy.sh` inherits those defaults and is
wide open.

## The boxes

Each box is a droplet with its own subdomain and its own certificate.

```
     :443  Caddy (on the box) ─→ 127.0.0.1:7788  devpiped
```

`DEVPIPE_ADDR=127.0.0.1:7788` is set in `/etc/devpipe/env` by `cloudinit.ts`.
The daemon's own default is `0.0.0.0:7788` — it is a library that the
integration tests bind themselves — so this override is the only thing keeping
the pty daemon off the public interface. `DEVPIPE_INSECURE=1` goes with it and
is correct *because* of it: the daemon speaks plain HTTP to Caddy over loopback,
and Caddy terminates TLS.

The certificate is real, from Let's Encrypt over HTTP-01. That is not cosmetic:
iOS App Transport Security evaluates system trust *before* an app's pinning code
is consulted, so a self-signed certificate can never be rescued by pinning. See
[spikes.md](spikes.md).

Authentication to a box is `agent_token`, generated per box in
`src/boxes/index.ts` and known only to that box and the control plane. It
reaches exactly one machine, belongs to the person who owns it, and is useless
anywhere else — but it is long-lived, and the browser gets it from
`/boxes/:id/connection`. Two consequences:

- The web client keeps it in memory, never in `localStorage`.
- It travels in the websocket query string, because a browser cannot set headers
  on a handshake, so it lands in that box's access log. That is why it is the
  box's credential and not the account's.

### What is reachable on a box

A DigitalOcean firewall named `devpipe-boxes`, attached by the `devpipe` tag, is
converged on every provision by `ensureBoxFirewall` in
`src/boxes/digitalocean.ts`. Inbound: **80 and 443 from anywhere, 22 from the
control plane only**. Outbound: unrestricted.

Port 22 is not open to the internet, and closing it costs no customer anything:
the authorised keys on a box come from `boxes_ssh_key_ids`, an instance-wide
setting, so the only party who can log in is the operator. Open to everyone it
was the worst of both — every scanner on the internet knocking on a port useful
to one person.

It also removes `ssh -D`, which is the zero-effort way to turn a box into a
SOCKS proxy: no install, no root, works from any laptop. Everything else about
proxying a box takes deliberate effort; that took none.

The allowed address is derived, not written down — the droplets tagged `devpipe`
and not `devpipe-box`, which is the control plane. A hardcoded address is right
until the host is rebuilt and then wrong silently: the firewall would go on
converging and it would be found out the next time a box wedged.
`boxes_ssh_sources` adds to that list, for reaching a wedged box from a home or
office address without hopping through the API host first.

When the address cannot be resolved at all, 22 falls back to open rather than
closed. An empty source list is not a stricter firewall, it is a locked room
with the key inside.

### Reaching a box from your own machine

Not over SSH, and that is the intended answer rather than a consolation.

`dpctl` (`daemon/src/bin/dpctl.rs`) signs in to the control plane once, keeps
the session token in the system keychain, and attaches a local terminal to a box
over the same authenticated WSS on 443 the web and iOS clients use:

    dpctl login
    dpctl connect mybox

There is nothing to configure — no key, no `known_hosts`, no flags — because the
box already has a hostname under `devpipe.com` and a Let's Encrypt certificate
for it. SSH would be worse here even if port 22 were open: **waking a box builds
a new droplet**, so its host key changes on every wake and anybody using SSH
meets `REMOTE HOST IDENTIFICATION HAS CHANGED` every time they come back.

Two properties worth keeping:

- The stored credential is `{server, token}` together, not a bare token. They
  are one credential — a token minted by a self-hosted instance is worthless at
  devpipe.com, and sending it there would hand a third party a working session.
- `dpctl` sets a `User-Agent` of `dpctl/<version> (<hostname>)`, which is what
  `startSession` records. A laptop therefore appears by name under Settings →
  Devices and can be signed out from there, so the revocation story is the one
  that already existed rather than a new one.

A box that is asleep is woken and waited for, and `connect` reattaches to a live
session of the same shape rather than starting a new shell — the work outliving
the connection is the product, and an `ssh`-shaped client that opened a fresh
shell every time would throw it away.

Still to build on this channel: port forwarding (`ssh -L`'s replacement) and
file transfer. Both ride the same socket and need no new inbound port.

If customer SSH is ever offered anyway, it wants `DisableForwarding yes` in
`sshd_config` — one directive that kills `-D`, `-L`, `-R`, agent and X11
forwarding while leaving shells and file copies alone.

It is enforced by DigitalOcean rather than by the box, and that is the whole
point of it. The box's user has `NOPASSWD:ALL` sudo — deliberately, it is their
machine — and an agent on it runs whatever it decides to run. A firewall the box
administers is a firewall the box can switch off, and Docker writes iptables
rules that bypass `ufw` outright, so on the one tool most likely to publish a
port a host firewall is not a control at all.

Outbound is open except TCP 25, 465 and 587. Mail is the one egress worth
closing: a box that relays spam gets the complaint sent to the provider account
every customer's box is created under, and the provider's remedy is to lock that
account — so one bad customer costs everyone their machine. Nothing in this
product speaks SMTP from a box, so it costs no legitimate use.

Peer-to-peer clients are pinned out of the archive
(`/etc/apt/preferences.d/devpipe-p2p`, `Pin-Priority: -1`), so transmission,
deluge, rtorrent, qbittorrent, amule and aria2 have no installation candidate.

That is friction and not a boundary, and the difference matters: the account has
`NOPASSWD:ALL` sudo by design and can delete the pin, and `curl | bash`, a static
binary, a container, or the same clients from npm and pip all route around it. It
stops nobody determined.

It earns its place anyway because the person it stops is not determined. The
realistic case is a customer reaching for the first thing that comes to mind, and
a box that answers "no" usually ends it. What that prevents is a DMCA notice
arriving at the provider account every customer's box is created under — where
the remedy is to lock the account and one person's torrenting costs everyone
their machine. The same reasoning as the mail block, one layer up.

What bounds it is egress volume, which `src/security/egress.ts` reads hourly from
the provider's own metrics — no opinion about what ran on the box, which matters,
because inspecting a customer's terminal is not something this product does.
Three signals, and a box trips at most one per sweep:

| Reason | Test | Catches |
| --- | --- | --- |
| `burst` | out over `boxes_egress_limit_gb` in an hour (200GB) | a seedbox, a mirror, somebody's backup target |
| `sustained` | out over `boxes_egress_daily_gb` in a day (500GB) | the same thing run patiently |
| `relay` | ≥100GB moved, and in within a third of out, over a day | a proxy, under both limits |

The hourly figure alone bounds rate and says nothing about patience: 60Mbps is a
seventh of the hourly line, never trips it, and is 648GB a day. The daily limit
is deliberately not the hourly one times 24 — that would be 4.8TB and catch
nothing.

The relay test is the only one that fires on a box under both limits. A proxy
forwards what it receives, so its two directions are nearly equal, while a box
doing work is lopsided: builds pull far more than they push, a seedbox pushes far
more than it pulls. The 100GB floor is what stops every idle machine qualifying —
50GB each way over a day is perfectly symmetric and perfectly boring. The ratio
says what the traffic is; the floor says whether there is enough of it to care.

Each is written to the audit trail as `box.egress_<reason>` and warned about.

It deliberately does not suspend. A busy build, a large dataset, a registry push
and a seedbox look alike for an hour, and locking a paying customer out of their
machine on an hour of traffic is a worse failure than the one it prevents. What
it buys is that when a complaint arrives naming an address and a time, the
account is already written down.

What the firewall closes: `docker run -p 5432:5432`, a dev server on
`0.0.0.0:3000`, `python -m http.server`. None of those are decisions to publish a service on the
public internet, and before the firewall all of them did. The catalogue's
postgres and redis happen to bind loopback under Debian's defaults, but that is
their default and not a property of the box.

7788 is deliberately not in the list. `DEVPIPE_INSECURE=1` is plain HTTP, which
is correct over loopback and would be a plaintext service anywhere else.

`tests/boxes.test.ts` fails if a port is added to the inbound set, and if an
existing firewall is left as found rather than converged — a rule opened by hand
during an afternoon's debugging and never removed is how this protection
realistically disappears.

The same token authenticates the box's own callbacks to
`/boxes/callback` and `/boxes/callback/log`, compared against the stored value
for the hostname the callback names.

## The browser

The session token is in `localStorage`, which makes any injected script an
account takeover rather than a defacement. The mitigation is that there is
nowhere to inject from:

- `script-src 'self' 'wasm-unsafe-eval'` — **no `'unsafe-inline'`**. This is why
  the lander's behaviour lives in `site/lander.js` instead of a `<script>`
  block, and why moving it back inline would quietly undo the protection for the
  whole origin.
- The policy is set in three places that must agree: `src/security/headers.ts`
  (imported by both the API and the web tier) and the `header` block in
  `site/Caddyfile`. The duplication is deliberate — it means a local
  `bun run dev` behaves like production, and an instance put behind something
  other than that Caddyfile is still covered.
- `style-src` keeps `'unsafe-inline'`. The lander and its siblings carry their
  CSS in a `<style>` block and React writes `style` attributes at runtime.
  Injected CSS can restyle a page; it cannot read a token.

`tests/legal.test.ts` fails if an inline `<script>` reappears on the lander.

## Agent logins

An agent CLI's login is carried between a user's boxes so that signing in again
is not the price of destroying one. It is the only value here that is not this
instance's own secret: it belongs to whoever signed in, reaches their Anthropic
or OpenAI account rather than anything of ours, and can spend their money.

- Encrypted at rest with AES-256-GCM (`src/util/secretbox.ts`), keyed from
  `DEVPIPE_SECRET_KEY` in `/etc/devpipe.env` — never in the database it
  protects. Without the key the instance stores nothing rather than storing
  plaintext.
- Fetched by the box over TLS using its own agent token, **not** passed through
  cloud-init. Provider user data is retained by DigitalOcean and served to
  anything on the box that can reach the metadata service, which is no place
  for a credential of this kind.
- Only paths the catalogue names are accepted, so a box cannot ask the control
  plane to keep arbitrary files, and the restore refuses any path that escapes
  the home directory.
- Files land `0600`, owned by `devpipe`.

There is no browser-side interception of the OAuth flow, and there should not
be. The providers' login pages set `frame-ancestors 'none'`, cross-origin
isolation makes reading a token out of a frame impossible anyway, and a page
that renders somebody's identity provider inside our chrome to capture the
credential is the shape of a phishing attack regardless of who wrote it. The
sign-in happens in the terminal, on the real origin, once.

## What is deliberately not defended

- **What runs on a box.** Terminals are the product, the daemon holds the pty,
  and the control plane never sees the bytes. Enforcement is about accounts, not
  content — see the note at the top of `src/security/abuse.ts`.
- **A determined re-registrant.** Invite-only signups, rate limits and the
  disposable-address list are worth about one round of automated signups and
  nothing at all against somebody patient.
- **The instance owner.** They hold the DigitalOcean token, which can destroy
  every box on the account. If the control plane host is compromised, revoking
  that token in the DigitalOcean console is the remedy; deleting it from the
  admin screen is not.
