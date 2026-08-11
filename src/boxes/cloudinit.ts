import { resolve } from "./catalog.ts"

/**
 * The script a fresh box runs on first boot.
 *
 * cloud-init rather than SSH-ing in afterwards: the API server then needs no
 * private key, no inbound reachability to a half-built machine, and no retry
 * loop waiting for sshd. The box builds itself and reports as it goes.
 *
 * Everything it does is streamed back to the control plane while it happens.
 * A build takes several minutes, and a spinner for that long is
 * indistinguishable from a box that has died — so the log is the interface,
 * and when something fails the last thing it printed is already on screen.
 *
 * Caddy sits in front of the daemon and gets a real Let's Encrypt certificate
 * for the box's own hostname. That is not decoration: iOS App Transport
 * Security evaluates system trust *before* an app's pinning code is consulted
 * and cancels the connection when it fails, so a self-signed certificate can
 * never be rescued by pinning. A CA-issued certificate is the only thing that
 * makes the client work without weakening ATS app-wide.
 */
export const cloudInit = (opts: {
  hostname: string
  agentToken: string
  tools: readonly string[]
  daemonUrl: string
  callbackUrl: string
  logUrl: string
  callbackSecret: string
}): string => {
  const steps = resolve(opts.tools)

  // Each install is allowed to fail without taking the box down with it. A
  // missing editor is a worse outcome as "the box never came up" than as
  // "that one tool is not there".
  const installs = steps
    .map(
      t => `
phase "${t.id}" "Installing ${t.name}"
if ( ${
        t.runAs === "devpipe"
          ? // As the user who will actually run it: an installer that writes
            // into $HOME must write into the right one, or the tool is missing
            // from the terminal's PATH and its credentials are unreachable.
            `runuser -l devpipe -c ${JSON.stringify(t.install)}`
          : t.install
      } ) >>"$LOG" 2>&1; then
  say "[ok] ${t.name}"
else
  say "[!!] ${t.name} did not install"
  echo "${t.id}" >> /var/log/devpipe-setup.failed
fi`,
    )
    .join("\n")

  return `#!/usr/bin/env bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
# Without these the log arrives mangled: with no locale set, Python reads the
# pipe as ASCII and every non-ASCII character in the output is destroyed.
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export PYTHONIOENCODING=utf-8

LOG=/var/log/devpipe-setup.log
CURSOR=/var/lib/devpipe-cursor
# The phase lives in a file, not a variable. The shipper runs in a background
# subshell forked before the first phase is set, so its own copy of a variable
# would stay "boot" forever and overwrite every real phase the parent reported.
PHASE_FILE=/var/lib/devpipe-phase
echo boot > "$PHASE_FILE"
touch "$LOG"
mkdir -p /var/lib
echo 0 > "$CURSOR"

# Ships whatever is new in the log to the control plane. Runs in the
# background on a short interval so output appears while a step is still
# running, rather than in one dump after it finishes.
ship() {
  # Serialised. The background loop and the per-phase flush both read the
  # cursor, and without a lock they send overlapping ranges — which is why
  # every phase header arrived twice on the first real box.
  exec 9>/var/lock/devpipe-ship
  flock -n 9 || return 0
  local sent total chunk lines
  sent=$(cat "$CURSOR" 2>/dev/null || echo 0)
  total=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  [ "$total" -le "$sent" ] && return 0
  # Whole lines only: cutting on a byte count can split a multi-byte character
  # and corrupt the tail of the chunk.
  lines=$(tail -n +$((sent + 1)) "$LOG" | head -n 300 | wc -l)
  chunk=$(tail -n +$((sent + 1)) "$LOG" | head -n 300 | \\
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.buffer.read().decode("utf-8","replace")))' 2>/dev/null || true)
  [ -z "$chunk" ] && return 0
  curl -fsS -m 10 -X POST "${opts.logUrl}" \\
    -H "content-type: application/json" \\
    -H "authorization: Bearer ${opts.callbackSecret}" \\
    -d "{\\"hostname\\":\\"${opts.hostname}\\",\\"phase\\":\\"$(cat "$PHASE_FILE")\\",\\"text\\":\${chunk}}" \\
    >/dev/null 2>&1 && echo "$((sent + lines))" > "$CURSOR"
}

shipper() { while true; do ship; sleep 2; done; }

say()   { echo "$*" >> "$LOG"; }
phase() { echo "$1" > "$PHASE_FILE"; shift; say ""; say "== $* =="; ship; }

# Everything below appends to the log; the shipper carries it up.
exec >>"$LOG" 2>&1

apt-get install -y -qq python3 >/dev/null 2>&1 || true
shipper &
SHIPPER=$!

phase "system" "Preparing the system"
say "Host ${opts.hostname}"
apt-get update -qq
# unzip is here because bun's installer needs it and says so only after the
# download: "error: unzip is required to install bun". The Debian image does
# not carry it, so bun failed on every box while every other tool succeeded.
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unzip
say "[ok] base packages"

phase "user" "Creating your account on the box"
# The agent runs as a real user, not root. It is handed a shell and told to
# run whatever it likes; root would make every mistake unrecoverable.
id -u devpipe >/dev/null 2>&1 || useradd --create-home --shell /bin/bash devpipe
usermod -aG sudo devpipe || true
echo "devpipe ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/devpipe
chmod 0440 /etc/sudoers.d/devpipe
# Installers drop binaries in ~/.local/bin and ~/.bun/bin; a login shell has to
# find them or the tool is installed and still "not found".
cat > /etc/profile.d/devpipe-path.sh <<'PATHEOF'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
PATHEOF
chmod 0644 /etc/profile.d/devpipe-path.sh
grep -q devpipe-path /home/devpipe/.bashrc 2>/dev/null || \
  echo '. /etc/profile.d/devpipe-path.sh' >> /home/devpipe/.bashrc
chown devpipe:devpipe /home/devpipe/.bashrc
say "[ok] user devpipe"
${installs}

phase "daemon" "Installing the Devpipe daemon"
curl -fsSL "${opts.daemonUrl}" -o /usr/local/bin/devpiped
chmod 0755 /usr/local/bin/devpiped
# Deliberately does not run the binary to get a version string: devpiped
# ignores argv and starts serving, so a command substitution around it never
# returns and setup hangs here forever.
say "[ok] devpiped installed ($(stat -c %s /usr/local/bin/devpiped) bytes)"

mkdir -p /etc/devpipe
cat > /etc/devpipe/env <<'ENVEOF'
DEVPIPE_ADDR=127.0.0.1:7788
DEVPIPE_TOKEN=${opts.agentToken}
DEVPIPE_INSECURE=1
# The daemon execs a tool by name — "claude", "codex" — so it needs the
# directories the installers actually write to. /etc/profile.d/devpipe-path.sh
# does not reach it: that is sourced by login shells, and the daemon is a
# systemd service with the unit default PATH. Every tool installed into $HOME
# was therefore present on the box and unreachable from the button that starts
# it, while opening a shell and typing the same name worked — which is what
# made it look like a network fault rather than a missing PATH.
PATH=/home/devpipe/.local/bin:/home/devpipe/.bun/bin:/home/devpipe/.cargo/bin:/home/devpipe/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENVEOF
chmod 0600 /etc/devpipe/env

cat > /etc/systemd/system/devpiped.service <<'UNITEOF'
[Unit]
Description=Devpipe terminal daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/devpiped
EnvironmentFile=/etc/devpipe/env
User=devpipe
Group=devpipe
WorkingDirectory=/home/devpipe
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now devpiped
sleep 1
if systemctl is-active --quiet devpiped; then say "[ok] daemon running"; else
  say "[!!] daemon failed to start"
  journalctl -u devpiped -n 20 --no-pager
fi

phase "dns" "Waiting for this box's name to resolve"
# Caddy asks Let's Encrypt over HTTP-01, which only works once the name points
# here. Starting it early means a failed challenge and a long backoff, so wait
# for DNS first and say so while waiting.
for i in $(seq 1 60); do
  if getent hosts ${opts.hostname} >/dev/null 2>&1; then
    say "[ok] ${opts.hostname} resolves"
    break
  fi
  [ $((i % 5)) -eq 0 ] && say "still waiting for DNS (\${i}0s)"
  sleep 10
done

phase "tls" "Getting a certificate"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

cat > /etc/caddy/Caddyfile <<'CADDYEOF'
${opts.hostname} {
	reverse_proxy 127.0.0.1:7788 {
		# Terminal sessions are long-lived websockets that can sit idle for
		# hours while an agent thinks. The default read timeout would cut them.
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
CADDYEOF

systemctl restart caddy
for i in $(seq 1 30); do
  if curl -fsS -m 5 "https://${opts.hostname}/v1/health" >/dev/null 2>&1; then
    say "[ok] https://${opts.hostname} is answering"
    break
  fi
  [ $((i % 5)) -eq 0 ] && say "waiting for the certificate (\${i}0s)"
  sleep 10
done

phase "done" "Finishing up"
FAILED=""
if [ -s /var/log/devpipe-setup.failed ]; then
  FAILED=$(tr '\\n' ',' < /var/log/devpipe-setup.failed)
  say "Some tools did not install: $FAILED"
else
  say "Everything installed."
fi
say "Your box is ready."

ship
kill $SHIPPER 2>/dev/null || true
ship

curl -fsS -m 15 -X POST "${opts.callbackUrl}" \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer ${opts.callbackSecret}" \\
  -d "{\\"hostname\\":\\"${opts.hostname}\\",\\"failed\\":\\"\${FAILED}\\"}" || true
`
}
