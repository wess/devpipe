#!/usr/bin/env bash
# Publish devpipe.com: the lander, the API, the web app, and the daemon build
# that new boxes download.
#
# Usage: site/deploy.sh <host> [ssh-key]
set -euo pipefail

HOST="${1:?usage: deploy.sh <host> [ssh-key]}"
KEY="${2:-$HOME/.ssh/id_rsa}"
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SITE")"
DEV="$(dirname "$ROOT")"
NAME="$(basename "$ROOT")"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST")
SCP=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "==> vt.wasm"
(cd "$ROOT/core" && cargo build --release --target wasm32-unknown-unknown >/dev/null)

echo "==> devpiped (linux/amd64) — this is what new boxes download"
docker run --rm --platform linux/amd64 \
  -v "$DEV":/work -w "/work/$NAME/daemon" \
  -e CARGO_TARGET_DIR="/work/$NAME/target-linux" \
  rust:bookworm bash -c "cargo build --release --bin devpiped" >/dev/null

echo "==> bundling the app"
cd "$ROOT"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
# Standalone executables: the box runs one binary each for api and web with no
# node_modules to keep in sync, which matters on a machine chosen to be small.
bun build --compile --minify --target=bun-linux-x64 src/server.ts --outfile /tmp/devpipe-api >/dev/null
# The SPA is bundled here, not on the box: the shipped binary only serves what
# this step produced.
rm -rf src/web/dist
bun build src/web/index.html --outdir src/web/dist --target browser --minify >/dev/null
bun build --compile --minify --target=bun-linux-x64 src/web/serve.ts --outfile /tmp/devpipe-web >/dev/null

echo "==> uploading"
"${SSH[@]}" "mkdir -p /var/www/devpipe/fonts /var/www/devpipe/dist /opt/devpipe/migrations /opt/devpipe/site /opt/devpipe/src/web/dist"
# The lander and its siblings, to both roots: Caddy serves /dist from the first
# and the web binary reads the second as SITE_DIR.
#
# lander.js goes with them. It is the lander's behaviour, external rather than
# inline so that script-src can refuse 'unsafe-inline'; leaving it behind gives
# a page whose claim form silently does nothing.
for page in index.html terms.html privacy.html aup.html lander.js; do
  scp "${SCP[@]}" -q "$SITE/$page" "root@$HOST:/var/www/devpipe/$page"
  scp "${SCP[@]}" -q "$SITE/$page" "root@$HOST:/opt/devpipe/site/$page"
