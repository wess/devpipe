# Devpipe

Agents that keep working when you close the laptop.

A run is the unit: one agent, on its own branch, in its own worktree, on a box
you own. Start one from anywhere, watch what it is doing, answer it when it asks
— from a browser, a phone, or the terminal. The machine is rented by the hour
and given back when nobody is using it; the files are on a volume that outlives
it.

There is a terminal, and it is very good. It is not the product.

```
src/            the Atlas app — API and web client (Bun + TypeScript)
  auth/         sessions, the cookie, and what a session is bound to
  boxes/        box routes, bootstrap, reclaim, and reconciliation
  machine/      durable provider-operation journal and recovery
  providers/    compute, workspace, network, and usage adapters
  previews/ shares/   showing a port or a terminal to somebody who is not you
  vault/ workspaces/ settings/ users/ admin/ terminals/
  web/          the React client, including the terminal
migrations/     schema, one directory per change, up and down
core/           Rust: sinclair's VT behind a C ABI → iOS staticlib and .wasm
daemon/         Rust: the per-box daemon — ptys, files, and a port proxy
ios/            Swift: the iPhone and iPad client
site/           the lander, Caddyfile, and deploy
deploy/         box provisioning and the daemon's systemd unit
scripts/        sweep — what the provider is billing for that nothing claims
```

## One emulator, two clients

`core/` compiles to **three** targets from one source: a static library the
iPad app links, a `.wasm` the browser instantiates, and an rlib the tests use.
Web and iOS therefore agree on what a byte stream means — cursor movement,
wide characters, scroll regions, colour — because there is one implementation
rather than two that were made to look alike.

The layout matches for the same reason: a column of boxes and their terminals
on the left, the terminal filling the rest. Switching device should not mean
relearning where anything is.

## Running one of your own

Apache-2.0, and the repository is the whole product — there is no crippled
edition. DigitalOcean is the production backend used by devpipe.com. Local
Docker is a development backend built against the same lifecycle contract;
Runpod is the next backend, not one the current release pretends is complete.

Provider calls do not live in routes. The machine layer journals an operation
before creating, releasing, or deleting a resource, tags the provider resource
with that operation id, and resumes unfinished provisioning after an API
restart. Compute, workspaces, network policy, DNS, and usage are explicit
capabilities because no honest adapter can assume every provider has all five.
See [docs/providers.md](docs/providers.md).

Four things it needs before it can build anything, and the second is the one
people trip on:

| | |
|---|---|
| **A DigitalOcean account** | API → Tokens → Generate New Token, with **Write** ticked as well as Read. That token creates and destroys droplets, detaches volumes and writes DNS, so give it an account of its own rather than one shared with unrelated infrastructure. A new account is usually capped at 10 droplets and has no GPU access; both are raised by asking support. |
| **A domain whose DNS is on that account** | Networking → Domains → Add a domain, then point the registrar's nameservers at `ns1.digitalocean.com` (and ns2, ns3). Not merely a domain you own: every box gets an `A` record under it and that record is what makes its certificate possible. A domain hosted anywhere else gives you boxes that build perfectly, never resolve, and never get TLS. |
| **Postgres** | Sessions, boxes, the audit trail, the sealed credentials. It wants a backup, somewhere the database host is not. |
| **A host** | A small droplet. It provisions and proxies; it compiles nothing. |
| **An SSH key on the account** | Settings → Security → Add SSH Key. Optional, and it is the only way onto a box that wedges partway through setup — which is exactly when nothing else works. |

`DEVPIPE_SECRET_KEY` is the one secret that cannot live in the database, because
it is what encrypts the database's secrets:

```sh
openssl rand -base64 32   # → DEVPIPE_SECRET_KEY in /etc/devpipe.env
```

Without it the provider token is stored as readable text and a copy of a backup
is a copy of it. The setup wizard generates one and says so plainly rather than
letting that pass quietly.

