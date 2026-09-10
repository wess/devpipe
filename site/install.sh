#!/usr/bin/env sh
# Put `devpipe` on this machine.
#
#   curl -fsSL https://devpipe.com/install.sh | sh
#
# Deliberately POSIX sh and deliberately short. This is the first thing anyone
# runs, on a machine that has nothing on it yet, and a script that needs bash 4
# or jq to install a single static binary has already failed the only test that
# matters.
#
# It refuses rather than guesses. A wrong binary silently downloaded is worse
# than a sentence naming the platform we do not have.
set -eu

BASE="${DEVPIPE_BASE:-https://devpipe.com}"
DEST="${DEVPIPE_BIN:-}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) asset="devpipe-macos" ;;   # universal: one file, both architectures
  Linux)
    case "$arch" in
      x86_64|amd64) asset="devpipe" ;;
      *) echo "devpipe: no Linux build for $arch yet. Ask, and it will exist." >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "devpipe: no build for $os. On Windows, WSL runs the Linux one." >&2
    exit 1
    ;;
esac

# Somewhere already on PATH, and writable without sudo where possible: an
# installer that needs root to drop one file in is asking for more trust than
# it needs.
if [ -z "$DEST" ]; then
  if [ -w "/usr/local/bin" ] 2>/dev/null; then
    DEST="/usr/local/bin/devpipe"
  else
    DEST="$HOME/.local/bin/devpipe"
    mkdir -p "$HOME/.local/bin"
  fi
fi

echo "Fetching ${asset}..."
# To a temporary file first. Writing straight to the destination means a
# half-downloaded binary replaces a working one when the network drops.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$BASE/dist/$asset" -o "$tmp"
chmod 0755 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT

echo "Installed $DEST"
case ":$PATH:" in
  *":$(dirname "$DEST"):"*) ;;
  *) echo "Note: $(dirname "$DEST") is not on your PATH." ;;
esac
echo
echo "  devpipe login"
echo "  devpipe attach <box>"
