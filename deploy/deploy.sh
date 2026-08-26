#!/usr/bin/env bash
# Build the daemon for Linux and install it on a host over ssh.
#
# The binary is cross-built in a container rather than on the target: a box
# that hands out shells has no business also carrying a Rust toolchain, and
# building in the same image every time makes the result reproducible.
#
# Usage: deploy/deploy.sh <host> [ssh-key]
set -euo pipefail

HOST="${1:?usage: deploy.sh <host> [ssh-key]}"
KEY="${2:-$HOME/.ssh/id_rsa}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$(dirname "$ROOT")"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST")
SCP_KEY=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "==> building devpiped for linux/amd64"
docker run --rm --platform linux/amd64 \
  -v "$DEV":/work -w /work/"$(basename "$ROOT")"/daemon \
  -e CARGO_TARGET_DIR=/work/"$(basename "$ROOT")"/target-linux \
  rust:bookworm bash -c "cargo build --release --bin devpiped" >/dev/null
BIN="$ROOT/target-linux/release/devpiped"
test -x "$BIN" || { echo "build produced no binary"; exit 1; }

echo "==> token"
# Generated here, not on the box, so it can be handed to the client without
# reading it back off a machine that may not be trusted yet.
TOKEN="${DEVPIPE_TOKEN:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

echo "==> installing on $HOST"
scp "${SCP_KEY[@]}" -q "$BIN" "root@$HOST:/usr/local/bin/devpiped.new"
scp "${SCP_KEY[@]}" -q "$ROOT/deploy/devpiped.service" "root@$HOST:/etc/systemd/system/devpiped.service"

"${SSH[@]}" "bash -s" <<EOF
set -euo pipefail
install -m 0755 /usr/local/bin/devpiped.new /usr/local/bin/devpiped
rm -f /usr/local/bin/devpiped.new

mkdir -p /etc/devpipe
# The public address goes into the certificate so tools that check hostnames
# can reach the box too; a pinning client does not care either way.
cat > /etc/devpipe/env <<ENV
DEVPIPE_ADDR=0.0.0.0:7788
DEVPIPE_TLS_DIR=/var/lib/devpipe/tls
DEVPIPE_TOKEN=$TOKEN
DEVPIPE_SANS=$HOST
ENV
chmod 0600 /etc/devpipe/env

systemctl daemon-reload
systemctl enable --now devpiped >/dev/null 2>&1 || systemctl restart devpiped
sleep 2
systemctl is-active devpiped
EOF

echo "==> fingerprint"
"${SSH[@]}" "journalctl -u devpiped -n 40 --no-pager | grep -A2 'pin this' | tail -2"

echo
echo "connect with:"
echo "  DEVPIPE_DIRECT=wss://$HOST:7788 DEVPIPE_TOKEN=$TOKEN devpipe attach box"