done
# Pricing was withdrawn before launch; a copy left on the box would still be
# served, and it quotes numbers that no longer stand.
"${SSH[@]}" "rm -f /var/www/devpipe/pricing.html /opt/devpipe/site/pricing.html"
scp "${SCP[@]}" -q "$SITE"/fonts/*.woff2 "root@$HOST:/var/www/devpipe/fonts/"
scp "${SCP[@]}" -q "$SITE/Caddyfile" "root@$HOST:/etc/caddy/Caddyfile"
scp "${SCP[@]}" -q "$ROOT/target-linux/release/devpiped" "root@$HOST:/var/www/devpipe/dist/devpiped"
# Replaced, not merged: scp -r leaves files the repo has since deleted, and a
# stale migration sorts back into the sequence and re-runs work a later one
# already did.
"${SSH[@]}" "rm -rf /opt/devpipe/migrations"
scp "${SCP[@]}" -qr "$ROOT/migrations" "root@$HOST:/opt/devpipe/"
scp "${SCP[@]}" -qr "$SITE/fonts" "root@$HOST:/opt/devpipe/site/"
scp "${SCP[@]}" -q "$ROOT/core/target/wasm32-unknown-unknown/release/devpipecore.wasm" \
  "root@$HOST:/opt/devpipe/vt.wasm"
scp "${SCP[@]}" -q /tmp/devpipe-api "root@$HOST:/usr/local/bin/devpipe-api.new"
scp "${SCP[@]}" -q /tmp/devpipe-web "root@$HOST:/usr/local/bin/devpipe-web.new"
scp "${SCP[@]}" -qr "$ROOT/src/web/dist/." "root@$HOST:/opt/devpipe/src/web/dist/"

"${SSH[@]}" "bash -s" <<'EOF'
set -euo pipefail
install -m 0755 /usr/local/bin/devpipe-api.new /usr/local/bin/devpipe-api
install -m 0755 /usr/local/bin/devpipe-web.new /usr/local/bin/devpipe-web
rm -f /usr/local/bin/devpipe-api.new /usr/local/bin/devpipe-web.new
chmod 0755 /var/www/devpipe/dist/devpiped

id -u devpipe >/dev/null 2>&1 || useradd --system --home /opt/devpipe --shell /usr/sbin/nologin devpipe
mkdir -p /var/lib/devpipe
chown -R devpipe:devpipe /var/lib/devpipe /opt/devpipe
chmod 0750 /var/lib/devpipe

unit() {
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=$2
After=network.target

[Service]
Type=exec
ExecStart=$3
WorkingDirectory=/opt/devpipe
User=devpipe
Group=devpipe
# Secrets live here rather than in this script, so they stay off the repo and
# survive a redeploy.
#
# DATABASE_URL is required, not optional: the schema is Postgres and there is
# no local-file fallback to boot on. DEVPIPE_SECRET_KEY encrypts agent logins
# at rest; without it the instance stores none, which is the right failure —
# the wrong one would be keeping somebody's Anthropic credentials as plaintext
# while every screen said otherwise.
#
# The leading - is so a missing file is a clear startup error from the API
# rather than a systemd unit that refuses to load and says nothing about why.
EnvironmentFile=-/etc/devpipe.env
$4
Restart=always
RestartSec=2
ProtectSystem=strict
ReadWritePaths=/var/lib/devpipe /opt/devpipe
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT
}

# Email is off until both RESEND_API_KEY and EMAIL_FROM are added to
# /etc/devpipe.env — the emailer prints to the journal instead, which is what a
# password reset does on an instance that has no sending domain yet. Stripe
# keys are not env vars; they go in the admin billing tab.
unit devpipe-api "Devpipe API" /usr/local/bin/devpipe-api \
"Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=APP_URL=https://devpipe.com
Environment=BOX_DOMAIN=devpipe.com"

# Both bind loopback: Caddy is the only route in, and the rate limiter reads
# an address it can only trust when the request has come through it.
unit devpipe-web "Devpipe web" /usr/local/bin/devpipe-web \
"Environment=WEB_PORT=3001
Environment=WEB_HOST=127.0.0.1
Environment=API_URL=http://127.0.0.1:3000
Environment=NODE_ENV=production
Environment=WEB_DIST=/opt/devpipe/src/web/dist
Environment=SITE_DIR=/opt/devpipe/site
Environment=WASM_PATH=/opt/devpipe/vt.wasm"

# Carry the old file-backed waitlist into the database, once. Losing the list
# because the storage changed would be a self-inflicted wound.
OLD=/var/lib/private/waitlist/emails.tsv
if [ -s "$OLD" ] && [ ! -f /var/lib/devpipe/.waitlist-imported ]; then
  cut -f2 "$OLD" > /var/lib/devpipe/waitlist-import.txt
  chown devpipe:devpipe /var/lib/devpipe/waitlist-import.txt
  touch /var/lib/devpipe/.waitlist-imported
  echo "staged $(wc -l < /var/lib/devpipe/waitlist-import.txt) addresses for import"
fi

systemctl daemon-reload
systemctl enable --now devpipe-api devpipe-web >/dev/null 2>&1 || true
systemctl restart devpipe-api devpipe-web
systemctl disable --now waitlist owner >/dev/null 2>&1 || true
rm -f /etc/systemd/system/waitlist.service /etc/systemd/system/owner.service
systemctl daemon-reload
chown -R caddy:caddy /var/www/devpipe
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && echo "caddy ok"
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 3
echo "services: $(systemctl is-active devpipe-api devpipe-web caddy | tr '\n' ' ')"
EOF

echo "==> https://devpipe.com  ·  app at /terminals"
