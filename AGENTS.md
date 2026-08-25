# Devpipe

Devpipe runs coding-agent work on rented boxes that outlive the local client. A
run owns a branch and worktree; the web, iOS, daemon, and shared terminal core
are clients and infrastructure around that unit.

## Stack and layout

- `src/`: Bun/TypeScript Atlas API and React web client.
- `core/`: Rust terminal emulator compiled for host, iOS, and WebAssembly.
- `daemon/`: Rust per-box PTY, files, and port proxy.
- `ios/`: Swift phone and tablet client.
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
- Browser and iOS terminal behavior come from the same Rust core. Do not fork the
  emulator logic by client.
- Polling the companion event feed must not touch box activity and keep a rented
  machine alive. Human actions may touch it.
- The app lives at `/runs`; `/` is the lander.
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
box lifecycle, companion routing, security, or deployment behavior.
