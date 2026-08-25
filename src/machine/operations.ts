import { randomUUID } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { ProviderKind } from "../providers/index.ts"

export type MachineOperationKind = "provision" | "wake" | "sleep" | "destroy" | "workspace.create" | "workspace.destroy"

export type MachineOperation = {
  id: string
  idempotency_key: string
  provider: ProviderKind
  kind: MachineOperationKind
  status: "queued" | "running" | "succeeded" | "failed"
  step: string
  box_id: number | null
  workspace_id: number | null
  resource_id: string | null
  payload: Record<string, unknown>
  attempts: number
  last_error: string
  created_at: Date
  updated_at: Date
  finished_at: Date | null
}

const shaped = (row: any): MachineOperation => ({
  ...row,
  payload: typeof row.payload === "string" ? JSON.parse(row.payload || "{}") : (row.payload ?? {}),
})

export const beginOperation = async (
  db: Connection,
  input: {
    idempotencyKey: string
    provider: ProviderKind
    kind: MachineOperationKind
    boxId?: number | null
    workspaceId?: number | null
    payload?: Record<string, unknown>
  },
): Promise<MachineOperation> => {
  const existing = (await db.one(
    from("machine_operations").where(q => q("idempotency_key").equals(input.idempotencyKey)),
  )) as any
  if (existing) return shaped(existing)

  const id = randomUUID()
  await db.execute(
    from("machine_operations").insert({
      id,
      idempotency_key: input.idempotencyKey,
      provider: input.provider,
      kind: input.kind,
      status: "queued",
      box_id: input.boxId ?? null,
      workspace_id: input.workspaceId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
    }),
  )
  return shaped(await db.one(from("machine_operations").where(q => q("id").equals(id))))
}

export const operationStep = async (
  db: Connection,
  operation: Pick<MachineOperation, "id" | "attempts">,
  step: string,
  resourceId?: string | null,
): Promise<void> => {
  await db.execute(
    from("machine_operations")
      .where(q => q("id").equals(operation.id))
      .update({
        status: "running",
        step,
        attempts: Number(operation.attempts ?? 0) + 1,
        ...(resourceId !== undefined ? { resource_id: resourceId } : {}),
        updated_at: new Date(),
      }),
  )
}

export const operationSucceeded = async (db: Connection, id: string): Promise<void> => {
  const now = new Date()
  await db.execute(
    from("machine_operations")
      .where(q => q("id").equals(id))
      .update({ status: "succeeded", step: "done", last_error: "", updated_at: now, finished_at: now }),
  )
}

export const operationFailed = async (db: Connection, id: string, error: unknown): Promise<void> => {
  const now = new Date()
  await db.execute(
    from("machine_operations")
      .where(q => q("id").equals(id))
      .update({
        status: "failed",
        last_error: String((error as any)?.message ?? error).slice(0, 1000),
        updated_at: now,
        finished_at: now,
      }),
  )
}

/** Records uncertainty without closing the operation, so startup can reconcile it. */
export const operationRetry = async (db: Connection, id: string, step: string, error: unknown): Promise<void> => {
  await db.execute(
    from("machine_operations")
      .where(q => q("id").equals(id))
      .update({
        status: "running",
        step,
        last_error: String((error as any)?.message ?? error).slice(0, 1000),
        updated_at: new Date(),
        finished_at: null,
      }),
  )
}

export const unfinishedOperations = async (
  db: Connection,
  kind?: MachineOperationKind,
): Promise<MachineOperation[]> => {
  let query = from("machine_operations").where(q => q("finished_at").isNull())
  if (kind) query = query.where(q => q("kind").equals(kind))
  return ((await db.all(query.orderBy("created_at", "ASC"))) as any[]).map(shaped)
}
