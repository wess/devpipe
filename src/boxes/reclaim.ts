import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../settings/index.ts"
import { retireShares } from "../shares/retire.ts"
import { audit } from "../util/audit.ts"
import * as ocean from "./digitalocean.ts"

/**
 * Giving a box back when nobody is using it.
 *
 * A box is billed by the hour and charged for whether or not anyone is typing.
 * Most of them are idle most of the time, so the difference between paying for
 * a box and paying for the hours it was used is most of the bill.
 *
 * This is only safe because of workspaces. A box without one holds the only copy
 * of whatever is on it, so reclaiming it destroys work; a box with one holds
 * nothing that matters, because the part that matters is on a volume that
 * outlives it. **Boxes without a workspace are never touched.** That is not a
 * policy that should be made configurable — it is the difference between
 * reclaiming a machine and deleting somebody's afternoon.
 *
 * Asleep, not destroyed. The row survives with its manifest, so the box comes
 * back with the same name, the same tools and the same files. What is released
 * is the droplet, which is the only part being charged for by the hour.
 */

/** A box that is asleep still exists; it just has no machine right now. */
export const ASLEEP = "asleep"

export type Idle = {
  id: number
  userId: number
  name: string
  hostname: string
  providerId: string
  workspaceId: number
  idleHours: number
}

/**
 * Boxes that have been unused long enough to give back.
 *
 * Two independent signals, and both have to agree. `last_active_at` covers the
 * person — every time they open the box, list its terminals or attach to one,
 * it moves. The daemon's own session list covers the machine: an agent working
 * through a long task with nobody watching is a live session, and a box running
 * one is not idle no matter how long since a human looked at it.
 */
export const idleBoxes = async (db: Connection, hours: number, freeHours = 0): Promise<Idle[]> => {
  const paid = Number.isFinite(hours) && hours > 0 ? hours : 0
  const free = Number.isFinite(freeHours) && freeHours > 0 ? freeHours : paid
  if (paid <= 0 && free <= 0) return []

  // The *shortest* of the two windows, narrowed per box below.
  //
  // Not the longest: a box idle for three hours qualifies under a one-hour free
  // window and not a one-day paid one, and pre-filtering on the longer window
  // throws away exactly the boxes the shorter one exists to catch.
  const shortest = Math.min(...[paid, free].filter(h => h > 0))
  const rows = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals("ready"))
      // The rule the whole feature rests on.
      .where(q => q("workspace_id").isNotNull())
      .where(q => q("last_active_at").lessThan(new Date(Date.now() - shortest * 3_600_000))),
  )) as any[]

  const idle: Idle[] = []
  for (const box of rows) {
    if (!box.provider_id) continue

    // A box nobody is paying for sleeps sooner. `subscription_id` is null for
    // both a free instance and the owner's own boxes, which is the right set:
    // neither is generating revenue that an idle hour eats into.
    const covered = (await db.one(from("subscriptions").where(q => q("box_id").equals(box.id)))) as any
    const limit = covered ? paid : free
    if (limit <= 0) continue
    const idleFor = Date.now() - new Date(box.last_active_at).getTime()
    if (idleFor < limit * 3_600_000) continue
    // Ask the box. A daemon that cannot be reached is not evidence of idleness
    // — it is evidence of a network problem, and reclaiming on that basis
    // destroys a machine somebody is probably still using.
    let sessions: unknown
    try {
      sessions = await liveSessions(box)
    } catch {
      continue
    }
    if (!Array.isArray(sessions) || sessions.length > 0) continue

    idle.push({
      id: box.id,
      userId: box.user_id,
      name: box.name,
      hostname: box.hostname,
      providerId: String(box.provider_id),
      workspaceId: box.workspace_id,
      idleHours: Math.floor((Date.now() - new Date(box.last_active_at).getTime()) / 3_600_000),
    })
  }
  return idle
}

