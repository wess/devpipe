import type { Connection } from "@atlas/db"
import { CREDENTIAL, getCredential } from "../settings/index.ts"
import type { Machine, MachineProvider, ProviderCatalog, Workspace } from "./types.ts"
import { ProviderUnavailable } from "./types.ts"

const API = "https://rest.runpod.io/v1"
const DAEMON_PORT = 7788

type Fetch = typeof fetch

type Pod = {
  id: string
  name?: string
  desiredStatus?: string
  env?: Record<string, string>
  cpuFlavorId?: string
  memoryInGb?: number
  vcpuCount?: number
  costPerHr?: number | string
  adjustedCostPerHr?: number | string
  lastStartedAt?: string
  networkVolume?: { id: string } | null
}

type RunpodVolume = {
  id: string
  name: string
  size: number
  dataCenterId: string
}

class RunpodError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "RunpodError"
  }
}

const tokenFor = async (db: Connection, override?: string): Promise<string> => {
  const token = override || process.env.RUNPOD_API_KEY || (await getCredential(db, CREDENTIAL.runpodToken))
  if (!token) throw new ProviderUnavailable("runpod", "No Runpod API key is configured.")
  return token
}

const request = async <T>(fetcher: Fetch, token: string, path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetcher(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  if (response.status === 204) return null as T
  const text = await response.text()
  if (!response.ok) {
    let message = text.trim()
    try {
      const body = JSON.parse(text)
      message = String(body.error ?? body.message ?? body.detail ?? message)
    } catch {
      // The plain response is already the best diagnostic available.
    }
    throw new RunpodError(response.status, message || `Runpod returned ${response.status}.`)
  }
  return (text ? JSON.parse(text) : null) as T
}

/** Validate a key without requiring the rest of the provider configuration. */
export const verifyRunpodToken = async (token: string, fetcher: Fetch = fetch): Promise<void> => {
  await request<Pod[]>(fetcher, token, "/pods?computeType=CPU")
}

const sizeSpec = (slug: string) => {
  const match = /^((?:cpu3|cpu5)[cgm])-(\d+)-(\d+)$/.exec(slug)
  if (!match) return { flavor: "cpu3c", vcpus: 2, memoryMb: 4096, slug: "cpu3c-2-4" }
  return {
    flavor: match[1],
    vcpus: Number(match[2]),
    memoryMb: Number(match[3]) * 1024,
    slug,
  }
}

const endpointFor = (id: string) => `https://${id}-${DAEMON_PORT}.proxy.runpod.net`

const machine = (pod: Pod): Machine => {
  const hourly = Number(pod.adjustedCostPerHr ?? pod.costPerHr ?? 0)
  const listedSize = pod.env?.DEVPIPE_SIZE
  const spec = sizeSpec(listedSize || `${pod.cpuFlavorId ?? "cpu3c"}-${pod.vcpuCount ?? 2}-${pod.memoryInGb ?? 4}`)
  const managed = pod.env?.DEVPIPE_MANAGED === "true"
  return {
    id: String(pod.id),
    name: String(pod.name ?? pod.id),
    status: pod.desiredStatus === "RUNNING" ? "active" : String(pod.desiredStatus ?? "unknown").toLowerCase(),
    // Runpod's HTTP proxy is the address. It terminates trusted TLS and carries
    // websocket upgrades to the daemon's exposed HTTP port.
    address: `${pod.id}-${DAEMON_PORT}.proxy.runpod.net`,
    endpoint: endpointFor(pod.id),
    region: String(pod.env?.DEVPIPE_REGION ?? ""),
    size: spec.slug,
    memoryMb: Number(pod.memoryInGb ?? spec.memoryMb / 1024) * 1024,
    vcpus: Number(pod.vcpuCount ?? spec.vcpus),
    monthly: hourly * 730,
    tags: managed ? ["devpipe", "devpipe-box"] : [],
    createdAt: String(pod.lastStartedAt ?? ""),
  }
}

const workspace = (volume: RunpodVolume): Workspace => ({
  id: String(volume.id),
  name: String(volume.name),
  region: String(volume.dataCenterId),
  sizeGb: Number(volume.size),
  machineIds: [],
})

const DEFAULT_REGIONS = ["US-GA-1", "US-KS-2", "EU-RO-1", "CA-MTL-1"]

const catalogFor = (regions: readonly string[]): ProviderCatalog => ({
  sizes: [
    { slug: "cpu3c-2-4", label: "Runpod CPU · 2 vCPU · 4 GB", memoryMb: 4096, monthly: 0 },
    { slug: "cpu3c-4-8", label: "Runpod CPU · 4 vCPU · 8 GB", memoryMb: 8192, monthly: 0 },
    { slug: "cpu3c-8-16", label: "Runpod CPU · 8 vCPU · 16 GB", memoryMb: 16_384, monthly: 0 },
  ],
  regions: regions.map(slug => ({ slug, label: slug })),
  defaults: { size: "cpu3c-2-4", region: regions[0] ?? "US-GA-1" },
  // The image contract guarantees the daemon and baseline shell tools. A
  // custom image may carry more, but the control plane must not promise it.
  toolIds: ["git", "ripgrep", "zsh", "fish"],
  defaultTools: ["git", "ripgrep"],
})

export const runpodProvider = (
  options: { fetch?: Fetch; apiKey?: string; image?: string; regions?: readonly string[] } = {},
): MachineProvider => {
  const fetcher = options.fetch ?? fetch
  const image = options.image ?? process.env.DEVPIPE_RUNPOD_IMAGE ?? ""
  const regions =
    options.regions ??
    (process.env.DEVPIPE_RUNPOD_REGIONS ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  const availableRegions = regions.length > 0 ? [...regions] : DEFAULT_REGIONS

  const call = async <T>(db: Connection, path: string, init?: RequestInit) =>
    request<T>(fetcher, await tokenFor(db, options.apiKey), path, init)

  const inspectPod = async (db: Connection, id: string): Promise<Machine | null> => {
    try {
      return machine(await call<Pod>(db, `/pods/${encodeURIComponent(id)}`))
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) return null
      throw error
    }
  }

  const inspectVolume = async (db: Connection, id: string): Promise<Workspace | null> => {
    try {
      return workspace(await call<RunpodVolume>(db, `/networkvolumes/${encodeURIComponent(id)}`))
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) return null
      throw error
    }
  }

  return {
    kind: "runpod",
    label: "Runpod",
    capabilities: {
      gpu: false,
      managedBootstrap: true,
      persistentWorkspaces: true,
      externalFirewall: false,
      publicDns: false,
      usageMetrics: false,
    },
    configured: async db => {
      if (!image) return false
      try {
        await call<Pod[]>(db, "/pods?computeType=CPU")
        return true
      } catch {
        return false
      }
    },
    catalog: async () => catalogFor(availableRegions),
    compute: {
      create: async (db, input) => {
        if (!image) throw new ProviderUnavailable("runpod", "DEVPIPE_RUNPOD_IMAGE is not configured.")
        const spec = sizeSpec(input.size)
        const pod = await call<Pod>(db, "/pods", {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            imageName: image,
            cloudType: "SECURE",
            computeType: "CPU",
            cpuFlavorIds: [spec.flavor],
            cpuFlavorPriority: "availability",
            vcpuCount: spec.vcpus,
            containerDiskInGb: 20,
            dataCenterIds: [input.region],
            dataCenterPriority: "custom",
            ports: [`${DAEMON_PORT}/http`],
            supportPublicIp: true,
            interruptible: false,
            ...(input.workspace
              ? { networkVolumeId: input.workspace.id, volumeMountPath: "/home/devpipe/work" }
              : { volumeInGb: 0 }),
            env: {
              DEVPIPE_TOKEN: input.agentToken,
              DEVPIPE_ADDR: `0.0.0.0:${DAEMON_PORT}`,
              DEVPIPE_INSECURE: "1",
              DEVPIPE_MANAGED: "true",
              DEVPIPE_OPERATION_ID: input.operationId,
              DEVPIPE_SIZE: spec.slug,
              DEVPIPE_REGION: input.region,
            },
          }),
        })
        return machine(pod)
      },
      inspect: inspectPod,
      listManaged: async db =>
        (await call<Pod[]>(db, "/pods")).filter(pod => pod.env?.DEVPIPE_MANAGED === "true").map(machine),
      findByOperation: async (db, operationId) => {
        const pod = (await call<Pod[]>(db, "/pods")).find(row => row.env?.DEVPIPE_OPERATION_ID === operationId)
        return pod ? machine(pod) : null
      },
      release: async (db, input) => {
        try {
          await call<null>(db, `/pods/${encodeURIComponent(input.machineId)}`, { method: "DELETE" })
        } catch (error) {
          if (!(error instanceof RunpodError) || error.status !== 404) throw error
        }
      },
    },
    workspaces: {
      create: async (db, input) =>
        workspace(
          await call<RunpodVolume>(db, "/networkvolumes", {
            method: "POST",
            body: JSON.stringify({ dataCenterId: input.region, name: input.name, size: input.sizeGb }),
          }),
        ),
      inspect: inspectVolume,
      listManaged: async db =>
        (await call<RunpodVolume[]>(db, "/networkvolumes"))
          .filter(volume => volume.name.startsWith("dp-"))
          .map(workspace),
      // Runpod network volumes are selected at Pod creation. Verify rather
      // than issue a meaningless post-create attach request.
      ensureAttached: async (db, workspaceId, machineId) => {
        const pod = await call<Pod>(db, `/pods/${encodeURIComponent(machineId)}?includeNetworkVolume=true`)
        if (pod.networkVolume?.id !== workspaceId) {
          throw new Error("The Runpod Pod was created without the requested network volume.")
        }
      },
      destroy: async (db, id) => {
        try {
          await call<null>(db, `/networkvolumes/${encodeURIComponent(id)}`, { method: "DELETE" })
        } catch (error) {
          if (!(error instanceof RunpodError) || error.status !== 404) throw error
        }
      },
    },
  }
}
