#!/bin/sh
# Put devpipe on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/wess/devpipe/main/deploy/install.sh | sh
#
# Downloads the release binary for this platform, checks it against the
# published sums, and installs it. Nothing else — provisioning a host is
# deploy/provision.sh, which calls this first.
set -eu

REPO=${DEVPIPE_REPO:-wess/devpipe}
VERSION=${DEVPIPE_VERSION:-latest}
PREFIX=${DEVPIPE_PREFIX:-/usr/local/bin}

say() { printf 'devpipe: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

case "$(uname -s)" in
  Linux)  os=unknown-linux-gnu ;;
  Darwin) os=apple-darwin ;;
  *) die "no build for $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) die "no build for $(uname -m)" ;;
esac
target="$arch-$os"

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
# Including on the failure paths, which is where a leftover half-downloaded
# tarball would otherwise sit.
trap 'rm -rf "$tmp"' EXIT INT TERM

say "fetching devpipe-$target"
curl -fsSL "$base/devpipe-$target.tar.gz" -o "$tmp/devpipe.tar.gz" \
  || die "no release asset for $target at $base"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" \
  || die "the release has no SHA256SUMS; refusing to install unverified"

# A tarball nobody checked is a tarball anyone in the path could have replaced.
want=$(grep " devpipe-$target.tar.gz\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || die "SHA256SUMS does not mention devpipe-$target.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/devpipe.tar.gz" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/devpipe.tar.gz" | cut -d' ' -f1)
fi
[ "$want" = "$got" ] || die "checksum mismatch: expected $want, got $got"

tar -xzf "$tmp/devpipe.tar.gz" -C "$tmp"
[ -f "$tmp/devpipe" ] || die "the tarball has no devpipe in it"
chmod +x "$tmp/devpipe"

# A prefix that does not exist yet is the normal state of ~/.local/bin, not a
# reason to ask for root. Make it when the parent allows, and only escalate for
# somewhere that is genuinely not yours.
if [ ! -d "$PREFIX" ] && mkdir -p "$PREFIX" 2>/dev/null; then
  say "created $PREFIX"
fi

# `dp` is the same binary under a shorter name — a symlink rather than a second
# copy, so an upgrade cannot leave the two disagreeing about the protocol.
if [ -w "$PREFIX" ]; then
  mv "$tmp/devpipe" "$PREFIX/devpipe"
  ln -sf devpipe "$PREFIX/dp"
elif command -v sudo >/dev/null 2>&1; then
  say "$PREFIX needs root"
  sudo mv "$tmp/devpipe" "$PREFIX/devpipe"
  sudo ln -sf devpipe "$PREFIX/dp"
else
  die "cannot write $PREFIX and there is no sudo; set DEVPIPE_PREFIX"
fi

# On the person's own PATH or not — worth knowing before they retype the
# command and wonder why the shell disagrees.
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) say "note: $PREFIX is not on your PATH" ;;
esac

say "installed $("$PREFIX/devpipe" --version), as devpipe and dp"
