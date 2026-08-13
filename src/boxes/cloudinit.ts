import { shellPath } from "../util/shell.ts"
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
  /** Where a box fetches and stores the account's agent logins. */
  loginsUrl: string
  callbackSecret: string
  /**
   * The box's vault credential, and where to spend it.
   *
   * Readable by the box's user rather than root-only, because the thing that
   * needs it is the agent, and an agent that cannot read it cannot use the
   * vault at all. That is not a weakness being accepted quietly: this token
   * authorises one box's own scope chain, never reads a secret it was not
   * explicitly granted, and dies with the box. See `src/vault/box.ts`.
   */
  vaultToken?: string
  vaultUrl?: string
  /** Where the box fetches the `devpipe` CLI and MCP server. */
  cliUrl?: string
  /** Login shell for the box's user. Bash when unset. */
  shell?: string
  /** Whether this box carries the account's Synapse memory. */
  synapse?: boolean
  /** DigitalOcean volume name, when a workspace is attached. */
  volumeName?: string
  /**
   * Tool ids already present in the image this box boots from.
   *
   * Passed rather than assumed: an image is baked at a point in time, and a
   * tool added to the catalog afterwards is genuinely not on it. Taking the
   * list from the catalog instead would skip installing something that is not
   * there, which fails as "the tool is missing" long after the box came up.
   */
  preinstalled?: readonly string[]
}): string => {
  const steps = resolve(opts.tools)
  // Only the logins for tools this box actually has. A watcher on a path that
  // will never exist is not harmful, but it is noise in a unit list somebody
  // will one day read while trying to work out what a box does.
  const loginFiles = steps.flatMap(t => (t.credentials ?? []).map(path => ({ tool: t.id, path })))
  const shell = shellPath(opts.shell ?? "bash")

  // Each install is allowed to fail without taking the box down with it. A
  // missing editor is a worse outcome as "the box never came up" than as
  // "that one tool is not there".
  const baked = new Set(opts.preinstalled ?? [])
  const installs = steps
    .filter(t => !baked.has(t.id))
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

phase "policy" "Setting what this box will install"
# Peer-to-peer clients are pinned out of reach.
#
# This is friction, not a boundary, and it is worth being honest about which:
# the account here has passwordless sudo by design, so anyone who means to get
# past this can delete this file — never mind curl|bash, a static binary, a
# container, or the same clients from npm and pip. It stops nobody determined.
#
# It is still worth having, because the person it stops is not determined. The
# realistic case is a customer who types "apt install transmission-daemon"
# because it was the first thing that came to mind, and a box that answers "no"
# is usually the end of it. What that prevents is a DMCA notice arriving at the
# provider account every customer's box is created under — where the remedy is
# to lock the account, and one person's torrenting costs everyone their
# machine. Same shape as the mail block in the firewall, one layer up.
mkdir -p /etc/apt/preferences.d
cat > /etc/apt/preferences.d/devpipe-p2p <<'PINEOF'
Package: transmission* deluge* rtorrent qbittorrent* amule* mldonkey* aria2
Pin: release *
Pin-Priority: -1
PINEOF
chmod 0644 /etc/apt/preferences.d/devpipe-p2p
say "[ok] peer-to-peer clients are not installable from the archive"

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
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.opencode/bin:$PATH"
PATHEOF
chmod 0644 /etc/profile.d/devpipe-path.sh
# Fish is not a POSIX shell and does not read profile.d at all, so the file
# above is invisible to it. Without this a fish box has no ~/.local/bin on the
# PATH of any login shell, and every agent CLI is "unknown command" while being
# installed and perfectly runnable — the same failure the daemon's own PATH was
# added to fix, one shell over.
mkdir -p /etc/fish/conf.d
cat > /etc/fish/conf.d/devpipe-path.fish <<'FISHEOF'
for dir in $HOME/.local/bin $HOME/.bun/bin $HOME/.cargo/bin $HOME/go/bin $HOME/.opencode/bin
    if not contains $dir $PATH
        set -gx PATH $dir $PATH
    end
end
FISHEOF
chmod 0644 /etc/fish/conf.d/devpipe-path.fish
# Zsh has the same problem as fish and was missed: Debian's /etc/zsh/zprofile
# does not source /etc/profile, so profile.d never runs for a zsh login. A box
# created with the zsh shell therefore had claude, bun and cargo installed and
# invisible over SSH — found by making a real box and looking, not by reading.
#
# zshenv rather than zprofile: it is read by *every* zsh, login or not, so a
# non-login 'ssh box command' sees the tools too.
mkdir -p /etc/zsh
cat > /etc/zsh/zshenv <<'ZSHEOF'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.opencode/bin:$PATH"
ZSHEOF
chmod 0644 /etc/zsh/zshenv
grep -q devpipe-path /home/devpipe/.bashrc 2>/dev/null || \
  echo '. /etc/profile.d/devpipe-path.sh' >> /home/devpipe/.bashrc
chown devpipe:devpipe /home/devpipe/.bashrc
say "[ok] user devpipe"
${
  opts.volumeName
    ? `
phase "workspace" "Mounting your workspace"
# Storage that was here before this box and will outlive it.
#
# After the account exists, not before. Mounting first means creating
# /home/devpipe as root to hold the mountpoint, and useradd then declines to
# fix a home directory it did not create — leaving the agent unable to write to
# its own home, with a workspace it also does not own.
#
# Never formatted. The volume is created with a filesystem already on it, so
# there is nothing here that needs to make one — and a mkfs on this path is the
# one command in this whole script that destroys something irreplaceable. If the
# device is missing the box carries on without it: an empty /home/devpipe/work
# is a bad afternoon, a reformatted one is somebody's work gone.
DEV=/dev/disk/by-id/scsi-0DO_Volume_${opts.volumeName}
mkdir -p /home/devpipe/work
for i in $(seq 1 30); do
  [ -b "$DEV" ] && break
  sleep 2
done
if [ -b "$DEV" ]; then
  if mount -o discard,defaults,noatime "$DEV" /home/devpipe/work; then
    # By id, not by device name: /dev/sda ordering is not stable across boots,
    # and an fstab that mounts the wrong disk here is worse than one that fails.
    grep -q "$DEV" /etc/fstab || echo "$DEV /home/devpipe/work ext4 discard,defaults,noatime,nofail 0 2" >> /etc/fstab
    # The mounted root, not the mountpoint underneath it: a volume that has been
    # on an earlier box comes with its own ownership, and a first-time one is
    # root-owned from mkfs. Either way the agent has to own what it works in.
    chown devpipe:devpipe /home/devpipe/work
    say "[ok] workspace mounted at ~/work ($(df -h /home/devpipe/work | tail -1 | awk '{print $2}'))"
  else
    say "[!!] the workspace device is here but would not mount — leaving it alone rather than formatting it"
  fi
else
  say "[!!] the workspace never appeared; this box has a plain ~/work directory"
fi`
    : ""
}
${
  opts.vaultToken && opts.vaultUrl
    ? `
phase "vault" "Wiring this box into your vault"
mkdir -p /etc/devpipe
cat > /etc/devpipe/vault.env <<'VAULTEOF'
DEVPIPE_VAULT_URL=${opts.vaultUrl}
DEVPIPE_VAULT_TOKEN=${opts.vaultToken}
VAULTEOF
# 0640 root:devpipe, not 0600 root-only. The agent is what needs this, and a
# credential it cannot read is a vault it cannot use. Narrow rather than hidden:
# this token reaches one box's own scope chain, never reads a secret it was not
# granted, and stops working the moment the box is destroyed.
chown root:devpipe /etc/devpipe/vault.env
chmod 0640 /etc/devpipe/vault.env
# Exported for login shells so \`devpipe\` and its MCP server just work, without
# every agent having to be told where the credential lives.
cat > /etc/profile.d/devpipe-vault.sh <<'VAULTSHEOF'
set -a
[ -r /etc/devpipe/vault.env ] && . /etc/devpipe/vault.env
set +a
VAULTSHEOF
chmod 0644 /etc/profile.d/devpipe-vault.sh
say "[ok] vault credential installed"
${
  opts.cliUrl
    ? `curl -fsSL "${opts.cliUrl}" -o /usr/local/bin/devpipe
chmod 0755 /usr/local/bin/devpipe
# Registered for Claude Code so an agent finds the vault without being told it
# exists. Written to the box user's config rather than a system path: this is
# their tool, and the daemon runs as root.
sudo -u devpipe mkdir -p /home/devpipe/.config/claude
sudo -u devpipe tee /home/devpipe/.config/claude/mcp.json >/dev/null <<'MCPEOF'
{ "mcpServers": { "devpipe": { "command": "/usr/local/bin/devpipe", "args": ["mcp"] } } }
MCPEOF
say "[ok] devpipe CLI installed ($(stat -c %s /usr/local/bin/devpipe) bytes)"`
    : ""
}`
    : ""
}
${installs}

phase "shell" "Setting your login shell"
# After the installs, because the shell may be one of them. Checked rather
# than assumed: chsh to a binary that is not there leaves an account whose
# login shell does not exist, and every session on the box fails from then on
# with nothing saying why.
if [ -x "${shell}" ]; then
  chsh -s "${shell}" devpipe && say "[ok] login shell is ${shell}"
else
  say "[!!] ${shell} is not installed — leaving the login shell as /bin/bash"
fi

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
PATH=/home/devpipe/.local/bin:/home/devpipe/.bun/bin:/home/devpipe/.cargo/bin:/home/devpipe/go/bin:/home/devpipe/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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

phase "logins" "Restoring your agent logins"
# Signing in to an agent again on every new box is the most tedious part of
# destroying one, and it is what stops "destroy and recreate" from being the
# cheap act the stored manifest is meant to make it.
#
# Fetched from the control plane over TLS rather than baked into user data:
# the provider keeps user data and serves it to anything on the box that can
# reach the metadata service, which is no place for a credential that reaches
# somebody's Anthropic account.
LOGINS=$(curl -fsS -m 20 -H "authorization: Bearer ${opts.callbackSecret}" \
  "${opts.loginsUrl}?hostname=${opts.hostname}" 2>/dev/null || echo '{"files":[]}')
RESTORED=$(echo "$LOGINS" | python3 - <<'PYEOF'
import json, os, sys, pathlib
home = "/home/devpipe"
try:
    files = json.load(sys.stdin).get("files", [])
except Exception:
    files = []
n = 0
for f in files:
    # Never outside the home directory, whatever the control plane said.
    rel = os.path.normpath(f.get("path", ""))
    if rel.startswith("/") or rel.startswith(".."):
        continue
    dest = pathlib.Path(home) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(f.get("content", ""))
    # A login is readable by its owner and nobody else.
    os.chmod(dest, 0o600)
    n += 1
print(n)
PYEOF
)
chown -R devpipe:devpipe /home/devpipe 2>/dev/null || true
if [ "$RESTORED" -gt 0 ] 2>/dev/null; then
  say "[ok] restored $RESTORED login file(s) — you should not have to sign in again"
else
  say "no stored logins yet; signing in once will carry to your next box"
fi

# Push a login back up whenever it changes, so the next box gets the current
# one. A path unit rather than a timer: a login changes on sign-in and on token
# refresh, both of which are events, and polling a file that changes twice a
# month is a poor trade.
cat > /usr/local/bin/devpipe-save-login <<'SAVEEOF'
#!/usr/bin/env bash
# usage: devpipe-save-login <tool> <path-relative-to-home>
set -uo pipefail
FILE="/home/devpipe/$2"
[ -s "$FILE" ] || exit 0
python3 - "$1" "$2" "$FILE" <<'PYEOF' | curl -fsS -m 20 -X POST \
  -H "content-type: application/json" \
  -H "authorization: Bearer $DEVPIPE_CALLBACK_SECRET" \
  --data-binary @- "$DEVPIPE_LOGINS_URL" >/dev/null 2>&1 || true
import json, sys
tool, path, file = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "hostname": __import__("os").environ["DEVPIPE_HOSTNAME"],
    "tool": tool,
    "path": path,
    "content": open(file, encoding="utf-8", errors="replace").read(),
}))
PYEOF
SAVEEOF
chmod 0755 /usr/local/bin/devpipe-save-login

