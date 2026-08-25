import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { REGIONS } from "../boxes/catalog.ts"
import { beginOperation, operationFailed, operationStep, operationSucceeded } from "../machine/operations.ts"
import { ProviderUnavailable, requireProvider } from "../providers/index.ts"
import type { MachineProvider, ProviderKind, Workspace } from "../providers/types.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { startWorkspaceMetering, stopWorkspaceMetering } from "../spend/meter.ts"
import { audit } from "../util/audit.ts"

/**
 * Storage that outlives the box.
 *
 * The wizard already makes a box rebuildable — it stores the selection, so an
 * identical machine is one click away. What it never rebuilt is the work, and
 * the destroy dialog says so: "the files somebody was working on are not part
 * of that". A workspace is the part that is.
 *
 * Two properties of block storage shape every decision here, and neither is
 * ours to design around:
 *
 * - **One droplet at a time.** A workspace cannot be on two boxes, so a box
 *   holding one is a lock on it. The `boxes.workspace_id` row *is* that lock.
 * - **Pinned to a region.** A workspace has a region and a box elsewhere cannot
 *   mount it, which makes the wizard's region choice follow the workspace
 *   rather than the other way round.
 *
 * Deleting is deliberately separate from destroying a box. The entire point is
 * that they have different lifetimes; a workspace that vanished with its box
 * would be a slower way of losing the same work.
 */

const MIN_GB = 1
const MAX_GB = 500

const publicWorkspace = (row: any, attachedTo?: number | null) => ({
  id: row.id,
  name: row.name,
  region: row.region,
  size_gb: row.size_gb,
  created_at: row.created_at,
  provider: row.provider,
  /** The box currently holding it, if any. Null means free to attach. */
  attached_to: attachedTo ?? null,
})

/**
 * The live box holding a workspace, or null. This is the lock.
 *
 * `exceptBoxId` excludes one box from the answer, which is what waking needs:
 * a sleeping box still owns its workspace row, so without this it finds
 * *itself* holding the lock and refuses. That is not hypothetical — it made
 * every slept box unwakeable, so reclaim would have stranded whatever it
 * touched.
 */
export const holderOf = async (db: Connection, workspaceId: number, exceptBoxId?: number): Promise<any | null> => {
  const rows = (await db.all(
    from("boxes")
      .where(q => q("workspace_id").equals(workspaceId))
      .where(q => q("destroyed_at").isNull()),
  )) as any[]
  return rows.find(row => row.id !== exceptBoxId) ?? null
}

/**
 * The workspace a box may use, or a reason it may not.
 *
 * Called when creating a box and again when waking one, and the difference
 * between those matters: creating has no box yet, so any holder is somebody
 * else, while a *sleeping* box still owns its workspace row and would otherwise
 * be refused for holding its own lock. `exceptBoxId` is how waking says "anyone
 * but me".
 *
 * The three ways this goes wrong are a workspace that is not yours, one already
 * on another box, and one in another region. The third is the one people will
 * hit by accident.
 */
export const claimForBox = async (
  db: Connection,
  userId: number,
  workspaceId: number,
  region: string,
  exceptBoxId?: number,
  providerKind?: ProviderKind,
): Promise<{ ok: true; workspace: any } | { ok: false; reason: string }> => {
  const workspace = (await db.one(
    from("workspaces")
      .where(q => q("id").equals(workspaceId))
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull()),
  )) as any
  if (!workspace) return { ok: false, reason: "No such workspace." }
  if (providerKind && workspace.provider !== providerKind) {
    return {
      ok: false,
      reason: `That workspace belongs to ${workspace.provider}; it cannot be attached to a ${providerKind} machine.`,
    }
  }

  const holder = await holderOf(db, workspaceId, exceptBoxId)
  if (holder) {
    return {
      ok: false,
      reason: `That workspace is on ${holder.name}. A workspace can only be on one box at a time.`,
    }
  }
  if (workspace.region !== region) {
    const where = REGIONS.find(r => r.slug === workspace.region)?.label ?? workspace.region
    return {
      ok: false,
      reason: `That workspace lives in ${where}, so the box has to be there too.`,
    }
  }
  return { ok: true, workspace }
}

