#!/usr/bin/env bash
# Create a droplet and install the daemon on it.
#
# Needs DIGITAL_OCEAN_API in the environment. Locally that comes from Synapse:
#   synapse run -- deploy/provision.sh
#
# Usage: provision.sh [name]
set -euo pipefail

NAME="${1:-devpipe-$(date +%s)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Smallest first, always. A Devpipe box runs one agent CLI and a shell, not a
# fleet, and the size is the only thing on the bill that scales per customer.
#
# 512MB ($4) is the floor DigitalOcean offers. It has not been proven to hold
# an agent CLI under load, and the failure mode is the OOM killer taking the
# session mid-task, which reads as a random disconnect rather than as running
# out of memory. Measure before trusting it: `deploy/measure.sh`.
SIZE="${DEVPIPE_SIZE:-s-1vcpu-512mb-10gb}"
REGION="${DEVPIPE_REGION:-nyc3}"
IMAGE="${DEVPIPE_IMAGE:-debian-13-x64}"
SSH_KEY_ID="${DEVPIPE_SSH_KEY_ID:?set DEVPIPE_SSH_KEY_ID to a key id from /v2/account/keys}"

API="https://api.digitalocean.com/v2"
AUTH="Authorization: Bearer ${DIGITAL_OCEAN_API:?not in environment}"

echo "==> creating $NAME ($SIZE, $IMAGE, $REGION)"
ID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$API/droplets" -d "{
  \"name\": \"$NAME\",
  \"region\": \"$REGION\",
  \"size\": \"$SIZE\",
  \"image\": \"$IMAGE\",
  \"ssh_keys\": [$SSH_KEY_ID],
  \"tags\": [\"devpipe\"]
}" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
test -n "$ID" || { echo "no droplet id returned"; exit 1; }
echo "    id $ID"

echo "==> waiting for an address"
for _ in $(seq 1 30); do
  J=$(curl -s -H "$AUTH" "$API/droplets/$ID")
  IP=$(echo "$J" | grep -o '"ip_address":"[0-9.]*"' | head -1 | cut -d'"' -f4)
  ST=$(echo "$J" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = "active" ] && [ -n "$IP" ] && break
  sleep 6
done
test -n "${IP:-}" || { echo "droplet never came up"; exit 1; }
echo "    $IP"

echo "==> waiting for ssh"
for _ in $(seq 1 30); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "root@$IP" true 2>/dev/null && break
  sleep 6
done

"$ROOT/deploy/deploy.sh" "$IP"
echo
echo "destroy it with:"
echo "  curl -X DELETE -H \"\$AUTH\" $API/droplets/$ID"