cat > /etc/devpipe/logins.env <<'LOGINENVEOF'
DEVPIPE_CALLBACK_SECRET=${opts.callbackSecret}
DEVPIPE_LOGINS_URL=${opts.loginsUrl}
DEVPIPE_HOSTNAME=${opts.hostname}
LOGINENVEOF
chmod 0600 /etc/devpipe/logins.env
${loginFiles
  .map(
    (f, i) => `
cat > /etc/systemd/system/devpipe-login-${i}.service <<'UNITEOF'
[Unit]
Description=Save the ${f.tool} login
[Service]
Type=oneshot
EnvironmentFile=/etc/devpipe/logins.env
ExecStart=/usr/local/bin/devpipe-save-login ${f.tool} ${f.path}
UNITEOF
cat > /etc/systemd/system/devpipe-login-${i}.path <<'PATHUNITEOF'
[Unit]
Description=Watch the ${f.tool} login
[Path]
PathModified=/home/devpipe/${f.path}
Unit=devpipe-login-${i}.service
[Install]
WantedBy=multi-user.target
PATHUNITEOF
systemctl enable --now devpipe-login-${i}.path >/dev/null 2>&1 || true`,
  )
  .join("\n")}
say "[ok] logins will follow you to your next box"
${
  opts.synapse
    ? `
phase "synapse" "Bringing your project memory"
# The same encrypted path the agent logins came down. Synapse then carries the
# decisions and conventions this account has already recorded, so an agent on a
# box that was created ninety seconds ago starts knowing what one on the laptop
# knows — which is the whole reason to want it here rather than a second, empty
# store per box.
if [ -f /home/devpipe/.config/synapse/sync.json ]; then
  say "[ok] project memory is configured"
else
  say "no Synapse configuration stored yet — set one up and the next box will have it"
fi`
    : ""
}

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
