import type { Connection } from "@atlas/db"
import { digitalOceanProvider } from "./digitalocean.ts"
import { dockerProvider } from "./docker.ts"
import { runpodProvider } from "./runpod.ts"
import type { MachineProvider, ProviderKind } from "./types.ts"
import { PROVIDER_KINDS, ProviderUnavailable } from "./types.ts"

const providers: Record<ProviderKind, MachineProvider> = {
  digitalocean: digitalOceanProvider,
  runpod: runpodProvider(),
  docker: dockerProvider(),
}

export const providerKind = (value: unknown): ProviderKind => {
  const kind = String(value ?? "").toLowerCase()
  if ((PROVIDER_KINDS as readonly string[]).includes(kind)) return kind as ProviderKind
  throw new ProviderUnavailable("digitalocean", `Unknown machine provider: ${kind || "(empty)"}.`)
}

export const defaultProviderKind = (): ProviderKind =>
  providerKind(process.env.DEVPIPE_MACHINE_PROVIDER || "digitalocean")

export const providerFor = (kind: unknown): MachineProvider => providers[providerKind(kind)]

export const activeProvider = (): MachineProvider => providerFor(defaultProviderKind())

export const requireProvider = async (db: Connection, kind?: unknown): Promise<MachineProvider> => {
  const provider = kind === undefined ? activeProvider() : providerFor(kind)
  if (!(await provider.configured(db))) {
    throw new ProviderUnavailable(provider.kind, `The ${provider.label} provider is not configured yet.`)
  }
  return provider
}

export type { MachineProvider, ProviderKind } from "./types.ts"
export { ProviderUnavailable } from "./types.ts"
