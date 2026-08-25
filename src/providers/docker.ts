import type { Machine, MachineProvider, ProviderCatalog, Workspace } from "./types.ts"

type Run = (args: readonly string[]) => Promise<string>

class DockerCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(stderr.trim() || `docker ${args.join(" ")} failed`)
    this.name = "DockerCommandError"
  }
}

const runDocker: Run = async args => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new DockerCommandError(args, stderr)
  return stdout.trim()
}

const DOCKER_REGION = "local"
const DOCKER_SIZE = "docker-standard"

const catalog: ProviderCatalog = {
  sizes: [
    {
      slug: DOCKER_SIZE,
      label: "Local container · 2 CPU · 4 GB",
      memoryMb: 4096,
      monthly: 0,
    },
  ],
  regions: [{ slug: DOCKER_REGION, label: "This Docker host" }],
  defaults: { size: DOCKER_SIZE, region: DOCKER_REGION },
  toolIds: ["git", "ripgrep"],
  defaultTools: ["git", "ripgrep"],
}

const parsed = <T>(text: string): T => JSON.parse(text) as T

const inspectMachine = async (run: Run, id: string): Promise<Machine | null> => {
  let rows: any[]
  try {
    rows = parsed<any[]>(await run(["inspect", id]))
  } catch (err) {
    if (err instanceof DockerCommandError && /no such (object|container)/i.test(err.stderr)) return null
    throw err
  }
  const row = rows[0]
  if (!row) return null
  const port = row.NetworkSettings?.Ports?.["7788/tcp"]?.[0]?.HostPort
  const labels = row.Config?.Labels ?? {}
  return {
    id: String(row.Id ?? id),
    name: String(row.Name ?? "").replace(/^\//, ""),
    status: row.State?.Running ? "active" : String(row.State?.Status ?? "unknown"),
    address: port ? "127.0.0.1" : "",
    endpoint: port ? `http://127.0.0.1:${port}` : null,
    region: DOCKER_REGION,
    size: String(labels["devpipe.size"] ?? DOCKER_SIZE),
    memoryMb: Math.round(Number(row.HostConfig?.Memory ?? 0) / 1024 / 1024),
    vcpus: Number(row.HostConfig?.NanoCpus ?? 0) / 1_000_000_000,
    monthly: 0,
    tags: Object.entries(labels)
      .filter(([key, value]) => key.startsWith("devpipe.") && value === "true")
      .map(([key]) => key),
    createdAt: String(row.Created ?? ""),
  }
}

const inspectWorkspace = async (run: Run, id: string): Promise<Workspace | null> => {
  let rows: any[]
  try {
    rows = parsed<any[]>(await run(["volume", "inspect", id]))
  } catch (err) {
    if (err instanceof DockerCommandError && /no such volume/i.test(err.stderr)) return null
    throw err
  }
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.Name ?? id),
    name: String(row.Labels?.["devpipe.name"] ?? row.Name ?? id),
    region: DOCKER_REGION,
    sizeGb: Number(row.Labels?.["devpipe.size_gb"] ?? 0),
    machineIds: [],
  }
}

export const dockerProvider = (options: { run?: Run; image?: string } = {}): MachineProvider => {
  const run = options.run ?? runDocker
  const image = options.image ?? process.env.DEVPIPE_DOCKER_IMAGE ?? "devpipe-box:local"

  return {
    kind: "docker",
    label: "Local Docker",
    capabilities: {
      gpu: false,
      managedBootstrap: true,
      persistentWorkspaces: true,
      externalFirewall: false,
      publicDns: false,
      usageMetrics: false,
    },
    configured: async () => {
      try {
        await run(["info", "--format", "{{json .ServerVersion}}"])
        await run(["image", "inspect", image, "--format", "{{json .Id}}"])
        return true
      } catch {
        return false
      }
    },
    catalog: async () => catalog,
    compute: {
      create: async (_db, input) => {
        const name = input.name
          .toLowerCase()
          .replace(/[^a-z0-9_.-]+/g, "-")
          .slice(0, 63)
        const args = [
          "run",
          "--detach",
          "--name",
          name,
          "--label",
          "devpipe.managed=true",
          "--label",
          `devpipe.operation=${input.operationId}`,
          "--label",
          `devpipe.size=${input.size || DOCKER_SIZE}`,
          "--memory",
          "4g",
          "--cpus",
          "2",
          "--publish",
          "127.0.0.1::7788",
          "--env",
          `DEVPIPE_TOKEN=${input.agentToken}`,
          "--env",
          "DEVPIPE_ADDR=0.0.0.0:7788",
          "--env",
          "DEVPIPE_INSECURE=1",
        ]
        if (input.workspace) {
          args.push("--mount", `type=volume,source=${input.workspace.id},target=/home/devpipe/work`)
        }
        args.push(image)
        const id = await run(args)
        const found = await inspectMachine(run, id)
        if (!found) throw new Error("Docker created a container that could not be inspected.")
        return found
      },
      inspect: async (_db, id) => inspectMachine(run, id),
      listManaged: async _db => {
        const ids = (await run(["ps", "--all", "--filter", "label=devpipe.managed=true", "--quiet"]))
          .split("\n")
          .filter(Boolean)
        const machines = await Promise.all(ids.map(id => inspectMachine(run, id)))
        return machines.filter((item): item is Machine => item !== null)
      },
      findByOperation: async (_db, operationId) => {
        const id = (await run(["ps", "--all", "--filter", `label=devpipe.operation=${operationId}`, "--quiet"]))
          .split("\n")
          .find(Boolean)
        return id ? inspectMachine(run, id) : null
      },
      release: async (_db, input) => {
        try {
          await run(["rm", "--force", input.machineId])
        } catch (err) {
          if (!(err instanceof DockerCommandError) || !/no such container/i.test(err.stderr)) throw err
        }
      },
    },
    workspaces: {
      create: async (_db, input) => {
        const id = await run([
          "volume",
          "create",
          "--label",
          "devpipe.workspace=true",
          "--label",
          `devpipe.name=${input.name}`,
          "--label",
          `devpipe.size_gb=${input.sizeGb}`,
          input.name,
        ])
        const found = await inspectWorkspace(run, id)
        if (!found) throw new Error("Docker created a volume that could not be inspected.")
        return found
      },
      inspect: async (_db, id) => inspectWorkspace(run, id),
      listManaged: async _db => {
        const ids = (await run(["volume", "ls", "--filter", "label=devpipe.workspace=true", "--quiet"]))
          .split("\n")
          .filter(Boolean)
        const workspaces = await Promise.all(ids.map(id => inspectWorkspace(run, id)))
        return workspaces.filter((item): item is Workspace => item !== null)
      },
      // A Docker volume is attached when the container is created. Keeping the
      // method makes that lifecycle difference explicit without teaching the
      // caller Docker's mount syntax.
      ensureAttached: async () => {},
      destroy: async (_db, id) => {
        try {
          await run(["volume", "rm", id])
        } catch (err) {
          if (!(err instanceof DockerCommandError) || !/no such volume/i.test(err.stderr)) throw err
        }
      },
    },
  }
}
