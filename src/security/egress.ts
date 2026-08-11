import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import * as ocean from "../boxes/digitalocean.ts"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../settings/index.ts"
import { audit } from "../util/audit.ts"

/**
 * How much a box is sending, and what to do when it is a lot.
 *
 * Everything else here raises the cost of an obvious thing and stops nobody who
 * tries twice: peer-to-peer clients are pinned out of the archive, outbound mail
 * is closed at the provider. Both are worth having and neither is a bound.
 *
 * Volume is a bound. A box that has pushed hundreds of gigabytes is a seedbox or
 * a mirror whatever software it used, and that judgement needs nothing about
 * *what* ran on the box — which matters, because the note at the top of
 * `abuse.ts` is right that inspecting a customer's terminal is not something
 * this product does. Bytes leaving a machine are the provider's measurement, not
 * ours, and they are already being collected: droplets are created with
 * `monitoring: true`.
 *
 * The response is deliberately not suspension. A busy build, a large dataset, a
 * container registry push and a seedbox all look alike for an hour, and locking
 * a paying customer out of their machine on an hour of traffic is a worse
 * failure than the one it prevents. This records and warns; a person decides.
 */

/** Reported when a box crosses the line, oldest first. */
export type Heavy = {
  boxId: number
  userId: number
  hostname: string
  gigabytes: number
  mbps: number
}

/**
 * Averaged over an hour rather than sampled.
 *
 * A single sample catches a `git push` of a large repository and calls it
 * abuse. An hourly average of a gigabit link is roughly 450GB — nothing a
 * developer does by accident, and well under what a seedbox does on purpose.
 */
export const WINDOW_SECONDS = 3600

const DEFAULT_LIMIT_GB = 200

/**
 * Boxes that moved more than the limit in the last window.
 *
 * A box DigitalOcean has no reading for is skipped rather than counted as
 * quiet: a droplet minutes old has no samples, and a missing measurement must
 * never look like a well-behaved box.
 */
export const heavySenders = async (db: Connection): Promise<Heavy[]> => {
  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return []

  const limit = Number((await getSetting(db, SETTING.egressLimitGb)) || DEFAULT_LIMIT_GB)
  if (!Number.isFinite(limit) || limit <= 0) return []

  const boxes = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals("ready")),
  )) as any[]

  const heavy: Heavy[] = []
  for (const box of boxes) {
    if (!box.provider_id) continue
    let mbps: number | null = null
    try {
      mbps = await ocean.outboundMbps(token, String(box.provider_id), WINDOW_SECONDS)
    } catch {
      // One unreadable box must not stop the sweep reaching the rest.
      continue
    }
    if (mbps === null) continue
    const gigabytes = ocean.gigabytesOver(mbps, WINDOW_SECONDS)
    if (gigabytes > limit) {
      heavy.push({
        boxId: box.id,
        userId: box.user_id,
        hostname: box.hostname,
        gigabytes: Math.round(gigabytes),
        mbps,
      })
    }
  }
  return heavy
}

/**
 * Records what was found, once per box per sweep.
 *
 * The audit trail is the point. `abuse.ts` says an abuse response has to be
 * something the control plane can do on its own in seconds, and the thing that
 * makes that possible is having already written down which account was sending
 * what, before the complaint arrives naming an address and a time.
 */
export const watchEgress = async (db: Connection): Promise<Heavy[]> => {
  const heavy = await heavySenders(db)
  for (const box of heavy) {
    console.warn(`[devpipe] ${box.hostname} sent about ${box.gigabytes}GB in the last hour (user ${box.userId})`)
    await audit(db, box.userId, "box.egress_high", `${box.hostname} ${box.gigabytes}GB/h`)
  }
  return heavy
}
