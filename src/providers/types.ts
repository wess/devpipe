import type { Connection } from "@atlas/db"

export const PROVIDER_KINDS = ["digitalocean", "runpod", "docker"] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export type ProviderCapabilities = {
  gpu: boolean
  managedBootstrap: boolean
  persistentWorkspaces: boolean
  externalFirewall: boolean
  publicDns: boolean
  usageMetrics: boolean
}

export type Machine = {
  id: string
  name: string
  status: string
  address: string
  endpoint: string | null
  region: string
  size: string
  memoryMb: number
  vcpus: number
  monthly: number
  tags: string[]
  createdAt: string
}

export type Workspace = {
  id: string
  name: string
  region: string
  sizeGb: number
  machineIds: string[]
}

export type AddressRecord = {
  id: string
  name: string
  address: string
}

export type MachineCreate = {
  operationId: string
  name: string
  region: string
  size: string
  image?: string
  userData: string
  agentToken: string
  sshKeyIds?: number[]
  tags?: string[]
  workspace?: Workspace | null
}

export type ReleaseMachine = {
  machineId: string
  workspaceId?: string | null
  preserveWorkspace: boolean
}

export type ProviderCatalog = {
  sizes: {
    slug: string
    label: string
    memoryMb: number
    monthly: number
  }[]
  regions: { slug: string; label: string }[]
  defaults: { size: string; region: string }
  /** Tool ids the backend image can truthfully provide. Omit for the full catalogue. */
  toolIds?: string[]
  defaultTools?: string[]
}

export type ComputeBackend = {
  create(db: Connection, input: MachineCreate): Promise<Machine>
  inspect(db: Connection, id: string): Promise<Machine | null>
  listManaged(db: Connection): Promise<Machine[]>
  findByOperation(db: Connection, operationId: string): Promise<Machine | null>
  release(db: Connection, input: ReleaseMachine): Promise<void>
}

export type WorkspaceBackend = {
  create(db: Connection, input: { name: string; region: string; sizeGb: number }): Promise<Workspace>
  inspect(db: Connection, id: string): Promise<Workspace | null>
  listManaged(db: Connection): Promise<Workspace[]>
  ensureAttached(db: Connection, workspaceId: string, machineId: string): Promise<void>
  destroy(db: Connection, id: string): Promise<void>
}

export type NetworkBackend = {
  converge(db: Connection, sshSources: readonly string[]): Promise<void>
  publish(db: Connection, domain: string, name: string, address: string): Promise<string>
  remove(db: Connection, domain: string, name: string): Promise<void>
  list(db: Connection, domain: string): Promise<AddressRecord[]>
  removeById(db: Connection, domain: string, id: string): Promise<void>
}

export type UsageBackend = {
  bandwidthMbps(
    db: Connection,
    machineId: string,
    direction: "inbound" | "outbound",
    windowSeconds?: number,
  ): Promise<number | null>
}

export type MachineProvider = {
  kind: ProviderKind
  label: string
  capabilities: ProviderCapabilities
  configured(db: Connection): Promise<boolean>
  catalog?(db: Connection): Promise<ProviderCatalog>
  compute: ComputeBackend
  workspaces?: WorkspaceBackend
  network?: NetworkBackend
  usage?: UsageBackend
}

export class ProviderUnavailable extends Error {
  constructor(
    readonly kind: ProviderKind,
    message = `The ${kind} provider is not configured.`,
  ) {
    super(message)
    this.name = "ProviderUnavailable"
  }
}
