import { CATALOG, resolve, type Tool } from "./catalog.ts"

/**
 * A box image with the tools already on it.
 *
 * Every box used to install its whole toolchain on first boot: an apt run, a
 * Node runtime, and half a dozen `curl | bash` installers, which is most of the
 * four minutes between clicking create and getting a prompt. None of that work
 * is specific to the box doing it — the same commands produce the same files
 * every time — so it is done once here and the result is a snapshot.
 *
 * This matters more than the wait suggests. A box that takes four minutes to
 * build is a box nobody destroys, which makes reclaiming idle ones something
 * customers resent rather than something they never notice. Fast rebuilds are
 * what make a disposable box actually disposable.
 *
 * What is deliberately *not* baked in: anything belonging to a person or a
 * machine. Agent logins, the daemon's token, the hostname, SSH host keys and
 * the machine id are all per-box, and an image carrying any of them would hand
 * every future box the first one's identity.
 */

/** Tools worth baking: everything installable, in dependency order. */
export const bakedTools = (): Tool[] => resolve(CATALOG.map(t => t.id))

/** The tool ids an image built now would contain. */
export const bakedIds = (): string[] => bakedTools().map(t => t.id)

/**
 * Names carry the date because snapshots are kept, not replaced.
 *
 * A rebuilt image is a new snapshot; the old one stays until somebody deletes
 * it, and two called "devpipe-box" is a coin toss over which one boxes are
 * being created from.
 */
export const imageName = (stamp: string) => `devpipe-box-${stamp}`

/**
 * The script that turns a plain droplet into the image.
 *
 * Runs as root on a throwaway machine. The `devpipe` user is created here
 * because installers that run as that user write into its home, and that home
 * is what gets baked — cloud-init later reuses the same uid rather than making
 * a second one.
 */
export const bakeScript = (): string => {
  const installs = bakedTools()
    .map(
      t => `
echo "==> ${t.name}"
if ( ${t.runAs === "devpipe" ? `runuser -l devpipe -c ${JSON.stringify(t.install)}` : t.install} ) >>/var/log/bake.log 2>&1; then
  echo "    ok"
else
  # A tool that will not install must fail the bake. Baking it broken means
  # every box built from this image is missing it, silently, until somebody
  # tries to run it.
  echo "    FAILED"
  echo "${t.id}" >> /var/log/bake.failed
fi`,
    )
    .join("\n")

  return `#!/usr/bin/env bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
# The first boot of a fresh droplet runs unattended-upgrades; every apt call
# here waits for it rather than racing it.
APT="apt-get -o DPkg::Lock::Timeout=900 -qq"

echo "==> base packages"
$APT update >/dev/null
$APT install -y curl ca-certificates git unzip jq >/dev/null

# Same account cloud-init will use later, so everything installed into its home
# is found by the person who ends up owning it.
id -u devpipe >/dev/null 2>&1 || useradd --create-home --shell /bin/bash devpipe
${installs}

echo "==> shrinking"
$APT autoremove -y >/dev/null 2>&1 || true
$APT clean >/dev/null 2>&1 || true
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* 2>/dev/null || true
find /var/log -type f -exec truncate -s 0 {} \\; 2>/dev/null || true

# Identity is per box, never per image.
#
# SSH host keys baked into an image mean every box presents the same key, so
# a warning about a changed key stops meaning anything. The machine id is worse
# in a quieter way: systemd derives unit state and journal identity from it, and
# duplicates across a fleet are the sort of thing that is diagnosed weeks later.
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
cloud-init clean --logs >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/devpipe/.bash_history

if [ -s /var/log/bake.failed ]; then
  echo "BAKE FAILED: $(tr '\\n' ' ' < /var/log/bake.failed)"
  exit 1
fi
echo "BAKE OK"
`
}
