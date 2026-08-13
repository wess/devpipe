import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import * as ocean from "../boxes/digitalocean.ts"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../settings/index.ts"
import { audit } from "../util/audit.ts"

/**
 * How much a box is moving, and what to do when it is a lot.
 *
 * Everything else here raises the cost of an obvious thing and stops nobody who
 * tries twice: peer-to-peer clients are pinned out of the archive, outbound mail
 * is closed at the provider, port 22 no longer answers the internet. All worth
 * having and none of them a bound.
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

/** Why a box was reported. */
export type Reason =
  /** More than the hourly limit. A seedbox, a mirror, someone's backup target. */
  | "burst"
  /** Under the hourly limit all day and over the daily one. Patience. */
  | "sustained"
  /** Volume, and about as much in as out. The shape of a relay. */
  | "relay"

/** Reported when a box crosses a line. */
export type Heavy = {
  boxId: number
  userId: number
  hostname: string
  reason: Reason
  /** Gigabytes sent over the window that tripped it. */
  gigabytes: number
  /** Gigabytes received over the same window. */
  received: number
  /** Seconds the figures cover. */
  window: number
}

/**
 * Averaged over an hour rather than sampled.
 *
 * A single sample catches a `git push` of a large repository and calls it
 * abuse. An hourly average of a gigabit link is roughly 450GB — nothing a
 * developer does by accident, and well under what a seedbox does on purpose.
 */
export const WINDOW_SECONDS = 3600

/**
 * The second window, for the abuse the first one is blind to.
 *
 * The hourly check bounds rate and says nothing about patience. A box relaying
 * at 40GB an hour never crosses a 200GB line and still moves nearly a terabyte
 * a day, which is not a shape any developer's work has.
 */
export const DAY_SECONDS = 86_400

const DEFAULT_LIMIT_GB = 200
const DEFAULT_DAILY_GB = 500

/**
 * How alike the two directions have to be before a box reads as a relay.
 *
 * A proxy forwards what it receives, so its two figures are nearly equal. A box
 * doing work is lopsided in one direction or the other: builds pull far more
 * than they push, a seedbox pushes far more than it pulls. Traffic that is
 * within a third of symmetric, at volume, is being carried rather than used.
 */
export const RELAY_RATIO = 0.66

/**
 * And how much of it there has to be.
 *
 * Without a floor this fires on every quiet box: a machine that moved 40MB each
 * way over a day is perfectly symmetric and perfectly idle. The ratio says what
 * the traffic is; the floor says whether there is enough of it to care.
 */
export const RELAY_FLOOR_GB = 100

/** Megabits per second, or null when the provider has no reading. */
const moved = async (
  token: string,
  dropletId: string,
  direction: "inbound" | "outbound",
  window: number,
): Promise<number | null> => {
  try {
    return await ocean.bandwidthMbps(token, dropletId, direction, window)
  } catch {
    // One unreadable figure must not stop the sweep reaching the rest.
    return null
  }
}

/**
 * What one box has moved, and whether any of it crosses a line.
 *
 * Returns the first line crossed rather than all of them: a box relaying hard
 * enough to trip the hourly limit is one problem, not three, and three audit
 * rows an hour for it makes the log worse at the job it exists for.
 *
 * A box the provider has no reading for is skipped rather than counted as
 * quiet: a droplet minutes old has no samples, and a missing measurement must
 * never look like a well-behaved box.
 */
export const verdict = (readings: {
  hourlyOut: number | null
  dailyOut: number | null
  dailyIn: number | null
  limitGb: number
  dailyGb: number
}): { reason: Reason; gigabytes: number; received: number; window: number } | null => {
  const { hourlyOut, dailyOut, dailyIn, limitGb, dailyGb } = readings

  if (hourlyOut !== null) {
    const gigabytes = ocean.gigabytesOver(hourlyOut, WINDOW_SECONDS)
    if (gigabytes > limitGb) {
      return { reason: "burst", gigabytes, received: 0, window: WINDOW_SECONDS }
    }
  }

  if (dailyOut === null) return null
  const sent = ocean.gigabytesOver(dailyOut, DAY_SECONDS)
  const received = dailyIn === null ? 0 : ocean.gigabytesOver(dailyIn, DAY_SECONDS)

  if (sent > dailyGb) {
    return { reason: "sustained", gigabytes: sent, received, window: DAY_SECONDS }
  }

  // Checked last and against a floor of its own, because this is the only test
  // here that can fire on a box under both limits. It is also the only one that
  // catches a proxy run politely, which is how a proxy would be run.
  const high = Math.max(sent, received)
  const low = Math.min(sent, received)
  if (high >= RELAY_FLOOR_GB && low / high >= RELAY_RATIO) {
    return { reason: "relay", gigabytes: sent, received, window: DAY_SECONDS }
  }

  return null
}

/** Boxes that crossed a line, oldest first. */
export const heavySenders = async (db: Connection): Promise<Heavy[]> => {
  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return []

  const limitGb = Number((await getSetting(db, SETTING.egressLimitGb)) || DEFAULT_LIMIT_GB)
  const dailyGb = Number((await getSetting(db, SETTING.egressDailyGb)) || DEFAULT_DAILY_GB)
  // A limit set to nothing disables the check rather than reporting every box.
  if (!Number.isFinite(limitGb) || limitGb <= 0) return []
  if (!Number.isFinite(dailyGb) || dailyGb <= 0) return []

  const boxes = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals("ready")),
  )) as any[]

  const heavy: Heavy[] = []
  for (const box of boxes) {
    if (!box.provider_id) continue
    const id = String(box.provider_id)
    // Three readings per box per hour. Concurrent rather than in sequence
    // because they are independent, and a sweep that takes three round trips
    // per box serially gets slow at exactly the fleet size where it matters.
    const [hourlyOut, dailyOut, dailyIn] = await Promise.all([
      moved(token, id, "outbound", WINDOW_SECONDS),
      moved(token, id, "outbound", DAY_SECONDS),
      moved(token, id, "inbound", DAY_SECONDS),
    ])

    const found = verdict({ hourlyOut, dailyOut, dailyIn, limitGb, dailyGb })
    if (!found) continue
    heavy.push({
      boxId: box.id,
      userId: box.user_id,
      hostname: box.hostname,
      reason: found.reason,
      gigabytes: Math.round(found.gigabytes),
      received: Math.round(found.received),
      window: found.window,
    })
  }
  return heavy
}

const SAID: Record<Reason, (h: Heavy) => string> = {
  burst: h => `sent about ${h.gigabytes}GB in the last hour`,
  sustained: h => `sent about ${h.gigabytes}GB in the last day`,
  relay: h => `moved ${h.gigabytes}GB out and ${h.received}GB in over the last day, which is the shape of a relay`,
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
    const said = SAID[box.reason](box)
    console.warn(`[devpipe] ${box.hostname} ${said} (user ${box.userId})`)
    await audit(db, box.userId, `box.egress_${box.reason}`, `${box.hostname} ${said}`)
  }
  return heavy
}
