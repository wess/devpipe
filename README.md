# Devpipe

Agents that keep working when you close the laptop.

A box is a durable remote workspace for coding agents. Start an agent in a
persistent terminal, close the browser or laptop, and attach to the same session
later from the web app or the `devpipe` CLI. The machine is rented by the hour
and can sleep when nobody is using it; its files live on a workspace that
outlives the compute.

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
core/           Rust: sinclair's VT compiled to WebAssembly for the browser
daemon/         Rust: the per-box daemon — ptys, files, and a port proxy
                plus the cross-platform `devpipe` CLI
site/           the lander, Caddyfile, and deploy
deploy/         box provisioning and the daemon's systemd unit
scripts/        sweep — what the provider is billing for that nothing claims
```

## One persistent session, two ways in

`devpiped` owns each PTY on the box. A browser or CLI attachment is only a
subscription: disconnecting drops the transport, not the shell or the agent.
Reattaching replays the current terminal screen. The browser renders that byte
stream with the Rust emulator in `core/`; the CLI uses the local terminal.

## Running one of your own

Apache-2.0, and the repository is the whole product — there is no crippled
edition. DigitalOcean is the production backend used by devpipe.com. Local
Docker is a development backend built against the same lifecycle contract;
Runpod uses that OCI image with Pods, HTTPS proxy endpoints, and network-volume
workspaces.

Provider calls do not live in routes. The machine layer journals an operation
before creating, releasing, or deleting a resource, tags the provider resource
with that operation id, and resumes unfinished provisioning after an API
restart. Compute, workspaces, network policy, DNS, and usage are explicit
capabilities because no honest adapter can assume every provider has all five.
See [docs/providers.md](docs/providers.md).

The first-run requirements depend on the backing provider:

| | |
|---|---|
| **A provider** | DigitalOcean needs a write-enabled API token, its DNS zone, and ideally an SSH key. Runpod needs an API key and `DEVPIPE_RUNPOD_IMAGE` pointing to a published box image. Local Docker needs that image built on the API host. |
| **A box address** | DigitalOcean writes each box beneath a domain hosted on that account. Runpod uses its trusted HTTPS proxy. Docker publishes a random loopback port and the API relays it. |
| **Postgres** | Sessions, boxes, the audit trail, the sealed credentials. It wants a backup, somewhere the database host is not. |
| **A host** | A small droplet. It provisions and proxies; it compiles nothing. |
| **An SSH key on DigitalOcean** | Optional, and the only way onto a VM that wedges partway through setup — which is exactly when nothing else works. |

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
a fresh instance and the claim form requires it. The wizard then opens by itself
and shows only the requirements for the selected provider. Credentials are
checked before they are stored; DigitalOcean also checks its DNS zone and SSH
keys.

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

The app is at `/terminals`; `/` is the lander.

### CLI

Install the CLI, sign in once, and attach by box name:

```sh
curl -fsSL https://devpipe.com/install.sh | sh
devpipe login
devpipe boxes
devpipe attach mybox
```

`attach` wakes a sleeping box, reuses its newest live shell, and leaves it
running when you detach with `Ctrl-]`. Use `--new` for a fresh shell or
`devpipe run mybox -- <command>` for a one-off command. Port forwarding and file
transfer use the same authenticated daemon connection; run `devpipe --help` for
the complete command list.

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
for their own subdomain, so browser and CLI connections use ordinary system
trust without certificate exceptions.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
