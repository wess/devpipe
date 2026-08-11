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