/** What the daemon says it is running. Separated so tests can replace it. */
export let liveSessions = async (box: any): Promise<unknown> => {
  const res = await fetch(`https://${box.hostname}/v1/sessions`, {
    headers: { authorization: `Bearer ${box.agent_token}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`box answered ${res.status}`)
  return await res.json()
}

/** Test seam. */
export const setLiveSessions = (fn: typeof liveSessions) => {
  liveSessions = fn
}

/**
 * Releases the machine and keeps everything else.
 *
 * The volume is detached first and waited for, exactly as destroying a box
 * does: a volume still attached to a droplet that no longer exists is not freed
 * by the droplet going away, and it cannot be attached anywhere else — which
 * would make the box unwakeable as well as still billed.
 *
 * `why` is for the one caller that is not the sweep. A box somebody put down on
 * purpose should not tell them it went idle.
 */
export const sleepBox = async (db: Connection, box: Idle, why?: string): Promise<boolean> => {
  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return false

  const workspace = (await db.one(from("workspaces").where(q => q("id").equals(box.workspaceId)))) as any
  if (!workspace) return false

  try {
    await ocean.detachVolume(token, workspace.volume_id, Number(box.providerId))
  } catch (err) {
    // Refused rather than forced. Destroying the droplet with the volume still
    // attached is the one outcome that loses the workspace's availability.
    console.error(`[devpipe] could not detach ${box.hostname}'s workspace, leaving it awake:`, err)
    return false
  }

  try {
    await ocean.destroyDroplet(token, Number(box.providerId))
  } catch (err) {
    console.error(`[devpipe] could not release ${box.hostname}:`, err)
    return false
  }

  const domain = await getSetting(db, SETTING.domain)
  try {
    await ocean.deleteRecord(token, domain, box.hostname.replace(`.${domain}`, ""))
  } catch {
    // A stale record points at an address that is no longer ours, which waking
    // fixes by writing a new one. Not worth refusing to sleep over.
  }

  await db.execute(
    from("boxes")
      .where(q => q("id").equals(box.id))
      .update({
        status: ASLEEP,
        status_detail: `${why ?? `asleep after ${box.idleHours}h idle`} — your files are on its workspace`,
        provider_id: null,
        ip: "",
      }),
  )
  // The droplet is gone, so the daemon is gone, so every session id a share
  // names is gone. Waking builds a new machine with an empty session list —
  // the link would stay live and connect to nothing. Previews are left alone:
  // they name a port, and the port comes back.
  await retireShares(db, box.id)
  await audit(db, box.userId, "box.slept", `${box.hostname} ${why ?? `after ${box.idleHours}h`}`)
  return true
}

/**
 * The sweep. Returns what it put to sleep.
 *
 * Off unless somebody sets the hours, and the setting is the only thing that
 * turns it on — an instance that has not been told what idle means must not
 * start reclaiming machines because a default said so.
 */
export const reclaimIdle = async (db: Connection): Promise<Idle[]> => {
  const hours = Number(await getSetting(db, SETTING.idleHours))
  const freeHours = Number(await getSetting(db, SETTING.freeIdleHours))
  const anyOn = (Number.isFinite(hours) && hours > 0) || (Number.isFinite(freeHours) && freeHours > 0)
  if (!anyOn) return []

  const slept: Idle[] = []
  for (const box of await idleBoxes(db, hours, freeHours)) {
    if (await sleepBox(db, box)) {
      console.log(`[devpipe] ${box.hostname} slept after ${box.idleHours}h idle`)
      slept.push(box)
    }
  }
  return slept
}

/**
 * Boxes that have been asleep so long nobody is coming back.
 *
 * A slept box costs nothing to run, but its workspace is charged for forever,
 * and somebody who signed up once and never returned leaves one behind. This is
 * the only thing in the file that destroys data, so it is off unless a number
 * is set, and it applies only to boxes that were never paid for — a subscriber's
 * files are not something to tidy up on a timer.
 */
export const expireDormant = async (db: Connection): Promise<number> => {
  const days = Number(await getSetting(db, SETTING.dormantDays))
  if (!Number.isFinite(days) || days <= 0) return 0

  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return 0

  const cutoff = new Date(Date.now() - days * 86_400_000)
  const rows = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals(ASLEEP))
      .where(q => q("last_active_at").lessThan(cutoff)),
  )) as any[]

  let gone = 0
  for (const box of rows) {
    // Never a box somebody is paying for, however long it has slept.
    const covered = (await db.one(from("subscriptions").where(q => q("box_id").equals(box.id)))) as any
    if (covered) continue

    if (box.workspace_id) {
      const workspace = (await db.one(from("workspaces").where(q => q("id").equals(box.workspace_id)))) as any
      if (workspace) {
        try {
          await ocean.destroyVolume(token, workspace.volume_id)
        } catch (err) {
          // The row stays and the box stays. A volume the provider still has
          // and we have forgotten is a charge nobody can explain.
          console.error(`[devpipe] could not delete ${workspace.name} while expiring ${box.hostname}:`, err)
          continue
        }
        await db.execute(
          from("workspaces")
            .where(q => q("id").equals(workspace.id))
            .update({ deleted_at: new Date() }),
        )
      }
    }

    await db.execute(
      from("boxes")
        .where(q => q("id").equals(box.id))
        .update({ status: "destroyed", destroyed_at: new Date(), workspace_id: null }),
    )
    await audit(db, box.user_id, "box.expired", `${box.hostname} after ${days}d asleep`)
    console.log(`[devpipe] ${box.hostname} expired after ${days} days asleep`)
    gone++
  }
  return gone
}
