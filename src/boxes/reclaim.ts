import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { beginOperation, operationFailed, operationStep, operationSucceeded } from "../machine/operations.ts"
import { boxEndpoint } from "../providers/endpoint.ts"
import { ProviderUnavailable, requireProvider } from "../providers/index.ts"
import type { MachineProvider, ProviderKind } from "../providers/types.ts"
import { getSetting, SETTING } from "../settings/index.ts"
import { retireShares } from "../shares/retire.ts"
import { capState } from "../spend/index.ts"
import { meterAll, stopMetering } from "../spend/meter.ts"
import { audit } from "../util/audit.ts"
import { isGpuSize } from "./gpu.ts"

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
  provider?: ProviderKind
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
export const idleBoxes = async (db: Connection, hours: number, freeHours = 0, gpuHours = 0): Promise<Idle[]> => {
  const paid = Number.isFinite(hours) && hours > 0 ? hours : 0
  const free = Number.isFinite(freeHours) && freeHours > 0 ? freeHours : paid
  // Unlike the other two this cannot be switched off, only lengthened. An idle
  // CPU box is four dollars a month of somebody's patience; an idle H100 is
  // four dollars an hour, and the box that ran a job on Friday and was
  // forgotten is the ordinary case rather than the unlucky one.
  const gpuIdle = Number.isFinite(gpuHours) && gpuHours > 0 ? gpuHours : 1
  if (paid <= 0 && free <= 0 && gpuIdle <= 0) return []

  // The *shortest* of the windows, narrowed per box below.
  //
  // Not the longest: a box idle for three hours qualifies under a one-hour free
  // window and not a one-day paid one, and pre-filtering on the longer window
  // throws away exactly the boxes the shorter one exists to catch.
  const shortest = Math.min(...[paid, free, gpuIdle].filter(h => h > 0))
  const rows = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals("ready"))
      // The rule the whole feature rests on.
      .where(q => q("workspace_id").isNotNull())
      .where(q => q("last_active_at").lessThan(new Date(Date.now() - shortest * 3_600_000))),
  )) as any[]

  // Read once rather than per box: it is one row and it cannot change while
  // this loop runs.
  const owner = (await db.one(
    from("users")
      .where(q => q("role").equals("owner"))
      .select("id"),
  )) as any
  const ownerId = Number(owner?.id ?? 0)

  const idle: Idle[] = []
  for (const box of rows) {
    if (!box.provider_id) continue

    // Somebody else's box sleeps sooner than the owner's own.
    //
    // Not a judgement about who matters — it is whose money is at stake. The
    // owner's idle box costs the owner; an experiment somebody left running
    // costs the owner too, and they are not the one who can see it.
    //
    // A GPU box is on neither side of that. It costs by the hour whether or
    // not anyone is watching, so its own window applies and it is the one
    // window with no way to turn off.
    const limit = isGpuSize(box.size) ? gpuIdle : box.user_id === ownerId ? paid : free
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
      provider: box.provider,
      providerId: String(box.provider_id),
      workspaceId: box.workspace_id,
      idleHours: Math.floor((Date.now() - new Date(box.last_active_at).getTime()) / 3_600_000),
    })
  }
  return idle
}

