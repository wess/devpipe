/**
 * What DigitalOcean is billing for that Devpipe does not account for.
 *
 *   bun run sweep              # report, change nothing
 *   bun run sweep --destroy    # delete what it found
 *
 * The default is a report because the failure modes are not symmetric: a leaked
 * droplet costs a few dollars a month, and a wrongly deleted one costs somebody
 * their work. Read the list before passing `--destroy`.
 *
 * Only resources Devpipe created are ever considered — droplets carrying
 * `devpipe-box`, volumes named `dp-*`, and A records that are not on the
 * protected list. See `src/boxes/orphans.ts` for why each of those fences is
 * where it is.
 */

import { connect } from "@atlas/db"
import { deleteRecordById, destroyDroplet, destroyVolume } from "../src/boxes/digitalocean.ts"
import { findOrphans, orphanSpend } from "../src/boxes/orphans.ts"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../src/settings/index.ts"

const destroy = process.argv.includes("--destroy")

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set. This reads the same database the API does.")
  process.exit(2)
}

const db = connect({ driver: "postgres", url })
const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
if (!token) {
  console.error("No DigitalOcean token is configured on this instance.")
  process.exit(2)
}

const orphans = await findOrphans(db, token)

if (orphans.length === 0) {
  console.log("Nothing unaccounted for. Every box, volume and record has a row behind it.")
  process.exit(0)
}

const spend = orphanSpend(orphans)
console.log(`${orphans.length} unaccounted resource(s), $${spend.toFixed(2)}/mo:\n`)
for (const o of orphans) {
  const cost = o.monthly > 0 ? `$${o.monthly.toFixed(2)}/mo` : "no cost"
  console.log(`  ${o.kind.padEnd(8)} ${o.name}`)
  console.log(`  ${" ".repeat(8)} ${o.why} — ${cost}`)
}

if (!destroy) {
  console.log("\nNothing was changed. Re-run with --destroy to remove these.")
  process.exit(0)
}

const domain = await getSetting(db, SETTING.domain)
console.log("\nDestroying:")
let failed = 0
for (const o of orphans) {
  try {
    if (o.kind === "droplet") await destroyDroplet(token, Number(o.id))
    else if (o.kind === "volume") await destroyVolume(token, o.id)
    else await deleteRecordById(token, domain, Number(o.id))
    console.log(`  gone   ${o.kind} ${o.name}`)
  } catch (err: any) {
    // Kept going rather than stopping: one volume that will not detach should
    // not leave four droplets running.
    failed++
    console.error(`  FAILED ${o.kind} ${o.name} — ${err?.message ?? err}`)
  }
}
process.exit(failed > 0 ? 1 : 0)
