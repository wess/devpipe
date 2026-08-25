import { describe, expect, test } from "bun:test"
import { dockerProvider } from "../src/providers/docker.ts"
import { digitalOceanProvider } from "../src/providers/digitalocean.ts"
import { providerFor } from "../src/providers/index.ts"
import { db } from "./setup.ts"

const machineInspect = (id = "container-1") =>
  JSON.stringify([
    {
      Id: id,
      Name: "/alfa-devpipe-test",
      Created: "2026-08-25T00:00:00Z",
      State: { Running: true, Status: "running" },
      Config: { Labels: { "devpipe.managed": "true", "devpipe.size": "docker-standard" } },
      HostConfig: { Memory: 4 * 1024 * 1024 * 1024, NanoCpus: 2_000_000_000 },
      NetworkSettings: { Ports: { "7788/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] } },
    },
  ])

describe("machine provider contracts", () => {
  test("every registered backend owns compute lifecycle semantics", () => {
    for (const provider of [providerFor("digitalocean"), providerFor("docker")]) {
      expect(provider.compute.create).toBeFunction()
      expect(provider.compute.inspect).toBeFunction()
      expect(provider.compute.findByOperation).toBeFunction()
      expect(provider.compute.release).toBeFunction()
    }
    expect(digitalOceanProvider.capabilities.externalFirewall).toBe(true)
    expect(providerFor("docker").capabilities.externalFirewall).toBe(false)
  })

  test("Docker creates a constrained daemon container and preserves its named workspace", async () => {
    const calls: string[][] = []
    const run = async (args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === "run") return "container-1"
      if (args[0] === "inspect") return machineInspect()
      if (args[0] === "rm") return "container-1"
      throw new Error(`unexpected docker command: ${args.join(" ")}`)
    }
    const provider = dockerProvider({ run, image: "devpipe-box:test" })
    const machine = await provider.compute.create(db, {
      operationId: "op-1",
      name: "Alfa Devpipe Test",
      region: "local",
      size: "docker-standard",
      userData: "",
      agentToken: "secret",
      workspace: { id: "dp-1-main", name: "main", region: "local", sizeGb: 10, machineIds: [] },
    })
    expect(machine.endpoint).toBe("http://127.0.0.1:49152")
    const create = calls.find(args => args[0] === "run") ?? []
    expect(create).toContain("127.0.0.1::7788")
    expect(create).toContain("type=volume,source=dp-1-main,target=/home/devpipe/work")
    expect(create).toContain("devpipe.operation=op-1")

    await provider.compute.release(db, {
      machineId: machine.id,
      workspaceId: "dp-1-main",
      preserveWorkspace: true,
    })
    expect(calls.some(args => args[0] === "rm" && args.includes("container-1"))).toBe(true)
    expect(calls.some(args => args[0] === "volume" && args[1] === "rm")).toBe(false)
  })

  test("Docker finds a machine by its durable operation label", async () => {
    const run = async (args: readonly string[]) => {
      if (args[0] === "ps") return "container-1"
      if (args[0] === "inspect") return machineInspect()
      throw new Error(`unexpected docker command: ${args.join(" ")}`)
    }
    const found = await dockerProvider({ run }).compute.findByOperation(db, "op-7")
    expect(found?.id).toBe("container-1")
    expect(found?.status).toBe("active")
  })
})