export const workspaceRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))
  // Creating one costs money the moment it exists, the same as a box.
  const create = pipeline(
    requireAuth({ db }),
    parseJson,
    rateLimit({
      db,
      key: "workspaces.create",
      limit: 60,
      windowSeconds: 3600,
      subject: signedInUser,
      subjectLimit: 10,
    }),
  )

  return [
    get(
      "/workspaces",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("workspaces")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("deleted_at").isNull())
            .orderBy("created_at", "DESC"),
        )) as any[]
        const out = []
        for (const row of rows) {
          const holder = await holderOf(db, row.id)
          out.push(publicWorkspace(row, holder?.id ?? null))
        }
        return json(c, 200, out)
      }),
    ),

    post(
      "/workspaces",
      create(async c => {
        const me = currentUser(c)
        const b = c.body as { name?: string; region?: string; size_gb?: number }
        let provider: MachineProvider
        try {
          provider = await requireProvider(db)
        } catch (err) {
          if (!(err instanceof ProviderUnavailable)) throw err
          return json(c, 503, { error: err.message })
        }
        if (!provider.workspaces) return json(c, 422, { error: `${provider.label} does not support workspaces.` })

        const name = (b.name ?? "").trim().slice(0, 40) || "workspace"
        const providerCatalog = provider.catalog ? await provider.catalog(db) : null
        const region = providerCatalog
          ? providerCatalog.regions.find(r => r.slug === b.region)?.slug
          : REGIONS.find(r => r.slug === b.region)?.slug
        if (!region) return json(c, 422, { error: "Pick a region for this workspace." })
        const sizeGb = Math.min(Math.max(Math.round(Number(b.size_gb) || 10), MIN_GB), MAX_GB)

        const clash = (await db.one(
          from("workspaces")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("name").equals(name))
            .where(q => q("deleted_at").isNull()),
        )) as any
        if (clash) return json(c, 409, { error: "You already have a workspace with that name." })

        // Named for the account rather than the person: volume names are
        // unique across a DigitalOcean account, and two customers both calling
        // one "main" is the ordinary case, not the exception.
        const volumeName = `dp-${me.id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60)
        let volume: Workspace
        const operation = await beginOperation(db, {
          idempotencyKey: `workspace.create:${me.id}:${provider.kind}:${volumeName}`,
          provider: provider.kind,
          kind: "workspace.create",
        })
        try {
          await operationStep(db, operation, "creating-workspace")
          volume = await provider.workspaces.create(db, { name: volumeName, region, sizeGb })
          await operationStep(db, operation, "workspace-created", volume.id)
        } catch (err: any) {
          await operationFailed(db, operation.id, err)
          return json(c, 502, { error: String(err?.message ?? "Could not create that workspace.") })
        }

        let rows: any[]
        try {
          rows = (await db.execute(
            from("workspaces")
              .insert({
                user_id: me.id,
                name,
                region,
                size_gb: sizeGb,
                provider: provider.kind,
                volume_id: volume.id,
                volume_name: volume.name || volumeName,
              })
              .returning("id", "name", "region", "size_gb", "provider", "created_at"),
          )) as any[]
        } catch (err) {
          await provider.workspaces.destroy(db, volume.id).catch(cleanupError => {
            console.error("[devpipe] could not clean up a workspace after its row failed:", cleanupError)
          })
          await operationFailed(db, operation.id, err)
          throw err
        }
        await operationSucceeded(db, operation.id)
        // The provider starts charging for a volume the moment it exists,
        // whether or not a box is ever attached to it. So does the meter.
        await startWorkspaceMetering(db, rows[0].id, provider.kind === "digitalocean" ? undefined : 0)
        await audit(db, me.id, "workspace.created", `${name} ${sizeGb}GB ${region}`)
        return json(c, 201, publicWorkspace(rows[0], null))
      }),
    ),

    del(
      "/workspaces/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("workspaces")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("deleted_at").isNull()),
        )) as any
        if (!row) return json(c, 404, { error: "No such workspace." })

        // Refused while a box holds it. Deleting the storage out from under a
        // running machine is not a thing to do politely in the background.
        const holder = await holderOf(db, row.id)
        if (holder) {
          return json(c, 409, {
            error: `That workspace is on ${holder.name}. Destroy the box first, or detach it.`,
          })
        }

        let provider: MachineProvider
        try {
          provider = await requireProvider(db, row.provider)
        } catch (err) {
          if (!(err instanceof ProviderUnavailable)) throw err
          return json(c, 503, { error: `${err.message} The workspace has not been changed.` })
        }
        if (!provider.workspaces) return json(c, 422, { error: `${provider.label} does not support workspaces.` })
        const operation = await beginOperation(db, {
          idempotencyKey: `workspace.destroy:${row.id}:${row.volume_id}`,
          provider: provider.kind,
          kind: "workspace.destroy",
          workspaceId: row.id,
        })
        try {
          await operationStep(db, operation, "destroying-workspace", String(row.volume_id))
          await provider.workspaces.destroy(db, String(row.volume_id))
        } catch (err) {
          await operationFailed(db, operation.id, err)
          console.error("[devpipe] could not delete a workspace volume:", err)
          return json(c, 502, { error: "The provider would not delete that workspace. Nothing was changed." })
        }
        // The last partial hour, before the row stops being one the meter can
        // read. After the provider has actually deleted it, so a refusal above
        // has not stopped the clock on storage that still exists.
        await stopWorkspaceMetering(db, row.id)
        await db.execute(
          from("workspaces")
            .where(q => q("id").equals(row.id))
            .update({ deleted_at: new Date() }),
        )
        await operationSucceeded(db, operation.id)
        await audit(db, me.id, "workspace.deleted", `${row.name} ${row.size_gb}GB`)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
