#!/usr/bin/env bash
# Put the website on devpipe.com.
#
#   site/deploy.sh
#
# Pages, fonts, the two installers, the app, and the Caddyfile. Nothing else:
# the API and web tiers on that box are the previous generation of Devpipe and
# are deployed from `41faab2`, not from this tree. Touching them from here
# would mean rebuilding a Bun control plane that the 2026-08-28 reset removed
# on purpose.
#
# Caddy is validated before it is reloaded and the old config is kept, because
# a Caddyfile that does not parse takes the whole site down and this script is
# the only thing standing between a typo and that.
set -euo pipefail

HOST="${DEVPIPE_HOST:-138.197.68.44}"
KEY="${DEVPIPE_KEY:-$HOME/.ssh/id_rsa}"
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SITE/.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST")
SCP=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

say() { printf '==> %s\n' "$*"; }

say "checking the pages exist before touching anything"
PAGES=(index.html terms.html privacy.html aup.html self-host.html lander.js site.css)
for page in "${PAGES[@]}"; do
  [ -f "$SITE/$page" ] || { echo "missing $SITE/$page" >&2; exit 1; }
done
[ -f "$ROOT/deploy/install.sh" ] || { echo "missing deploy/install.sh" >&2; exit 1; }
[ -f "$ROOT/deploy/provision.sh" ] || { echo "missing deploy/provision.sh" >&2; exit 1; }

say "the lander"
# Two destinations, and both are load-bearing. Caddy serves /dist and the
# installers straight off /var/www/devpipe, but everything else — the lander
# included — is proxied to the web tier, which reads its pages from
# /opt/devpipe/site. Copying to only one of them deploys a page nobody sees.
"${SSH[@]}" 'mkdir -p /var/www/devpipe/fonts /var/www/devpipe-app/fonts /opt/devpipe/site/fonts'
for page in "${PAGES[@]}"; do
  scp "${SCP[@]}" -q "$SITE/$page" "root@$HOST:/var/www/devpipe/$page"
  scp "${SCP[@]}" -q "$SITE/$page" "root@$HOST:/opt/devpipe/site/$page"
done
scp "${SCP[@]}" -q "$SITE"/fonts/*.woff2 "root@$HOST:/var/www/devpipe/fonts/"
scp "${SCP[@]}" -q "$SITE"/fonts/*.woff2 "root@$HOST:/opt/devpipe/site/fonts/"
"${SSH[@]}" 'chown -R devpipe:devpipe /opt/devpipe/site'

# The installers are the repo's, not a second copy that drifts from them.
say "the installers"
scp "${SCP[@]}" -q "$ROOT/deploy/install.sh" "root@$HOST:/var/www/devpipe/install.sh"
scp "${SCP[@]}" -q "$ROOT/deploy/provision.sh" "root@$HOST:/var/www/devpipe/provision.sh"

say "the app"
scp "${SCP[@]}" -q "$SITE/app/index.html" "root@$HOST:/var/www/devpipe-app/index.html"
"${SSH[@]}" 'mkdir -p /var/www/devpipe-app/app'
scp "${SCP[@]}" -q "$SITE/app/app.js" "root@$HOST:/var/www/devpipe-app/app/app.js"
# Its own copies: the app is a different origin and cannot reach across.
scp "${SCP[@]}" -q "$SITE/site.css" "root@$HOST:/var/www/devpipe-app/site.css"
scp "${SCP[@]}" -q "$SITE"/fonts/*.woff2 "root@$HOST:/var/www/devpipe-app/fonts/"

say "caddy — validated, then reloaded"
scp "${SCP[@]}" -q "$SITE/Caddyfile" "root@$HOST:/etc/caddy/Caddyfile.new"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
if ! caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/tmp/caddy-check 2>&1; then
  echo "the new Caddyfile does not parse; nothing changed" >&2
  tail -5 /tmp/caddy-check >&2
  rm -f /etc/caddy/Caddyfile.new
  exit 1
fi
# Kept, not overwritten. Reverting is `mv` rather than a redeploy from a laptop
# that may not be to hand.
cp -f /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev
mv -f /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl reload caddy
REMOTE

say "checking what answers"
for url in https://devpipe.com https://devpipe.com/install.sh https://devpipe.com/provision.sh https://app.devpipe.com; do
  printf '    %-36s %s\n' "$url" "$(curl -sIL --max-time 25 -o /dev/null -w '%{http_code}' "$url" || echo unreachable)"
done

# The page, not just a 200. A stale lander answers 200 all day, which is how
# copying it to one of its two homes went unnoticed the first time.
say "checking the lander is the one in this tree"
if curl -s --max-time 25 https://devpipe.com | grep -q "One machine, many environments"; then
  printf '    lander is current\n'
else
  echo "    the lander answered but is not this version — is it served from somewhere else again?" >&2
  exit 1
fi
say "done"
