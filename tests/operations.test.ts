import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import {
  beginOperation,
  operationFailed,
  operationStep,
  operationSucceeded,
  unfinishedOperations,
} from "../src/machine/operations.ts"
import { db, truncateAll } from "./setup.ts"

beforeEach(truncateAll)

describe("the provider operation journal", () => {
  test("writes the intent before work starts and reuses an idempotency key", async () => {
    const first = await beginOperation(db, {
      idempotencyKey: "provision:box:1",
      provider: "digitalocean",
      kind: "provision",
      boxId: null,
      payload: { host: "alfa" },
    })
    const again = await beginOperation(db, {
      idempotencyKey: "provision:box:1",
      provider: "digitalocean",
      kind: "provision",
    })
    expect(again.id).toBe(first.id)
    expect(again.payload).toEqual({ host: "alfa" })
  })

  test("keeps the provider resource id while an operation is unfinished", async () => {
    const operation = await beginOperation(db, {
      idempotencyKey: "wake:box:2",
      provider: "docker",
      kind: "wake",
    })
    await operationStep(db, operation, "machine-created", "container-1")

    const pending = await unfinishedOperations(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ status: "running", step: "machine-created", resource_id: "container-1" })

    await operationSucceeded(db, operation.id)
    expect(await unfinishedOperations(db)).toHaveLength(0)
  })

  test("records a bounded error instead of forgetting a failed mutation", async () => {
    const operation = await beginOperation(db, {
      idempotencyKey: "destroy:box:3",
      provider: "digitalocean",
      kind: "destroy",
    })
    await operationFailed(db, operation.id, new Error("provider refused"))
    const row = (await db.one(from("machine_operations").where(q => q("id").equals(operation.id)))) as any
    expect(row.status).toBe("failed")
    expect(row.last_error).toBe("provider refused")
    expect(row.finished_at).not.toBeNull()
  })
})
