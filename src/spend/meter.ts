import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import * as spend from "./index.ts"

/**
 * The clock.
 *
 * One job: work out how long each machine has existed since it was last
 * counted, and write what the provider charged for that span. There is nobody
 * to bill — this instance runs on its owner's DigitalOcean account and the
 * only money question left is what it is costing *them*, which is what the
 * spending cap reads.
 *
 * Two things make it safe to run on a timer:
 *
 *  - **The span is claimed before it is counted.** `metered_at` is advanced by
 *    a conditional update that only wins if nobody else moved it, so two
 *    sweeps overlapping — a slow tick, a restart, a second process — count the
 *    hour once between them rather than once each.
 *
 *  - **The remainder is carried, not rounded.** Rounding a five-minute span up
 *    to a whole cent every tick would invent a surcharge out of the sweep
 *    interval: on a box costing a cent an hour that is most of the bill. Whole
 *    cents are counted and the clock is advanced by exactly the time those
 *    cents paid for; the fraction stays unmetered and is counted next time.
 */

/**
 * Nothing is recorded for a span shorter than a cent's worth. Sub-cent spans
 * would round to nothing anyway, and a tick that writes a zero-value row for
 * every running box every five minutes buries the rows that mean something.
 */
const MIN_CENTS = 1

/** Starts the clock on a box. Called once the droplet exists, never before. */
export const startMetering = async (db: Connection, boxId: number, costCents: number): Promise<void> => {
  await db.execute(
    from("boxes")
      .where(q => q("id").equals(boxId))
      .update({ cost_cents: costCents, metered_at: new Date() }),
  )
}

/**
 * Counts the last partial span and stops the clock.
 *
 * Called from every path that releases the droplet — sleep, destroy, a failed
 * provision. The rate stays on the row: a box that sleeps and wakes is the
 * same box, and clearing it would send the wake path back to the provider's
 * catalogue for a number that may have moved.
 */
export const stopMetering = async (db: Connection, boxId: number): Promise<number> => {
  const counted = await meterBox(db, boxId, { final: true })
  await db.execute(
    from("boxes")
      .where(q => q("id").equals(boxId))
      .update({ metered_at: null }),
  )
  return counted
}

export const startWorkspaceMetering = async (
  db: Connection,
  workspaceId: number,
  costCents?: number,
): Promise<void> => {
  await db.execute(
    from("workspaces")
      .where(q => q("id").equals(workspaceId))
      .update({ metered_at: new Date(), ...(costCents !== undefined ? { cost_cents: costCents } : {}) }),
  )
}

export const stopWorkspaceMetering = async (db: Connection, workspaceId: number): Promise<number> => {
  const counted = await meterWorkspace(db, workspaceId, { final: true })
  await db.execute(
    from("workspaces")
      .where(q => q("id").equals(workspaceId))
      .update({ metered_at: null }),
  )
  return counted
}

/** Counts one box for the time since it was last counted, and returns the cents. */
export const meterBox = async (db: Connection, boxId: number, opts: { final?: boolean } = {}): Promise<number> => {
  const box = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
  if (!box?.metered_at) return 0

  const rate = Number(box.cost_cents) || 0
  if (rate <= 0) return 0

  const since = new Date(box.metered_at)
  const now = new Date()
  const ms = now.getTime() - since.getTime()
  if (ms <= 0) return 0

  const exact = (rate * ms) / 3_600_000
  // A final count rounds the last fraction of a cent up; a periodic one leaves
  // it for next time. The difference is at most a cent, once, at the end of a
  // box's life.
  //
  // The epsilon guards the rounding against floating-point noise rather than
  // against a real fraction: `rate * ms` before the divide keeps an exact span
  // exact today, and a nanosecond of error should not cost a whole cent if
  // that ever stops being true.
  const cents = opts.final ? Math.ceil(exact - 1e-9) : Math.floor(exact)
  if (cents < MIN_CENTS) return 0

  // The instant those cents actually paid for. On a final count that is now.
  const until = opts.final ? now : new Date(since.getTime() + Math.round((cents * 3_600_000) / rate))

  const won = (await db.execute(
    from("boxes")
      .where(q => q("id").equals(boxId))
      .where(q => q("metered_at").equals(since))
      .update({ metered_at: until })
      .returning("id"),
  )) as any[]
  if (won.length === 0) return 0

  await spend.record(db, {
    cents,
    kind: "box",
    boxId,
    userId: box.user_id,
    note: `${box.name} · ${box.size} · ${((until.getTime() - since.getTime()) / 3_600_000).toFixed(2)}h`,
    periodStart: since,
    periodEnd: until,
  })
  return cents
}

/**
 * The same, for a volume.
 *
 * Volumes are metered because they are charged for whether or not a box is
 * attached to them, and because they are what is still on the bill after
 * everything else has been tidied away. A cap that counted droplets alone
 * would read low and be trusted anyway.
 */
export const meterWorkspace = async (
  db: Connection,
  workspaceId: number,
  opts: { final?: boolean } = {},
): Promise<number> => {
  const ws = (await db.one(from("workspaces").where(q => q("id").equals(workspaceId)))) as any
  if (!ws?.metered_at) return 0

  const rate =
    ws.cost_cents === null || ws.cost_cents === undefined
      ? spend.volumeCentsPerHour(Number(ws.size_gb) || 0)
      : Number(ws.cost_cents) || 0
  if (rate <= 0) return 0

  const since = new Date(ws.metered_at)
  const now = new Date()
  const ms = now.getTime() - since.getTime()
  if (ms <= 0) return 0

  const exact = (rate * ms) / 3_600_000
  // Same epsilon as above, for the same floating-point reason.
  const cents = opts.final ? Math.ceil(exact - 1e-9) : Math.floor(exact)
  if (cents < MIN_CENTS) return 0
  const until = opts.final ? now : new Date(since.getTime() + Math.round((cents * 3_600_000) / rate))

  const won = (await db.execute(
    from("workspaces")
      .where(q => q("id").equals(workspaceId))
      .where(q => q("metered_at").equals(since))
      .update({ metered_at: until })
      .returning("id"),
  )) as any[]
  if (won.length === 0) return 0

  await spend.record(db, {
    cents,
    kind: "workspace",
    workspaceId,
    userId: ws.user_id,
    note: `${ws.name} · ${ws.size_gb} GB`,
    periodStart: since,
    periodEnd: until,
  })
  return cents
}

/** One pass over everything on the clock: every live box, every live volume. */
export const meterAll = async (db: Connection): Promise<number> => {
  let counted = 0

  const boxes = (await db.all(
    from("boxes")
      .where(q => q("metered_at").isNotNull())
      .where(q => q("destroyed_at").isNull())
      .select("id"),
  )) as any[]
  for (const box of boxes) {
    try {
      counted += await meterBox(db, box.id)
    } catch (err) {
      console.error(`[devpipe] could not meter box ${box.id}:`, err)
    }
  }

  const volumes = (await db.all(
    from("workspaces")
      .where(q => q("metered_at").isNotNull())
      .where(q => q("deleted_at").isNull())
      .select("id"),
  )) as any[]
  for (const ws of volumes) {
    try {
      counted += await meterWorkspace(db, ws.id)
    } catch (err) {
      console.error(`[devpipe] could not meter workspace ${ws.id}:`, err)
    }
  }

  return counted
}
