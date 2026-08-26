import { describe, expect, test } from "bun:test"
import { dockerProvider } from "../src/providers/docker.ts"
import { digitalOceanProvider } from "../src/providers/digitalocean.ts"
import { providerFor } from "../src/providers/index.ts"
import { runpodProvider } from "../src/providers/runpod.ts"
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
    for (const provider of [providerFor("digitalocean"), providerFor("runpod"), providerFor("docker")]) {
      expect(provider.compute.create).toBeFunction()
      expect(provider.compute.inspect).toBeFunction()
      expect(provider.compute.findByOperation).toBeFunction()
      expect(provider.compute.release).toBeFunction()
    }
    expect(digitalOceanProvider.capabilities.externalFirewall).toBe(true)
    expect(providerFor("runpod").capabilities.publicDns).toBe(false)
    expect(providerFor("docker").capabilities.externalFirewall).toBe(false)
  })

  test("Runpod creates a managed CPU Pod on the shared image and exposes the daemon proxy", async () => {
    const calls: { path: string; method: string; body: any }[] = []
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? "GET"
      const body = init.body ? JSON.parse(String(init.body)) : null
      calls.push({ path: `${url.pathname}${url.search}`, method, body })
      if (url.pathname === "/v1/pods" && method === "POST") {
        return Response.json({
          id: "pod-1",
          name: body.name,
          desiredStatus: "RUNNING",
          env: body.env,
          cpuFlavorId: "cpu3c",
          vcpuCount: 2,
          memoryInGb: 4,
          costPerHr: "0.12",
          networkVolume: { id: "vol-1" },
        })
      }
      if (url.pathname === "/v1/pods/pod-1" && method === "DELETE") return new Response(null, { status: 204 })
      throw new Error(`unexpected Runpod request: ${method} ${url}`)
    }) as unknown as typeof fetch
    const provider = runpodProvider({
      fetch: fetcher,
      apiKey: "rpa_test",
      image: "registry.example/devpipe-box:test",
      regions: ["US-GA-1"],
    })
    const created = await provider.compute.create(db, {
      operationId: "op-22",
      name: "alfa-box",
      region: "US-GA-1",
      size: "cpu3c-2-4",
      userData: "ignored by the managed image",
      agentToken: "box-secret",
      workspace: { id: "vol-1", name: "main", region: "US-GA-1", sizeGb: 20, machineIds: [] },
    })
    expect(created.endpoint).toBe("https://pod-1-7788.proxy.runpod.net")
    expect(created.monthly).toBeCloseTo(87.6)
    const create = calls[0]
    expect(create.body.imageName).toBe("registry.example/devpipe-box:test")
    expect(create.body.computeType).toBe("CPU")
    expect(create.body.networkVolumeId).toBe("vol-1")
    expect(create.body.env.DEVPIPE_OPERATION_ID).toBe("op-22")
    expect(create.body.ports).toEqual(["7788/http"])

    await provider.compute.release(db, {
      machineId: created.id,
      workspaceId: "vol-1",
      preserveWorkspace: true,
    })
    expect(calls.at(-1)).toMatchObject({ path: "/v1/pods/pod-1", method: "DELETE" })
  })

  test("Runpod recovers a Pod by the durable operation marker", async () => {
    const fetcher = (async () =>
      Response.json([
        {
          id: "pod-9",
          desiredStatus: "RUNNING",
          env: {
            DEVPIPE_MANAGED: "true",
            DEVPIPE_OPERATION_ID: "op-9",
            DEVPIPE_SIZE: "cpu3c-4-8",
            DEVPIPE_REGION: "EU-RO-1",
          },
        },
      ])) as unknown as typeof fetch
    const found = await runpodProvider({ fetch: fetcher, apiKey: "rpa_test", image: "devpipe:test" }).compute
      .findByOperation(db, "op-9")
    expect(found?.id).toBe("pod-9")
    expect(found?.size).toBe("cpu3c-4-8")
    expect(found?.endpoint).toBe("https://pod-9-7788.proxy.runpod.net")
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
