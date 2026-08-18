# Showing something on a box to somebody who does not have the box

Two features that answer the same question, built on the same rule: **the box's
credential never leaves the control plane.**

- **Previews** — a port on a box, reachable in a browser at a hostname of its
  own. For looking at what an agent built, which a diff cannot show you.
- **Shares** — a terminal on a box, watched (or typed into) from a link. For
  pairing, and for handing the keyboard to whoever knows the subsystem.

## Previews

```
browser → Caddy (on-demand TLS) → API :3000 → https://<box>/v1/proxy/<port>/… → 127.0.0.1:<port>
```

**The hostname is one DNS label.** `p-bcdfgh2345.devpipe.com`, not
`3000.box.devpipe.com`. That is not cosmetic: the `*.devpipe.com` A record that
already exists covers one label and no more, and anything deeper needs a
wildcard certificate, which needs DNS-01, which needs a Caddy built with the
DigitalOcean plugin. `p-` cannot collide with a box, because a box is
`<username>-<short>` and a username is at least three characters.

**Certificates are issued on demand.** `site/Caddyfile` has a catch-all
`https://` block with `tls { on_demand }`, gated by `on_demand_tls { ask … }`
pointing at `GET /previews/allow?domain=…` on the API. Without the `ask`,
anybody who points a hostname at this address makes the server fetch a
certificate on their behalf — and enough of that gets the account rate-limited
by Let's Encrypt over names it has never heard of.

**Previews bypass the web tier.** Caddy sends them straight to the API. Two
reasons, both load-bearing: a preview is somebody else's application and must
not inherit this instance's `Content-Security-Policy` (which forbids the inline
scripts most dev servers emit); and the web tier proxies with `fetch`, which
cannot carry a websocket, so live reload would be the one thing that silently
did not work.

**Private is the default.** The URL is not a credential. A private preview
redirects to `/preview/<slug>` on the app, which turns the session it holds into
an `HttpOnly; Secure; SameSite=Lax` cookie **on the preview's own host** — no
`Domain` attribute, so it is never sent to the app, to a box, or to another
preview. The cookie names the preview it was issued for, so admitting a browser
to one port does not admit it to the rest of the account.

`audience: "link"` is the deliberate exception, for showing somebody with no
account. Those expire — a day by default, a month at most.

**The daemon end** is `daemon/src/proxy.rs`. It is a reverse proxy rather than a
tunnel (`/v1/forward` is the tunnel, and it is the right shape for `ssh -L` and
the wrong one for a browser). It rewrites `Host` to loopback — Vite and
webpack-dev-server refuse names they do not recognise, which presents as a blank
page — passes websocket upgrades through with `with_upgrades`, and strips the
bearer out of the query before the dev server sees it.

Boxes download the daemon on boot, so **a running box picks this up when it is
next created or woken**, not on deploy. A box on an older daemon 404s every
preview request; the control plane recognises that by the missing
`x-devpipe-proxy` header and says to wake the box rather than letting it read as
the dev server's own 404.

## Shares

```
guest → Caddy → web :3001 (websocket relay) → API :3000 → wss://<box>/v1/sessions/<id>/attach
```

The guest's socket terminates on the control plane. That hop is the entire
feature: the daemon has exactly one credential and it is all-powerful, so a
share that handed it over would be a share of the whole machine with a polite
request not to type. `watch` drops every frame travelling towards the box —
keystrokes and resizes both, because a second pair of eyes reflowing somebody's
editor mid-sentence is the one way a read-only share could still ruin an
afternoon.

The owner's own terminal still connects **straight to the box**, as it always
has. A watcher can afford a hop; the person working cannot.

The link is shown once. The row holds `sha256(token)`, so there is nothing to
show a second time and nothing for a database leak to spend.

**Sleeping a box closes its shares.** A share names a session id on a daemon
that is about to stop existing, and waking builds a new machine with an empty
session list — so the link would stay live and connect to nothing forever, which
a guest cannot tell from a slow box. Previews deliberately survive: they name a
*port*, and the port is the same one when the box comes back. Both go when the
box is destroyed. See `src/shares/retire.ts`.

## What a deploy needs

- `site/deploy.sh` already uploads `site/Caddyfile`, validates it, and reloads
  Caddy. Nothing else to do for previews at the edge.
- `target-linux/release/devpiped` must be rebuilt and uploaded (the same script
  does it) or new boxes get a daemon without `/v1/proxy`.
- No DNS change. `*.devpipe.com` already points at the edge.

## Known edges

- Preview traffic goes through the API tier, which is a 512MB droplet. Fine for
  a handful of previews; it is not a CDN.
- The preview host handler runs ahead of the router and therefore ahead of the
  rate limiter. A preview URL is unguessable, so the exposure is somebody
  hammering a link they were given.
- A `link` preview serves whatever is on a box from a `devpipe.com` name, which
  is a phishing surface if somebody wants one. What stands against it: link
  previews expire (a day by default, a week at most), every response carries
  `X-Robots-Tag: noindex`, and every preview is attached to an account and shows
  up in the audit log as `preview.created`. Worth revisiting if this instance
  ever has users it does not know.
- Nothing on iOS opens a preview or a share yet. Both are URLs, so the phone can
  open them in Safari; neither has a screen in the app.
