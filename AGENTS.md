# Devpipe

Devpipe runs coding agents on rented boxes that outlive any one connection. The
web app and `devpipe` CLI are two ways to attach to the same persistent sessions.

## Stack and layout

- `src/`: Bun/TypeScript Atlas API and React web client.
- `core/`: Rust terminal emulator compiled for host tests and WebAssembly.
- `daemon/`: Rust per-box PTY, files, and port proxy, plus the `devpipe` CLI.
- `migrations/`: Postgres schema.
- `deploy/` and `site/`: provisioning and production host.

The web tier follows the Atlas/Stohr shape. Keep `src/server.ts` as the
composition root and feature routes in `src/<feature>/index.ts`.

## Commands

```sh
bun install
bun run dev
bun test
bun run typecheck
bun run check
cd core && cargo test
cd daemon && cargo test
```

Build `core` for `wasm32-unknown-unknown` before browser-terminal tests. A clean
tree may lack the generated WebAssembly artifact; report that as an environment
gap rather than hiding the failing test.

## Invariants

- Postgres is the only server database. The unset fallback is the local instance
  on port 55434.
- Browser terminal behavior comes from the Rust core. Do not add a second web
  terminal emulator.
- `devpipe attach <box>` reuses a live shell by default. Detaching must leave the
  session and its agent running; `--new` is the explicit fresh-session path.
- The app lives at `/terminals`; `/` is the lander.
- Bun's HTML bundle paths are normalized to root-relative URLs. Asset-like misses
  must 404 instead of returning the SPA shell.
- Security headers are shared by API and web, and the lander has no inline script
  allowance.
- Provisioning defaults to the smallest Debian droplet. Measure memory pressure
  before changing that cost decision.
- Provisioning and teardown can create real spend. Use the documented sweep and
  cleanup path, and verify the provider ledger after tests.
- Use `synapse run -- ...` for the approved scoped provider credential; never
  print or persist its value.

Read `README.md`, relevant `docs/`, and current project memories before changing
box lifecycle, terminal routing, security, or deployment behavior.
