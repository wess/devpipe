import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import { beginOperation, operationStep } from "../src/machine/operations.ts"
import { resumeReleases } from "../src/machine/recovery.ts"
import { dockerProvider } from "../src/providers/docker.ts"
import type { Machine } from "../src/providers/types.ts"
import { db } from "./setup.ts"

const contract = process.env.DEVPIPE_DOCKER_CONTRACT === "1" ? test : test.skip

contract(
  "the Docker adapter creates a reachable daemon and preserves its workspace",
  async () => {
    const suffix = randomUUID()
    const provider = dockerProvider({ image: process.env.DEVPIPE_DOCKER_IMAGE ?? "devpipe-box:local" })
    expect(await provider.configured(db)).toBe(true)
    if (!provider.workspaces) throw new Error("Docker workspaces are missing.")

    const workspace = await provider.workspaces.create(db, {
      name: `devpipe-contract-${suffix}`,
      region: "local",
      sizeGb: 1,
    })
    let machine: Machine | null = null
    try {
      machine = await provider.compute.create(db, {
        operationId: suffix,
        name: `devpipe-contract-${suffix}`,
        region: "local",
        size: "docker-standard",
        userData: "",
        agentToken: "contract-test-token",
        workspace,
      })
      expect((await provider.compute.findByOperation(db, suffix))?.id).toBe(machine.id)
      expect((await provider.compute.listManaged(db)).some(item => item.id === machine?.id)).toBe(true)

      const health = await fetch(`${machine.endpoint}/v1/health`)
      expect(await health.text()).toBe("ok")
      const sessions = await fetch(`${machine.endpoint}/v1/sessions`, {
        headers: { authorization: "Bearer contract-test-token" },
      })
      expect(await sessions.json()).toEqual([])
    } finally {
      machine ??= await provider.compute.findByOperation(db, suffix)
      if (machine) {
        await provider.compute.release(db, {
          machineId: machine.id,
          workspaceId: workspace.id,
          preserveWorkspace: true,
        })
      }
      await provider.workspaces.destroy(db, workspace.id)
    }
  },
  120_000,
)

contract(
  "an interrupted Docker release finishes from the operation journal",
  async () => {
    const suffix = randomUUID()
    const provider = dockerProvider({ image: process.env.DEVPIPE_DOCKER_IMAGE ?? "devpipe-box:local" })
    if (!provider.workspaces) throw new Error("Docker workspaces are missing.")
    const userRows = (await db.execute(
      from("users")
        .insert({
          email: `${suffix}@example.com`,
          username: `u${suffix.replaceAll("-", "").slice(0, 20)}`,
          password: "unused",
        })
        .returning("id"),
    )) as any[]
    const workspaceResource = await provider.workspaces.create(db, {
      name: `devpipe-contract-${suffix}`,
      region: "local",
      sizeGb: 1,
    })
    const workspaceRows = (await db.execute(
      from("workspaces")
        .insert({
          user_id: userRows[0].id,
          name: "contract",
          provider: "docker",
          region: "local",
          size_gb: 1,
          volume_id: workspaceResource.id,
          volume_name: workspaceResource.name,
        })
        .returning("id"),
    )) as any[]
    const machine = await provider.compute.create(db, {
      operationId: suffix,
      name: `devpipe-contract-${suffix}`,
      region: "local",
      size: "docker-standard",
      userData: "",
      agentToken: "contract-test-token",
      workspace: workspaceResource,
    })
    const boxRows = (await db.execute(
      from("boxes")
        .insert({
          user_id: userRows[0].id,
          name: "contract",
          hostname: `contract-${suffix}.local`,
          provider: "docker",
          provider_id: machine.id,
          endpoint: machine.endpoint,
          workspace_id: workspaceRows[0].id,
          region: "local",
          size: "docker-standard",
          status: "ready",
          agent_token: "contract-test-token",
          manifest: "{}",
        })
        .returning("id"),
    )) as any[]
    const operation = await beginOperation(db, {
      idempotencyKey: `contract-sleep:${suffix}`,
      provider: "docker",
      kind: "sleep",
      boxId: boxRows[0].id,
      workspaceId: workspaceRows[0].id,
    })
    await operationStep(db, operation, "releasing-machine", machine.id)

    try {
      await resumeReleases(db)
      expect(await provider.compute.inspect(db, machine.id)).toBeNull()
      const box = (await db.one(from("boxes").where(q => q("id").equals(boxRows[0].id)))) as any
      expect(box.status).toBe("asleep")
      expect(box.provider_id).toBeNull()
      const recovered = (await db.one(from("machine_operations").where(q => q("id").equals(operation.id)))) as any
      expect(recovered.status).toBe("succeeded")
    } finally {
      const leftover = await provider.compute.findByOperation(db, suffix)
      if (leftover) {
        await provider.compute.release(db, {
          machineId: leftover.id,
          workspaceId: workspaceResource.id,
          preserveWorkspace: true,
        })
      }
      await provider.workspaces.destroy(db, workspaceResource.id)
    }
  },
  120_000,
)
