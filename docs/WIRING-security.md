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

The certificate is real, from Let's Encrypt over HTTP-01. Browser websockets and
the CLI therefore use the operating system's ordinary trust store; there is no
self-signed exception or pin to distribute.

Authentication to a box is `agent_token`, generated per box in
`src/boxes/index.ts` and known only to that box and the control plane. It opens
everything `devpiped` serves: a shell, every file under `/v1/fs`, a proxy to any
listening port, a forward to any loopback socket.

**No client ever sees it.** `/boxes/:id/connection` used to answer with it, which
was defensible when the daemon served terminals and nothing else, and stopped
being so the moment it grew a file system — a page holding that token could read
`~/.ssh`, rewrite `~/.bashrc` and spawn a shell, all on the same socket the
terminal was on. The credential grew; what it was handed to did not.

What a client gets instead is a **scoped attach token**: `<scope>.<expiry>.<sig>`,
HMAC-SHA256 **keyed by the box token**, minted in `src/util/boxscope.ts` and
verified in `daemon/src/scope.rs`. Keying it on the box token is what makes the
scheme free to operate — both sides already hold it, so there is no key to
distribute and nothing extra to rotate, and rotating a box's token invalidates
every token minted against it.

- It lasts **two minutes** and reaches **one pty**. `authorized_attach` in
  `daemon/src/lib.rs` is the only check that accepts one; files, proxy, forward,
  session create and session delete all still demand the full bearer.
- It still travels in the websocket query string for the browser, because a
  browser cannot set headers on a handshake, so it still lands in that box's
  access log. The difference is what is now in that log. `devpipe` uses `ureq`
  and sends a header, so nothing appears in a URL there.
- Because it expires, it cannot be fetched once and kept. The browser mints one
  per connection attempt in `src/web/terminal/session.ts`; a reconnect after a
  backgrounded tab may happen hours after the first token was issued.
- `attach:<session>` scopes to a single session, for a credential handed to
  somebody who is not the owner.

The two implementations are pinned to each other by a shared test vector, in
`tests/boxscope.test.ts` and `scope.rs`. Change the body format, the digest or
the encoding on either side and one of the two fails, rather than every terminal
in production.

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

`devpipe` (`daemon/src/bin/devpipe.rs`) signs in to the control plane once, keeps
the session token in the system keychain, and attaches a local terminal to a box
over the same authenticated WSS on 443 the web app uses:

    devpipe login
    devpipe attach mybox

There is nothing to configure — no key, no `known_hosts`, no flags — because the
box already has a hostname under `devpipe.com` and a Let's Encrypt certificate
for it. SSH would be worse here even if port 22 were open: **waking a box builds
a new droplet**, so its host key changes on every wake and anybody using SSH
meets `REMOTE HOST IDENTIFICATION HAS CHANGED` every time they come back.

Two properties worth keeping:

- The stored credential is `{server, token}` together, not a bare token. They
  are one credential — a token minted by a self-hosted instance is worthless at
  devpipe.com, and sending it there would hand a third party a working session.
- `devpipe` sets a `User-Agent` of `devpipe/<version> (<hostname>)`, which is what
  `startSession` records. A laptop therefore appears by name under Settings →
  Devices and can be signed out from there, so the revocation story is the one
  that already existed rather than a new one.

A box that is asleep is woken and waited for, and `attach` reattaches to a live
session of the same shape rather than starting a new shell — the work outliving
the connection is the product, and an `ssh`-shaped client that opened a fresh
shell every time would throw it away.

`devpipe port mybox 3000` is `ssh -L`'s replacement, over the daemon's
`/v1/forward`. The destination is **not a parameter** — it is always
`127.0.0.1` on the box — and that is the whole security model here. An endpoint
that forwarded to an arbitrary host would be an open proxy for anyone holding a
box token: not a privilege escalation, since the owner already has a shell, but
it would make relaying through a box a one-liner rather than something you set
up on purpose, and that is the distinction `abuse.ts` turns on. A test asserts
the destination stays unchoosable.

One websocket per TCP connection rather than one multiplexed socket with stream
ids: multiplexing means inventing framing, a close protocol and flow control,
all of which the websocket already has, and the thing being forwarded is a dev
server where connections number in the tens.

The local end binds loopback, never `0.0.0.0` — a forward bound to every
interface republishes the box's private port to whatever network the laptop is
on, which is a coffee shop about half the time.

`devpipe ls / pull / push / edit` move files over `/v1/fs/*` on the same door with
the same bearer, rather than reopening SSH — which a box locks down on purpose
(`DisableForwarding yes`) and whose host key changes on every wake, because
waking builds a new machine.

**There is no path jail, and that is the considered answer.** The bearer that
reaches `/v1/fs` is the same one that spawns a process on `/v1/sessions` — a
shell as `devpipe`, who has passwordless sudo by design, so root is one word
away — and a restriction would stop nothing an attacker could not do
in one more request, while breaking the legitimate case of reading a config
outside the home directory. The credential is the boundary, and it never leaves
the control plane on the web path or the client's keychain on the `devpipe` path.

Two asymmetries, both deliberate:

- A directory comes **down** as a `tar` stream and goes **up** one file at a
  time. Producing an archive is safe by construction; consuming one is not — the
  names inside are chosen by whoever made it, and `../../etc/cron.d/x` is the
  oldest trick there is. Extracting an untrusted archive as root, to save round
  trips on the rarer direction, is not a trade worth making.
- A push does not follow symlinks. One pointing outside the tree would copy
  somebody's whole home directory onto a box by accident; a listing reports a
  link as a link rather than as its target, for the same reason.

Writes land beside the target and are renamed over it. A half-written file that
still carries the right name is the failure that costs a morning: an editor opens
it, an agent reads it, and nothing says it is a torso.