The first account registered becomes the owner — exactly one, enforced by a
unique index rather than by agreement. Set `DEVPIPE_SETUP_TOKEN` before exposing
a fresh instance and the claim form requires it. The wizard then opens by itself: the
provider token, the domain, an SSH key, a spending cap. Each is checked against
DigitalOcean before it is accepted, because every one of them fails hours later
looking like something else.

### One owner, and a team under them

The line is money and irreversibility.

- **owner** — one per instance. The provider token, the spending cap, and who
  else administers it. Promoting somebody is a *transfer*: you become an admin
  in the same breath.
- **admin** — invites, suspensions, the audit log, every box and what the
  instance is spending, and GPU machines. Never the provider token. That is the
  whole reason the middle role exists: helping run the instance used to mean
  holding the credential that can destroy every box on the account.
- **user** — their own boxes, and what they have cost.

### The spending cap

**Nothing is sold here and nothing is charged.** There is no payment processor
in this and no billing code — Devpipe creates machines on your DigitalOcean
account and DigitalOcean invoices you for them, the same as if you had clicked
Create in their console. What the software adds is that it knows what those
machines cost, tells you, and stops when you say stop.

The meter counts every box and every volume at the provider's own prices, and
accumulates over the provider's own calendar month — so destroying a box does
not undo what it already cost. You get a warning at a threshold you set, a
refusal for a box whose first hour would cross the line, and past the cap the
running machines are put to sleep onto their workspaces. A box carrying no
workspace is never touched by any sweep here, which is the difference between
reclaiming a machine and destroying somebody's afternoon.

GPU boxes are an admin's to create. The cheapest card is a hundred times the
hourly cost of the cheapest ordinary box, and the bill lands on whoever
installed the instance.

## Running it locally

The schema is Postgres — `SERIAL`, `TIMESTAMPTZ`, `NOW()` — so there has to be
one. `DATABASE_URL` points at it; with nothing set, the API falls back to the
same local instance the tests use and creates the database on first run.

```sh
docker run -d --name devpipe-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -p 55434:5432 postgres:17-alpine

bun install
bun run dev            # api on :3000, web on :3001
```

The app is at `/runs`; `/` is the lander.

### Using local Docker for boxes

Build the box image and select the Docker adapter before starting the API:

```sh
docker build -f deploy/docker/box.Dockerfile -t devpipe-box:local .
export DEVPIPE_MACHINE_PROVIDER=docker
export DEVPIPE_SECRET_KEY="$(openssl rand -base64 32)"
bun run dev
```

Docker publishes each daemon on a random loopback port and the control plane
relays its terminal websocket. Named Docker volumes are workspaces. This backend
is for development and provider-contract testing: it does not currently install
the selectable cloud tool catalogue and it is not a multi-tenant isolation
boundary.

For the browser terminal, build the emulator first:

```sh
cd core && cargo build --release --target wasm32-unknown-unknown
```

## Tests

```sh
bun test               # api, wizard catalog, and the wasm emulator from JS
cd core   && cargo test
cd daemon && cargo test
```

## Deploying

```sh
site/deploy.sh <host>          # lander, API, web, and the daemon boxes download
synapse run -- deploy/provision.sh   # create a box and install onto it
```

The site deploy refuses a host without `DATABASE_URL` and
`DEVPIPE_SECRET_KEY`, takes a timestamped `pg_dump` under
`/var/backups/devpipe`, retains the previous binaries, and requires `/ready`
before it declares success. Detailed backend and production notes live in
[docs/providers.md](docs/providers.md) and [docs/production.md](docs/production.md).

Boxes are provisioned with cloud-init and get a real Let's Encrypt certificate
for their own subdomain. That is not cosmetic: iOS App Transport Security
evaluates system trust *before* an app's pinning code is consulted, so a
self-signed certificate can never be rescued by pinning. See
[docs/spikes.md](docs/spikes.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