/** What the daemon says it is running. Separated so tests can replace it. */
export let liveSessions = async (box: any): Promise<unknown> => {
  const res = await fetch(`${boxEndpoint(box)}/v1/sessions`, {
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
  const workspace = (await db.one(from("workspaces").where(q => q("id").equals(box.workspaceId)))) as any
  if (!workspace) return false

  let provider: MachineProvider
  try {
    provider = await requireProvider(db, box.provider ?? "digitalocean")
  } catch (err) {
    if (!(err instanceof ProviderUnavailable))
      console.error(`[devpipe] could not load ${box.hostname}'s provider:`, err)
    return false
  }

  const operation = await beginOperation(db, {
    idempotencyKey: `sleep:${box.id}:${box.providerId}`,
    provider: provider.kind,
    kind: "sleep",
    boxId: box.id,
    workspaceId: workspace.id,
  })
  try {
    await operationStep(db, operation, "releasing-machine", box.providerId)
    await provider.compute.release(db, {
      machineId: box.providerId,
      workspaceId: String(workspace.volume_id),
      preserveWorkspace: true,
    })
  } catch (err) {
    await operationFailed(db, operation.id, err)
    console.error(`[devpipe] could not release ${box.hostname}:`, err)
    return false
  }

  if (provider.network) {
    const domain = await getSetting(db, SETTING.domain)
    await provider.network.remove(db, domain, box.hostname.replace(`.${domain}`, "")).catch(() => {
      // A stale record points at an address that is no longer ours, which waking
      // fixes by writing a new one. Not worth refusing to sleep over.
    })
  }

  // The droplet has stopped existing, so the meter stops with it. After the
  // destroy rather than before: a sleep that failed above must not have
  // stopped charging for a machine that is still running.
  await stopMetering(db, box.id)

  await db.execute(
    from("boxes")
      .where(q => q("id").equals(box.id))
      .update({
        status: ASLEEP,
        status_detail: `${why ?? `asleep after ${box.idleHours}h idle`} — your files are on its workspace`,
        provider_id: null,
        endpoint: null,
        ip: "",
      }),
  )
  // The droplet is gone, so the daemon is gone, so every session id a share
  // names is gone. Waking builds a new machine with an empty session list —
  // the link would stay live and connect to nothing. Previews are left alone:
  // they name a port, and the port comes back.
  await retireShares(db, box.id)
  await operationSucceeded(db, operation.id)
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
  const gpuHours = Number(await getSetting(db, SETTING.gpuIdleHours))
  // No early return any more. The CPU windows are still off unless somebody
  // sets them, but the GPU one is always on, so the sweep always runs — it just
  // has nothing to look at on an instance with no GPU boxes.

  const slept: Idle[] = []
  for (const box of await idleBoxes(db, hours, freeHours, gpuHours)) {
    if (await sleepBox(db, box)) {
      console.log(`[devpipe] ${box.hostname} slept after ${box.idleHours}h idle`)
      slept.push(box)
    }
  }
  return slept
}

/**
 * The instance's ceiling, enforced.
 *
 * Counts everything on the clock first, then acts on the total — the cap reads
 * what the meter just wrote, so checking before counting would always be one
 * tick behind. Nobody is being charged; this protects the person whose
 * DigitalOcean account every box on this instance lands on.
 *
 * Most expensive first, and only as far as it needs to go. Sleeping everything
 * the moment a cap is touched is the kind of blunt response that gets a safety
 * feature turned off; putting down the biggest machine and re-checking usually
 * ends after one.
 */
export const sweepSpendCap = async (db: Connection): Promise<Idle[]> => {
  await meterAll(db)

  const cap = await capState(db)
  if (!cap.over) return []

  const rows = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("metered_at").isNotNull())
      .where(q => q("workspace_id").isNotNull()),
  )) as any[]

  const slept: Idle[] = []
  for (const row of rows.sort((a, b) => (Number(b.cost_cents) || 0) - (Number(a.cost_cents) || 0))) {
    if (row.status !== "ready" || !row.provider_id) continue
    const box: Idle = {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      hostname: row.hostname,
      provider: row.provider,
      providerId: String(row.provider_id),
      workspaceId: row.workspace_id,
      idleHours: 0,
    }
    if (await sleepBox(db, box, "asleep — this instance reached its spending cap")) {
      console.log(`[devpipe] ${row.hostname} slept: instance spending cap reached`)
      slept.push(box)
    }
    // Re-read rather than assume. Sleeping a box stops its run rate, and the
    // point is to stop as soon as the instance is under the line again.
    if (!(await capState(db)).over) break
  }
  return slept
}

/**
 * Boxes that have been asleep so long nobody is coming back.
 *
 * A slept box costs nothing to run, but its workspace is charged for forever,
 * and somebody who signed up once and never returned leaves one behind. This is
 * the only thing in the file that destroys data, so it is off unless a number
 * is set, and it never touches the owner's own boxes.
 */
export const expireDormant = async (db: Connection): Promise<number> => {
  const days = Number(await getSetting(db, SETTING.dormantDays))
  if (!Number.isFinite(days) || days <= 0) return 0

  const cutoff = new Date(Date.now() - days * 86_400_000)
  const rows = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .where(q => q("status").equals(ASLEEP))
      .where(q => q("last_active_at").lessThan(cutoff)),
  )) as any[]

  const owner = (await db.one(
    from("users")
      .where(q => q("role").equals("owner"))
      .select("id"),
  )) as any
  const ownerId = Number(owner?.id ?? 0)

  let gone = 0
  for (const box of rows) {
    // Never the owner's own box, however long it has slept. This is the only
    // thing here that destroys data, and the person who installed the instance
    // is not somebody whose files should be tidied up on a timer.
    if (box.user_id === ownerId) continue

    if (box.workspace_id) {
      const workspace = (await db.one(from("workspaces").where(q => q("id").equals(box.workspace_id)))) as any
      if (workspace) {
        let provider: MachineProvider
        try {
          provider = await requireProvider(db, workspace.provider)
          if (!provider.workspaces) throw new Error(`${provider.label} does not support workspaces.`)
          const operation = await beginOperation(db, {
            idempotencyKey: `workspace.expire:${workspace.id}:${workspace.volume_id}`,
            provider: provider.kind,
            kind: "workspace.destroy",
            workspaceId: workspace.id,
          })
          await operationStep(db, operation, "destroying-workspace", String(workspace.volume_id))
          await provider.workspaces.destroy(db, String(workspace.volume_id))
          await db.execute(
            from("workspaces")
              .where(q => q("id").equals(workspace.id))
              .update({ deleted_at: new Date() }),
          )
          await operationSucceeded(db, operation.id)
        } catch (err) {
          // The row stays and the box stays. A volume the provider still has
          // and we have forgotten is a charge nobody can explain.
          console.error(`[devpipe] could not delete ${workspace.name} while expiring ${box.hostname}:`, err)
          continue
        }
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
