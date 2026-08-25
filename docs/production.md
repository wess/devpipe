# Production operations

## Required configuration

An HTTPS deployment refuses to start without both `DATABASE_URL` and a valid
32-byte base64 `DEVPIPE_SECRET_KEY`. Put them in `/etc/devpipe.env`, readable
only by the service account. Set `DEVPIPE_SETUP_TOKEN` before exposing a fresh,
unclaimed instance; remove it after the owner has claimed the instance.

DigitalOcean production instances also require a provider token, a DNS zone on
that account, and optionally one or more operator SSH keys. The application
stores provider credentials encrypted and refuses to disconnect a provider
while any managed machine or workspace still needs it for cleanup.

## Health

- `GET /health` proves the API process is serving requests.
- `GET /ready` proves the API can reach Postgres after migrations.

Use readiness for deployment and load-balancer checks. A running systemd unit
is not sufficient evidence that the application is usable.

## Deploy and rollback

`site/deploy.sh <host> [ssh-key]` performs the production deployment used for
devpipe.com. Before uploading it verifies the environment file, requires
`pg_dump`, and writes a compressed database backup to
`/var/backups/devpipe/predeploy-<UTC timestamp>.sql.gz`. It retains the previous
API and web binaries and restores them if the new API never reaches readiness.

Schema migrations must remain compatible with the previous binary for at least
one release. The billing-code removal follows that rule by leaving legacy tables
and columns in place while the application stops reading them. Remove obsolete
schema only after the rollback target no longer needs it.

After a deploy verify the public lander, `/api/ready`, `/runs`, and the provider
ledger. Provisioning tests can create real spend; use the documented sweep and
confirm no unclaimed machine or volume remains.

## Recovery

Provider mutations are recorded in `machine_operations`. On startup, unfinished
provision and wake operations locate resources by their operation tag and resume
workspace/address setup. A failed cleanup remains visible in the database; it is
never converted into a successful delete merely because provider credentials
are unavailable.

Database backups are not a recovery plan until restored. Periodically restore a
production backup into an isolated Postgres instance, run migrations, start the
API against it, and verify `/ready` plus representative box/workspace records.
