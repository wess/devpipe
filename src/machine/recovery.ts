import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { requireProvider } from "../providers/index.ts"
import { getSetting, SETTING } from "../settings/index.ts"
import { retireShares, retireSharing } from "../shares/retire.ts"
import { stopMetering, stopWorkspaceMetering } from "../spend/meter.ts"
import { audit } from "../util/audit.ts"
import type { MachineOperation } from "./operations.ts"
import { operationRetry, operationStep, operationSucceeded, unfinishedOperations } from "./operations.ts"

const workspaceFor = async (db: Connection, operation: MachineOperation, box: any) => {
  const id = operation.workspace_id ?? box?.workspace_id
  return id ? ((await db.one(from("workspaces").where(q => q("id").equals(id)))) as any) : null
}

const resumeBoxRelease = async (db: Connection, operation: MachineOperation): Promise<void> => {
  const provider = await requireProvider(db, operation.provider)
  const box = operation.box_id
    ? ((await db.one(from("boxes").where(q => q("id").equals(operation.box_id!)))) as any)
    : null
  const workspace = await workspaceFor(db, operation, box)
  const machineId = String(operation.resource_id ?? box?.provider_id ?? "")

  if (machineId) {
    const machine = await provider.compute.inspect(db, machineId)
    if (machine) {
      await operationStep(db, operation, "releasing-machine", machineId)
      await provider.compute.release(db, {
        machineId,
        workspaceId: workspace?.volume_id ?? null,
        preserveWorkspace: Boolean(workspace),
      })
    }
  }

  if (box && provider.network) {
    const domain = await getSetting(db, SETTING.domain)
    await provider.network.remove(db, domain, box.hostname.replace(`.${domain}`, "")).catch(() => {})
  }
  if (box) await stopMetering(db, box.id)

  if (operation.kind === "sleep") {
    if (box) {
      await db.execute(
        from("boxes")
          .where(q => q("id").equals(box.id))
          .update({
            status: "asleep",
            status_detail: "asleep after an interrupted release — your files are on its workspace",
            provider_id: null,
            endpoint: null,
            ip: "",
          }),
      )
      await retireShares(db, box.id)
    }
  } else if (box) {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(box.id))
        .update({
          status: "destroyed",
          provider_id: null,
          endpoint: null,
          destroyed_at: box.destroyed_at ?? new Date(),
        }),
    )
    await retireSharing(db, box.id)
  }

  await operationSucceeded(db, operation.id)
  if (box) await audit(db, box.user_id, `box.${operation.kind}.recovered`, box.hostname)
}

const resumeWorkspaceRelease = async (db: Connection, operation: MachineOperation): Promise<void> => {
  const provider = await requireProvider(db, operation.provider)
  if (!provider.workspaces) throw new Error(`${provider.label} does not support workspaces.`)
  const workspace = operation.workspace_id
    ? ((await db.one(from("workspaces").where(q => q("id").equals(operation.workspace_id!)))) as any)
    : null
  const resourceId = String(operation.resource_id ?? workspace?.volume_id ?? "")
  if (resourceId && (await provider.workspaces.inspect(db, resourceId))) {
    await operationStep(db, operation, "destroying-workspace", resourceId)
    await provider.workspaces.destroy(db, resourceId)
  }
  if (workspace) {
    await stopWorkspaceMetering(db, workspace.id)
    await db.execute(
      from("workspaces")
        .where(q => q("id").equals(workspace.id))
        .update({ deleted_at: workspace.deleted_at ?? new Date() }),
    )
  }
  await operationSucceeded(db, operation.id)
  if (workspace) await audit(db, workspace.user_id, "workspace.destroy.recovered", workspace.name)
}

/** Finishes provider releases that crossed an API restart. */
export const resumeReleases = async (db: Connection): Promise<void> => {
  const operations = (await unfinishedOperations(db)).filter(operation =>
    ["sleep", "destroy", "workspace.destroy"].includes(operation.kind),
  )
  for (const operation of operations) {
    try {
      if (operation.kind === "workspace.destroy") await resumeWorkspaceRelease(db, operation)
      else await resumeBoxRelease(db, operation)
    } catch (err) {
      await operationRetry(db, operation.id, "recovery-needed", err).catch(() => {})
      console.error(`[devpipe] could not resume ${operation.kind} operation ${operation.id}:`, err)
    }
  }
}
