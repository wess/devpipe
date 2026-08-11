#!/usr/bin/env bash
# What a box actually costs in memory, so the droplet size is a measurement
# rather than a guess.
#
# The 512MB tier is the cheapest thing DigitalOcean sells and the only per-box
# cost that scales with customers, so it is worth knowing exactly what fits.
# The failure mode if it does not is the OOM killer ending a session
# mid-task — which looks like a random disconnect, not like running out of
# memory, and would be miserable to diagnose from a bug report.
#
# Usage: measure.sh <host> [ssh-key]
set -euo pipefail

HOST="${1:?usage: measure.sh <host> [ssh-key]}"
KEY="${2:-$HOME/.ssh/id_rsa}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST")

"${SSH[@]}" "bash -s" <<'EOF'
set -euo pipefail
say() { printf '%-28s %s\n' "$1" "$2"; }

total=$(free -m | awk 'NR==2{print $2}')
say "total memory" "${total} MB"
say "idle used" "$(free -m | awk 'NR==2{print $3}') MB"
say "devpiped rss" "$(ps -o rss= -C devpiped 2>/dev/null | awk '{s+=$1} END{printf "%d MB", s/1024}')"

# Peak is what matters: an average that fits tells you nothing about the
# moment an agent reads a large file and the kernel starts choosing victims.
if command -v claude >/dev/null || [ -x /root/.local/bin/claude ]; then
  say "claude binary" "$(du -sh /root/.local/share/claude 2>/dev/null | cut -f1)"
fi

say "swap" "$(free -m | awk 'NR==3{print $2}') MB"
say "oom kills so far" "$(dmesg 2>/dev/null | grep -ci 'out of memory' || echo 0)"
echo
echo "headroom on this box: $(free -m | awk 'NR==2{print $7}') MB available"
EOF