Getting it: `curl -fsSL https://devpipe.com/install.sh | sh`. Served from disk
by Caddy rather than through the app, so the first thing a new user runs does
not fail because the API tier is restarting. macOS is one universal binary
covering both architectures, so an Intel Mac is not a separate instruction;
Linux x86-64 comes out of the same container as the box binaries. The macOS
build is ad-hoc signed — enough that Gatekeeper does not refuse a downloaded
binary outright, **not notarised**, which is a real gap and its own piece of
work. Windows and Linux ARM are built by `.github/workflows/devpipe.yml`.

Still to build on this channel: file transfer. It rides the same socket and
needs no new inbound port.

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

## The browser's session

An `HttpOnly` cookie, `dp_session`, host-only and `SameSite=Lax`. It was a string
in `localStorage`, which made one injected script on this origin an account
takeover — with the `Content-Security-Policy` the only thing in the way. That
policy is good and it is still there. It was also the *entire* defence, and one
inline `<script>` added by somebody in a hurry would have quietly turned every
injection into a full compromise. A credential JavaScript cannot read fails safe.

**A session is bound to the client that started it.** A stolen token otherwise
works from anywhere for thirty days and nothing about a request would notice.
The address is the obvious thing to bind to and the wrong one — a phone changes
address walking between two rooms — so what is compared is the *client*:
`src/auth/fingerprint.ts` reduces the user agent to a program and a machine,
`Chrome/Mac`, with versions deliberately dropped so a browser that updates
itself every three weeks does not sign its user out every three weeks. A real
session is held by one program for its whole life; a replayed token is almost
always presented by a different one.

On a mismatch the row is **deleted**, not merely refused. Once a token has been
seen in the wrong hands there is nothing left to protect, and leaving it alive
only lets the holder try again with a better disguise.

An empty `agent_class` is unbound and always passes, but sessions predating the
column are not left that way: `requireAuth` derives the class from the
`user_agent` recorded when the row was created, so an old session binds to the
client that actually made it rather than to whoever presents it next — which
would hand the binding to whichever party got there first.

`devpipe` keeps sending `Authorization: Bearer` and holds its token in a system
keychain no web page can reach. `requireAuth` takes either bearer or cookie,
with the explicit header first.

**`SameSite` is not the CSRF defence here, and cannot be.** Boxes and previews
live at `*.devpipe.com`, which is the same *site* as the app: a preview serving
somebody's half-written application could POST to the API and a `Lax` — or even
`Strict` — cookie would ride along. What separates them is the **origin**, which
differs even though the site does not. So a cookie-authenticated request must
carry `Origin: https://devpipe.com`; a missing one is accepted on GET and HEAD,
because a top-level navigation sends none, and refused on anything that can
change something.

Bearer-authenticated requests are **not** origin-checked, and the asymmetry is
the point: a page can make a browser *send* a cookie without being able to read
it, so a cookie needs a second signal that the request came from us. A header has
to be put there by whoever holds the token.

A private preview is admitted by a **one-minute signed code**, not by the
session. The app has no token in JavaScript to send to another origin, and a
value meaning "let this browser see preview 41 for the next minute" is a far
smaller thing to hand over than one meaning "act as this account".

## The browser

An injected script here can act as the user for as long as the page is open —
the cookie above rides along on every request it makes. It can no longer *steal*
the session, and the box credential it would once have found in memory is now a
two-minute permission to attach to a pty. Both of those cap the damage; neither
removes it. The mitigation is still that there is nowhere to inject from:

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

## The instance's own credentials

The DigitalOcean token is encrypted at rest with the same AES-256-GCM and the
same `DEVPIPE_SECRET_KEY` as an agent login. It was plaintext, which made it the
worst thing in the database: it creates and destroys every droplet on the
account, detaches volumes and spends money with no ceiling, and nightly backups
of that table are rsynced off the database host — so "readable with a `psql`
session" understated it.

It is bound to its own row with `credential:<key>` as additional authenticated
data. Encryption stops a value being read; only binding stops it being *moved* —
without it, any other sealed value in that table could be copied into the
provider row and the instance would decrypt it happily and hand it to
DigitalOcean.

Two deliberate differences from agent logins:

- **A plaintext row still opens**, and is sealed in place on the way past.
  Refusing them would have taken provisioning down on the deploy that shipped
  this, and sealing on read rather than on next write means the plaintext stops
  existing at the first use rather than at a write that, for a provider token,
  may never come.
- **Without a key, storage stays plaintext** rather than refusing. An agent
  login is optional and an instance that declines to keep one still works; the
  provider token is what the product runs on, and a control plane that cannot
  provision is not a safer control plane. What matters is that nothing implies
  otherwise, so `/admin/settings` returns `secrets_sealed` and the screen says
  so in as many words.

## Guessing

Two things here are reachable without an account, because that is the point of
them: a `link` preview's hostname and a share token. Both are therefore sized as
credentials — 22 characters of a 27-letter alphabet for a slug (~104 bits), 32
random bytes for a share — and `shortId` draws them by rejection rather than
`byte % 27`, which is not uniform and gave the first thirteen letters an 11%
edge.

Both count **misses** against the address, and neither counts hits. A preview
serves a website and one page load is thirty requests; metering those would
break the feature to defend nothing, since somebody holding a working link
already has what the limit protects. A request for a slug that does not exist is
what a search through the namespace looks like, and what somebody with a real
link almost never produces.

The preview host is answered ahead of the router — deliberately, so it cannot
inherit this instance's `Content-Security-Policy` — which puts it ahead of every
rate limiter attached to a route. `consume()` is called there directly for
exactly that reason.
