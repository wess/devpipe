import * as ocean from "./digitalocean.ts"
import { bakedIds, bakeScript, imageName } from "./image.ts"

/**
 * Builds the box image, from a throwaway droplet.
 *
 * Deliberately a command somebody runs rather than something the control plane
 * does on a schedule. Baking costs a droplet-hour, produces a snapshot that is
 * charged for until deleted, and wants somebody to look at the result before
 * every new box is built from it.
 *
 * Usage: bun src/boxes/bake.ts <do-token> [region]
 */

const log = (line: string) => console.log(`[bake] ${line}`)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const bake = async (
  token: string,
  opts: { region?: string; sshKeyIds?: number[]; size?: string } = {},
): Promise<{ imageId: number; name: string; tools: string[] }> => {
  const region = opts.region ?? "nyc3"
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const name = imageName(stamp)
  const tools = bakedIds()

  log(`building ${name} in ${region} with ${tools.length} tools`)

  // **Disk, not speed, decides this.** A snapshot carries the disk size of the
  // droplet it was taken from, and DigitalOcean refuses to create a droplet
  // with a smaller disk than its image — so an image baked on a big machine
  // cannot boot any of the small ones. The first bake used `s-2vcpu-4gb` for
  // speed, produced an 80 GB image, and made every size a person would actually
  // choose fail with "Cannot create a droplet with a smaller disk than the
  // image."
  //
  // So bake on the smallest size a box can usefully be. That is 1 GB / 25 GB:
  // the 512 MB tier exists in the catalog but `fits()` already refuses to put
  // claude-code on it, so nothing below this is a real target. The bake takes
  // longer on a smaller machine, and that is the correct trade — it runs once,
  // and the alternative is an image nothing can use.
  const droplet = await ocean.createDroplet(token, {
    name: `bake-${stamp}`,
    region,
    size: opts.size ?? "s-1vcpu-1gb",
    sshKeyIds: opts.sshKeyIds ?? [],
    // The bake script runs as user data, so the machine builds itself and
    // needs no inbound access at all.
    userData: `#!/usr/bin/env bash
${bakeScript()}
# The signal the poller below waits for. Written last so its presence means the
# whole script ran, not that it started.
echo done > /var/lib/bake.finished
poweroff
`,
    tags: ["devpipe-bake"],
  })
  log(`droplet ${droplet.id} created, installing…`)

  try {
    // The script powers the machine off when it is done, so "off" is the
    // completion signal. Polling that beats polling for a file we cannot read
    // without SSH access this command does not require.
    let off = false
    for (let i = 0; i < 120; i++) {
      await wait(15_000)
      const current = await ocean.getDroplet(token, droplet.id)
      if (current?.status === "off") {
        off = true
        break
      }
      if (i % 4 === 0) log(`still installing (${(i + 1) * 15}s)`)
    }
    if (!off) throw new Error("the bake did not finish within 30 minutes")

    log("powered off, taking the snapshot")
    const imageId = await ocean.snapshotDroplet(token, droplet.id, name)
    log(`image ${imageId} ready`)
    return { imageId, name, tools }
  } finally {
    // Always. A bake droplet left running is a machine nobody remembers making
    // that costs money until somebody finds it.
    await ocean.destroyDroplet(token, droplet.id).catch(err => {
      console.error(`[bake] could not destroy the bake droplet ${droplet.id}:`, err)
    })
    log(`bake droplet ${droplet.id} destroyed`)
  }
}

if (import.meta.main) {
  const token = process.argv[2]
  if (!token) {
    console.error("usage: bun src/boxes/bake.ts <do-token> [region]")
    process.exit(1)
  }
  const result = await bake(token, { region: process.argv[3] })
  console.log()
  console.log("Set these in the admin settings, or with SQL:")
  console.log(`  boxes_image       = ${result.imageId}`)
  console.log(`  boxes_image_tools = ${result.tools.join(",")}`)
}
