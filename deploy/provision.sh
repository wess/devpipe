#!/bin/sh
# Turn a fresh Linux box into a Devpipe host.
#
#   ssh box 'curl -fsSL https://raw.githubusercontent.com/wess/devpipe/main/deploy/provision.sh | sh'
#
# Installs a container runtime if there is none, installs devpipe, and starts
# it as a user service bound to loopback. Reaching it from your laptop is
# `devpipe --ssh box`, which is why nothing here opens a port.
set -eu

REPO=${DEVPIPE_REPO:-wess/devpipe}
BRANCH=${DEVPIPE_BRANCH:-main}
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"

say() { printf 'devpipe: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[ "$(uname -s)" = Linux ] || die "provision.sh is for a Linux host; on a Mac just run devpipe serve"
[ "$(id -u)" != 0 ] || die "run this as the user who will own the environments, not as root"
command -v systemctl >/dev/null 2>&1 || die "this expects systemd"

if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
  say "installing docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  # The group is granted to new logins, not to this shell, and the daemon that
  # starts below would otherwise fail on a permission error that reads like a
  # missing docker.
  say "you have been added to the docker group; log out and back in before starting a session"
fi

curl -fsSL "$RAW/deploy/install.sh" | sh

mkdir -p "$HOME/.config/systemd/user"
curl -fsSL "$RAW/deploy/devpipe.service" -o "$HOME/.config/systemd/user/devpipe.service"

# Without lingering, a user service stops at logout — which is every time you
# close the ssh session you started it from.
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now devpipe

say "waiting for the host to write its token"
i=0
while [ ! -s "$HOME/.devpipe/token" ]; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || die "it never came up; systemctl --user status devpipe"
  sleep 0.2
done

say "up. from your laptop:"
say "  export DEVPIPE_SSH=$(id -un)@$(hostname)"
say "  devpipe env new myproject --repo git@github.com:you/myproject.git"
say "  devpipe attach --env myproject"
