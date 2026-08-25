import type { Connection } from "@atlas/db"
import * as ocean from "../boxes/digitalocean.ts"
import { CREDENTIAL, getCredential } from "../settings/index.ts"
import type { Machine, MachineProvider, Workspace } from "./types.ts"
import { ProviderUnavailable } from "./types.ts"

const tokenFor = async (db: Connection): Promise<string> => {
  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) throw new ProviderUnavailable("digitalocean", "No DigitalOcean provider is configured yet.")
  return token
}

const machine = (droplet: ocean.Droplet): Machine => ({
  id: String(droplet.id),
  name: droplet.name,
  status: droplet.status,
  address: droplet.ip,
  // Public VM backends are derived from the stable box hostname. An explicit
  // endpoint is reserved for private/container backends that need relaying.
  endpoint: null,
  region: droplet.region,
  size: droplet.size,
  memoryMb: droplet.memoryMb,
  vcpus: droplet.vcpus,
  monthly: droplet.monthly,
  tags: droplet.tags,
  createdAt: droplet.createdAt,
})

const workspace = (volume: ocean.Volume): Workspace => ({
  id: volume.id,
  name: volume.name,
  region: volume.region,
  sizeGb: volume.sizeGb,
  machineIds: volume.dropletIds.map(String),
})

const operationTag = (id: string) => `devpipe-op-${id.replace(/[^a-z0-9-]/gi, "").slice(0, 48)}`

export const digitalOceanProvider: MachineProvider = {
  kind: "digitalocean",
  label: "DigitalOcean",
  capabilities: {
    gpu: true,
    managedBootstrap: false,
    persistentWorkspaces: true,
    externalFirewall: true,
    publicDns: true,
    usageMetrics: true,
  },
  configured: async db => Boolean(await getCredential(db, CREDENTIAL.digitalOceanToken)),
  compute: {
    create: async (db, input) => {
      const token = await tokenFor(db)
      return machine(
        await ocean.createDroplet(token, {
          name: input.name,
          region: input.region,
          size: input.size,
          image: input.image,
          userData: input.userData,
          sshKeyIds: input.sshKeyIds,
          tags: [...new Set([...(input.tags ?? []), operationTag(input.operationId)])],
        }),
      )
    },
    inspect: async (db, id) => {
      const found = await ocean.getDroplet(await tokenFor(db), Number(id))
      return found ? machine(found) : null
    },
    listManaged: async db =>
      (await ocean.listDroplets(await tokenFor(db))).filter(d => d.tags.includes(ocean.BOX_TAG)).map(machine),
    findByOperation: async (db, operationId) => {
      const tag = operationTag(operationId)
      const found = (await ocean.listDroplets(await tokenFor(db))).find(d => d.tags.includes(tag))
      return found ? machine(found) : null
    },
    release: async (db, input) => {
      const token = await tokenFor(db)
      if (input.preserveWorkspace && input.workspaceId) {
        const volume = await ocean.getVolume(token, input.workspaceId)
        if (!volume) throw new Error("DigitalOcean no longer has that workspace volume.")
        if (volume.dropletIds.includes(Number(input.machineId))) {
          await ocean.detachVolume(token, input.workspaceId, Number(input.machineId))
        } else if (volume.dropletIds.length > 0) {
          throw new Error("That workspace is attached to another machine.")
        }
      }
      await ocean.destroyDroplet(token, Number(input.machineId))
    },
  },
  workspaces: {
    create: async (db, input) => workspace(await ocean.createVolume(await tokenFor(db), input)),
    inspect: async (db, id) => {
      const found = await ocean.getVolume(await tokenFor(db), id)
      return found ? workspace(found) : null
    },
    listManaged: async db =>
      (await ocean.listVolumes(await tokenFor(db))).filter(v => v.name.startsWith("dp-")).map(workspace),
    ensureAttached: async (db, workspaceId, machineId) => {
      const token = await tokenFor(db)
      const found = await ocean.getVolume(token, workspaceId)
      if (!found) throw new Error("DigitalOcean no longer has that workspace volume.")
      const wanted = Number(machineId)
      if (found.dropletIds.includes(wanted)) return
      if (found.dropletIds.length > 0) throw new Error("That workspace is attached to another machine.")
      await ocean.attachVolume(token, workspaceId, wanted)
    },
    destroy: async (db, id) => ocean.destroyVolume(await tokenFor(db), id),
  },
  network: {
    converge: async (db, sshSources) => {
      await ocean.ensureBoxFirewall(await tokenFor(db), ocean.BOX_TAG, sshSources)
    },
    publish: async (db, domain, name, address) =>
      String(await ocean.upsertRecord(await tokenFor(db), domain, name, address)),
    remove: async (db, domain, name) => ocean.deleteRecord(await tokenFor(db), domain, name),
    list: async (db, domain) =>
      (await ocean.listRecords(await tokenFor(db), domain)).map(record => ({
        id: String(record.id),
        name: record.name,
        address: record.data,
      })),
    removeById: async (db, domain, id) => ocean.deleteRecordById(await tokenFor(db), domain, Number(id)),
  },
  usage: {
    bandwidthMbps: async (db, machineId, direction, windowSeconds) =>
      ocean.bandwidthMbps(await tokenFor(db), machineId, direction, windowSeconds),
  },
}
