# Devpipe

Persistent terminal sessions on a remote box, from a browser or an iPad.

```
src/            the Atlas app — API and web client (Bun + TypeScript)
  auth/ users/ admin/ boxes/ terminals/ settings/ waitlist/
  web/          the React client, including the terminal
migrations/     one statement per migration (the SQLite driver prepares one)
core/           Rust: sinclair's VT behind a C ABI → iOS staticlib and .wasm
daemon/         Rust: the per-box daemon, pty sessions over a websocket
ios/            Swift: the iPad client
site/           the lander, Caddyfile, and deploy
deploy/         box provisioning and the daemon's systemd unit
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

## Running it

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

The first account registered becomes the owner. There is no other way to
become one, so a fresh instance is claimable exactly once.

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

Boxes are provisioned with cloud-init and get a real Let's Encrypt certificate
for their own subdomain. That is not cosmetic: iOS App Transport Security
evaluates system trust *before* an app's pinning code is consulted, so a
self-signed certificate can never be rescued by pinning. See
[docs/spikes.md](docs/spikes.md).
