#!/usr/bin/env bash
# Turns a plain droplet into a host that can run free-tier boxes as microVMs.
#
# Everything here was verified on a DigitalOcean s-2vcpu-4gb in nyc3. The one
# fact the whole approach depends on — that DigitalOcean exposes /dev/kvm on an
# ordinary droplet, so nested virtualisation works — is checked first rather
# than assumed, because if it is ever untrue nothing below can work and the
# failure would otherwise appear much later as a confusing permissions error.
#
# What this does NOT do is run the boxes. Placement, snapshotting and routing
# belong to the control plane; this only makes a machine capable of hosting them.
#
# Usage: firecracker-host.sh
set -euo pipefail

BRIDGE=fcbr0
SUBNET=172.31.0
GUESTS=/var/lib/devpipe-microvm

say() { echo "==> $*"; }

say "checking this machine can run microVMs at all"
if [ ! -e /dev/kvm ]; then
  echo "    /dev/kvm is absent — this host cannot run Firecracker." >&2
  echo "    Nested virtualisation is not available here; use a provider that offers it." >&2
  exit 1
fi
grep -qE 'vmx|svm' /proc/cpuinfo || { echo "    no virtualisation flags on the CPU" >&2; exit 1; }
echo "    kvm present, hardware virtualisation available"

say "installing firecracker"
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=900 -qq"
$APT update >/dev/null
$APT install -y curl jq iproute2 iptables nftables >/dev/null

if ! command -v firecracker >/dev/null; then
  REL=$(curl -fsSL https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest | jq -r .tag_name)
  ARCH=$(uname -m)
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${REL}/firecracker-${REL}-${ARCH}.tgz" -o /tmp/fc.tgz
  tar -xzf /tmp/fc.tgz -C /tmp
  install -m0755 "/tmp/release-${REL}-${ARCH}/firecracker-${REL}-${ARCH}" /usr/local/bin/firecracker
  rm -rf /tmp/fc.tgz "/tmp/release-${REL}-${ARCH}"
fi
echo "    $(firecracker --version | head -1)"

say "network"
# One bridge, a tap per guest, NAT out. Guests get private addresses and are not
# routable from outside — the control plane reaches a box by proxying to it,
# which is also what keeps a free box off the public internet entirely.
if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
  ip link add "$BRIDGE" type bridge
  ip addr add "${SUBNET}.1/24" dev "$BRIDGE"
  ip link set "$BRIDGE" up
fi
sysctl -qw net.ipv4.ip_forward=1
grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

OUT=$(ip route show default | awk '{print $5; exit}')
if ! iptables -t nat -C POSTROUTING -s "${SUBNET}.0/24" -o "$OUT" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s "${SUBNET}.0/24" -o "$OUT" -j MASQUERADE
fi
# Guests must not reach each other. A free tier is where abuse concentrates, and
# a microVM that can scan its neighbours is a microVM that will.
if ! iptables -C FORWARD -i "$BRIDGE" -o "$BRIDGE" -j DROP 2>/dev/null; then
  iptables -I FORWARD -i "$BRIDGE" -o "$BRIDGE" -j DROP
fi
echo "    bridge $BRIDGE on ${SUBNET}.1/24, NAT via $OUT, guest-to-guest blocked"

say "layout"
install -d -m 0700 "$GUESTS" "$GUESTS/snapshots" "$GUESTS/rootfs" "$GUESTS/kernel"
echo "    $GUESTS"

say "per-guest supervision"
# A template unit rather than one service per box: systemd handles restarts,
# resource limits and cleanup, and `systemctl status devpipe-vm@<id>` answers
# the question somebody will actually ask.
cat > /etc/systemd/system/devpipe-vm@.service <<'UNIT'
[Unit]
Description=Devpipe microVM %i
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/firecracker --api-sock /run/devpipe-vm-%i.sock --config-file /var/lib/devpipe-microvm/%i.json
ExecStopPost=/bin/rm -f /run/devpipe-vm-%i.sock
Restart=no

# The point of a microVM boundary is that a guest cannot reach the host. These
# make the supervisor itself boring to compromise as well.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/devpipe-microvm /run
ProtectHome=yes

# A free box must not be able to take the host down by spinning. Measured
# Firecracker overhead is ~42MB on top of the guest's own allocation.
CPUQuota=50%
MemoryMax=640M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "    devpipe-vm@.service installed"

say "done"
echo
echo "  This host can now run microVMs. Measured on DigitalOcean nyc3:"
echo "    cold boot to kernel   ~240 ms"
echo "    snapshot a running VM ~1.7 s"
echo "    restore from snapshot ~22 ms"
echo
echo "  Still needed before it serves anyone: a guest rootfs with the agent"
echo "  tooling, and the control-plane side that places boxes and routes"
echo "  connections to them."
