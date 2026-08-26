import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { atLeast } from "../auth/roles.ts"
import {
  beginOperation,
  type MachineOperation,
  operationFailed,
  operationRetry,
  operationStep,
  operationSucceeded,
  unfinishedOperations,
} from "../machine/operations.ts"
import { activeProvider, ProviderUnavailable, requireProvider } from "../providers/index.ts"
import type { Machine, MachineProvider } from "../providers/types.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { getSetting, SETTING } from "../settings/index.ts"
import { retireSharing } from "../shares/retire.ts"
import { withinCap } from "../spend/index.ts"
import { startMetering, startWorkspaceMetering, stopMetering } from "../spend/meter.ts"
import { audit } from "../util/audit.ts"
import { open, seal, secretsAvailable } from "../util/secretbox.ts"
import { isShell, SHELLS, type ShellName } from "../util/shell.ts"
import { randomToken, shortId } from "../util/token.ts"
import { rotateVaultToken } from "../vault/box.ts"
import { claimForBox } from "../workspaces/index.ts"
import { CATALOG, defaults, fits, memoryFor, REGIONS, resolve, SIZES, SYNAPSE_FILES } from "./catalog.ts"
import { cloudInit } from "./cloudinit.ts"
import { costCentsPerHour, gpuImageFor, gpuSizeFor, gpuSizes, isGpuSize, regionNames } from "./gpu.ts"
import { ASLEEP, sleepBox } from "./reclaim.ts"

const publicBox = (row: any) => ({
  id: row.id,
  name: row.name,
  hostname: row.hostname,
  region: row.region,
  size: row.size,
  status: row.status,
  status_detail: row.status_detail,
  ip: row.ip,
  shell: row.shell ?? "bash",
  synapse: Boolean(row.synapse),
  workspace_id: row.workspace_id ?? null,
  tools: safeTools(row.manifest),
  created_at: row.created_at,
  ready_at: row.ready_at,
  provider: row.provider,
})

const safeTools = (manifest: string): string[] => {
  try {
    return JSON.parse(manifest || "{}").tools ?? []
  } catch {
    return []
  }
}

/**
 * Puts the box firewall back the way it should be, on a timer.
 *
 * `ensureBoxFirewall` runs during provisioning, which covers a new box and
 * nothing else: a change to the rules reaches boxes that already exist only
 * when somebody happens to create another one. Closing outbound mail had to be
 * applied by hand to a running box for exactly that reason, and a control that
 * needs someone to remember it is not a control.
 *
 * Quiet when there is no provider configured, because an instance that sells
 * nothing has no boxes to protect and should not log about it hourly.
 */
export const convergeFirewall = async (db: Connection): Promise<boolean> => {
  try {
    const provider = activeProvider()
    if (!(await provider.configured(db)) || !provider.network) return false
    await provider.network.converge(db, await sshSources(db))
    return true
  } catch (err) {
    console.error("[devpipe] could not converge the box firewall:", err)
    return false
  }
}

/**
 * Extra addresses the operator wants to reach port 22 from.
 *
 * Whitespace and empty entries dropped rather than passed through: DigitalOcean
 * rejects the whole firewall for one malformed address, and a rules update that
 * fails leaves every box on the previous rules with nothing in the product
 * saying so.
 */
const sshSources = async (db: Connection): Promise<string[]> =>
  (await getSetting(db, SETTING.sshSources))
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)

/**
 * Builds the machine for a box row that already exists.
 *
 * Shared by creating a box and waking a sleeping one, because they are the same
 * act: the row, the name, the tools and the workspace all persist, and what is
 * being made is the droplet. Two copies of this would drift, and the half that
 * drifts is the one nobody tests — a woken box quietly missing the firewall, or
 * built from a stale image.
 *
 * Throws. The caller owns what a failure means, which differs: a failed create
 * releases a subscription, a failed wake leaves the box asleep to try again.
 */
export const provision = async (
  db: Connection,
  opts: {
    provider: MachineProvider
    operationKind: "provision" | "wake"
    idempotencyKey: string
    appUrl: string
    boxId: number
    userId: number
    hostname: string
    host: string
    domain: string
    region: string
    size: string
    tools: readonly string[]
    shell: string
    synapse: boolean
    agentToken: string
    /**
     * The box's vault credential, in the clear — this is the only moment it
     * exists outside the box, because only its hash is stored. A box that is
     * woken gets a fresh one rather than the old one back, which makes sleeping
     * a rotation rather than a way to keep a credential alive indefinitely.
     */
    vaultToken: string
    workspace: any | null
  },
): Promise<string> => {
  const operation = await beginOperation(db, {
    idempotencyKey: opts.idempotencyKey,
    provider: opts.provider.kind,
    kind: opts.operationKind,
    boxId: opts.boxId,
    workspaceId: opts.workspace?.id ?? null,
    payload: { domain: opts.domain, host: opts.host },
  })

  // Before the droplet, not after: the firewall is attached by tag, so it has
  // to exist by the time a droplet carrying that tag does. Creating the box
  // first would leave it briefly reachable on every port while cloud-init runs
  // as root — which is the window an opportunistic scanner is looking for.
  if (opts.provider.network) await opts.provider.network.converge(db, await sshSources(db))

  // A GPU box boots the provider's AI/ML-ready image instead of anything of
  // ours. The prebaked snapshot is Debian with no driver stack, and a card the
  // driver cannot see is hardware somebody is paying four dollars an hour for
  // and cannot use. There is deliberately no fallback for these: a GPU box that
  // quietly came up without CUDA is worse than one that failed to come up.
  const gpu = opts.provider.capabilities.gpu && isGpuSize(opts.size) ? await gpuSizeFor(db, opts.size) : null
  const gpuImage = gpu ? gpuImageFor(gpu) : ""

  // The prebaked image, when there is one. Empty falls through to the
  // provider's base image and a full install on first boot — slower, but a
  // snapshot somebody deleted must not stop boxes being made.
  const boxImage =
    gpu || opts.provider.capabilities.managedBootstrap ? "" : (await getSetting(db, SETTING.boxImage)).trim()
  const preinstalled = boxImage
    ? (await getSetting(db, SETTING.boxImageTools))
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    : []

  // Read once, not per attempt: these do not change between the image try and
  // the fallback, and awaiting inside the closure would make it async for no
  // reason.
  const daemonUrl = await getSetting(db, SETTING.daemonUrl)
  const cliUrl = await getSetting(db, SETTING.cliUrl)
  const sshKeyIds = (await getSetting(db, SETTING.sshKeyIds))
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)

  /**
   * One attempt, with or without the prebaked image.
   *
   * `preinstalled` has to move with it: the cloud-init that skips installing a
   * tool is only correct if the image actually carries it, so falling back to
   * the base image without also restoring the installs would produce a box
   * missing everything the snapshot was supposed to provide.
   */
  const create = (useImage: boolean) =>
    opts.provider.compute.create(db, {
      operationId: operation.id,
      name: opts.hostname,
      region: opts.region,
      size: opts.size,
      ...(gpuImage ? { image: gpuImage } : useImage && boxImage ? { image: boxImage } : {}),
      userData: cloudInit({
        preinstalled: useImage ? preinstalled : [],
        hostname: opts.hostname,
        agentToken: opts.agentToken,
        tools: opts.tools,
        daemonUrl,
        callbackUrl: `${opts.appUrl}/api/boxes/callback`,
        logUrl: `${opts.appUrl}/api/boxes/callback/log`,
        loginsUrl: `${opts.appUrl}/api/boxes/callback/logins`,
        callbackSecret: opts.agentToken,
        vaultToken: opts.vaultToken,
        vaultUrl: `${opts.appUrl}/api/box/vault`,
        cliUrl,
        shell: opts.shell,
        synapse: opts.synapse,
        // Without this the mount block is never written, and the volume
        // attaches to a box that has no idea it is there: ~/work is ordinary
        // disk, and every file in it dies with the machine that was the
        // disposable half.
        volumeName: opts.workspace?.volume_name,
      }),
      agentToken: opts.agentToken,
      workspace: opts.workspace
        ? {
            id: String(opts.workspace.volume_id),
            name: String(opts.workspace.volume_name),
            region: String(opts.workspace.region),
            sizeGb: Number(opts.workspace.size_gb),
            machineIds: [],
          }
        : null,
      // Without a key nobody can get onto a box that wedges during setup — the
      // first real provisioning run hung and there was no way to look at it.
      sshKeyIds,
      // `devpipe` for inventory, `devpipe-box` for the firewall: the control
      // plane wears the first, so rules hung on it reach a machine that is not
      // a box.
      tags: ["devpipe", "devpipe-box", `user-${opts.userId}`],
    })

  /**
   * Image first, base image second.
   *
   * A snapshot carries the disk size of the machine it was baked on, and the
   * provider refuses a droplet whose disk is smaller than its image — so an
   * image baked too large fails *every* small size with "Cannot create a
   * droplet with a smaller disk than the image". That happened on the first
   * real box. An image that cannot be used should cost somebody a slower boot,
   * never a box they could not create at all, so the failure falls back to the
   * base image and installs the tools the long way.
   */
  let machine: Machine | null = null
  try {
    await operationStep(db, operation, "creating-machine")
    machine = await create(true)
  } catch (err) {
    try {
      machine = await opts.provider.compute.findByOperation(db, operation.id)
    } catch (lookupError) {
      await operationRetry(db, operation.id, "create-uncertain", lookupError)
      throw err
    }
    if (machine) {
      // The provider accepted the create and the response was lost. Continue
      // with the tagged resource instead of creating a second one.
    } else {
      // A GPU box has nowhere to fall back to — see `gpuImage` above.
      if (!boxImage || gpu) {
        await operationFailed(db, operation.id, err)
        throw err
      }
      console.error(`[devpipe] the prebaked image would not boot ${opts.size}, building from base:`, err)
      try {
        machine = await create(false)
      } catch (fallbackError) {
        try {
          machine = await opts.provider.compute.findByOperation(db, operation.id)
        } catch (lookupError) {
          await operationRetry(db, operation.id, "fallback-create-uncertain", lookupError)
          throw fallbackError
        }
        if (!machine) {
          await operationFailed(db, operation.id, fallbackError)
          throw fallbackError
        }
      }
    }
  }

  try {
    await operationStep(db, operation, "machine-created", machine.id)
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(opts.boxId))
        .update({
          provider: opts.provider.kind,
          provider_id: machine.id,
          endpoint: machine.endpoint,
          status: "installing",
          last_active_at: new Date(),
        }),
    )

    // The clock starts here, not when the box says it is ready. The provider
    // charges for a machine from the moment it exists. Provider responses carry
    // the current rate; the DigitalOcean catalogue remains the fallback for
    // older responses that only identify a size. Docker reports zero.
    const providerRate = machine.monthly > 0 ? (machine.monthly * 100) / 730 : 0
    await startMetering(
      db,
      opts.boxId,
      providerRate || (opts.provider.kind === "digitalocean" ? await costCentsPerHour(db, opts.size) : 0),
    )
  } catch (err) {
    // The provider call succeeded and the database did not. Findable by the
    // operation tag, and removed here rather than left as invisible spend.
    try {
      await opts.provider.compute.release(db, {
        machineId: machine.id,
        workspaceId: opts.workspace?.volume_id ?? null,
        preserveWorkspace: Boolean(opts.workspace),
      })
      await operationFailed(db, operation.id, err)
    } catch (cleanupError) {
      await operationRetry(db, operation.id, "cleanup-needed", cleanupError)
      console.error("[devpipe] could not clean up a failed provision:", cleanupError)
    }
    throw err
  }

  // The slow half is detached from the request, but not from durable state.
  // `resumeProvisioning` picks the operation back up after an API restart.
  void finishProvisioning(
    db,
    opts.provider,
    operation,
    opts.boxId,
    machine.id,
    opts.workspace,
    opts.domain,
    opts.host,
  ).catch(err => console.error(`[devpipe] could not finish provisioning ${opts.hostname}:`, err))
  return machine.id
}

/**
 * Makes a workspace for somebody who did not ask for one.
 *
 * Named after the box so it is recognisable in settings later, and uniquely
 * enough that creating a second box does not collide with the first. The row
 * looks exactly like one somebody made deliberately — it is theirs, it is
 * listed, and they can delete it — because it is.
 */
const grantWorkspace = async (
  db: Connection,
  provider: MachineProvider,
  userId: number,
  region: string,
  sizeGb: number,
  boxName: string,
): Promise<any> => {
  const base =
    (boxName || "box")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24) || "box"
  const name = `${base}-files`
  const volumeName = `dp-${userId}-${name}-${shortId(4)}`.slice(0, 60)
  if (!provider.workspaces) throw new Error(`${provider.label} does not support persistent workspaces.`)
  const operation = await beginOperation(db, {
    idempotencyKey: `workspace.grant:${userId}:${volumeName}`,
    provider: provider.kind,
    kind: "workspace.create",
  })
  await operationStep(db, operation, "creating-workspace")
  const volume = await provider.workspaces.create(db, { name: volumeName, region, sizeGb })
  await operationStep(db, operation, "workspace-created", volume.id)
  const rows = (await db.execute(
    from("workspaces")
      .insert({
        user_id: userId,
        name,
        region,
        size_gb: sizeGb,
        provider: provider.kind,
        volume_id: volume.id,
        volume_name: volume.name || volumeName,
      })
      .returning("id", "name", "region", "size_gb", "volume_id", "volume_name"),
  )) as any[]
  await operationSucceeded(db, operation.id)
  await startWorkspaceMetering(db, rows[0].id, provider.kind === "digitalocean" ? undefined : 0)
  await audit(db, userId, "workspace.granted", `${name} ${sizeGb}GB with ${boxName}`)
  return rows[0]
}

export const boxRoutes = (db: Connection, appUrl: string) => {
  const authed = pipeline(requireAuth({ db }))

  // `requireAuth` first, or `signedInUser` has no user to read and every
  // customer shares whatever address bucket they land in.
  //
  // Five boxes per user per hour. The per-user limit on live boxes says
  // nothing about churn, and create-destroy-create is where the money leaks: a
  // droplet is billed from the moment it exists. The address number is far
  // above it on purpose — a carrier puts tens of thousands of subscribers
  // behind one address, and mobile browsers are first-class clients here.
  const createBox = pipeline(
    requireAuth({ db }),
    parseJson,
    rateLimit({ db, key: "boxes.create", limit: 200, windowSeconds: 3600, subject: signedInUser, subjectLimit: 5 }),
  )
  // A box posts its setup output every few seconds while cloud-init runs, and
  // each box has its own address. 120 a minute is far more than a real setup
  // produces; the per-request line cap bounds one write, this bounds how many
  // a wedged or hostile box can make.
  const callback = pipeline(parseJson, rateLimit({ db, key: "boxes.callback", limit: 120, windowSeconds: 60 }))
  const callbackJson = callback
  // A GET carries no body, so it cannot go through `parseJson`.
  const callbackGet = pipeline(rateLimit({ db, key: "boxes.callback", limit: 120, windowSeconds: 60 }))

  return [
    // What the wizard renders. Served rather than hardcoded in the client so
    // provisioning and the web UI cannot drift on what a box can carry.
    get(
      "/boxes/catalog",
      authed(async c => {
        const provider = activeProvider()
        const providerCatalog = provider.catalog ? await provider.catalog(db) : null
        if (providerCatalog) {
          const tools = providerCatalog.toolIds
            ? CATALOG.filter(tool => providerCatalog.toolIds?.includes(tool.id))
            : CATALOG
          return json(c, 200, {
            tools: tools.map(({ install, credentials, ...rest }) => rest),
            sizes: providerCatalog.sizes,
            gpu_sizes: [],
            regions: providerCatalog.regions,
            defaults: providerCatalog.defaultTools ?? defaults(),
            provider: provider.kind,
          })
        }
        // Read from the provider, so the cards on offer and what they cost are
        // whatever is true today rather than whatever was true when this was
        // written. Empty when GPU is switched off, when the provider cannot be
        // reached, or when the account has none available — three states the
        // wizard treats the same way, because in all three the honest answer
        // to "can I have a GPU box" is no.
        const gpu = await gpuSizes(db)
        // GPU cards live in datacentres the CPU catalogue never mentions, so
        // the static region list cannot name them.
        const named = gpu.length > 0 ? await regionNames(db) : {}
        const extra = [...new Set(gpu.flatMap(g => g.regions))]
          .filter(slug => !REGIONS.some(r => r.slug === slug))
          .map(slug => ({ slug, label: named[slug] ?? slug }))

        return json(c, 200, {
          // `install` and `credentials` are stripped: one is a shell command
          // the client has no business running, the other is a list of file
          // paths that only the box and the sync path need to know.
          tools: CATALOG.map(({ install, credentials, ...rest }) => rest),
          sizes: SIZES,
          gpu_sizes: gpu.map(g => ({
            slug: g.slug,
            label: g.label,
            memory_mb: g.memoryMb,
            vcpus: g.vcpus,
            disk_gb: g.diskGb,
            vram_gb: g.vramGb,
            count: g.count,
            vendor: g.vendor,
            cents_per_hour: g.centsPerHour,
            regions: g.regions,
          })),
          regions: [...REGIONS, ...extra],
          defaults: defaults(),
          provider: provider.kind,
        })
      }),
    ),

    get(
      "/boxes",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("boxes")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull())
            .orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows.map(publicBox))
      }),
    ),

    get(
      "/boxes/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })
        return json(c, 200, publicBox(row))
      }),
    ),

    post(
      "/boxes",
      createBox(async c => {
        const me = currentUser(c)
        const b = c.body as {
          name?: string
          region?: string
          size?: string
          tools?: string[]
          shell?: string
          synapse?: boolean
          workspace_id?: number
        }

        let provider: MachineProvider
        try {
          provider = await requireProvider(db)
        } catch (err) {
          if (!(err instanceof ProviderUnavailable)) throw err
          return json(c, 503, {
            error: `${err.message} The instance owner needs to configure it.`,
          })
        }

        const limit = Number(await getSetting(db, SETTING.boxLimitPerUser))
        const mine = (await db.one(
          from("boxes")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        if (Number(mine?.n ?? 0) >= limit) {
          return json(c, 409, { error: `You already have ${limit} boxes.` })
        }

        const name = (b.name ?? "").trim().slice(0, 40) || "box"

        // A GPU size is not in the static catalogue — it is read from the
        // provider, because the cards on offer and their hourly price both
        // move. A slug that looks like one and is not in that list is refused
        // rather than falling through to the default size: somebody asking for
        // an H100 must not silently get a 512 MB box.
        const providerCatalog = provider.catalog ? await provider.catalog(db) : null
        const wantsGpu = provider.capabilities.gpu && isGpuSize(String(b.size ?? ""))
        const gpu = wantsGpu ? await gpuSizeFor(db, String(b.size)) : null
        if (wantsGpu && !gpu) {
          return json(c, 422, { error: "That GPU size is not available. Pick one from the catalogue." })
        }

        // GPU cards live in a handful of datacentres, and not the ones the CPU
        // catalogue lists. The choice is honoured when the card is there and
        // moved when it is not — a create that fails at the provider because a
        // region was left at its default is a worse way to learn this.
        const region = providerCatalog
          ? (providerCatalog.regions.find(r => r.slug === b.region)?.slug ?? providerCatalog.defaults.region)
          : gpu
            ? (gpu.regions.find(r => r === b.region) ?? gpu.regions[0])
            : (REGIONS.find(r => r.slug === b.region)?.slug ?? (await getSetting(db, SETTING.defaultRegion)))
        const size = providerCatalog
          ? (providerCatalog.sizes.find(s => s.slug === b.size)?.slug ?? providerCatalog.defaults.size)
          : (gpu?.slug ?? SIZES.find(s => s.slug === b.size)?.slug ?? (await getSetting(db, SETTING.defaultSize)))
        const shell = isShell(String(b.shell ?? "")) ? String(b.shell) : "bash"
        // The shell is a tool as far as the build is concerned. Choosing zsh
        // and not installing it leaves an account whose login shell does not
        // exist, so the selection carries its own package rather than trusting
        // the client to have ticked the right box.
        const wanted = [...(b.tools ?? providerCatalog?.defaultTools ?? defaults())]
        const unsupported = providerCatalog?.toolIds
          ? wanted.filter(tool => !providerCatalog.toolIds?.includes(tool))
          : []
        if (unsupported.length > 0) {
          return json(c, 422, {
            error: `${provider.label} does not provide: ${unsupported.join(", ")}. Pick from its catalogue.`,
          })
        }
        const shellTool = SHELLS[shell as ShellName].tool
        if (shellTool && !wanted.includes(shellTool)) wanted.push(shellTool)
        const tools = resolve(wanted).map(t => t.id)

        // Before the memory check, so somebody without a subscription is told
        // that rather than being told about memory first. 402 rather than 403:
        // it is payment that is missing, and the client needs to tell those
        // apart to know whether to offer a checkout link.
        // Before the subscription check and before the droplet: a workspace
        // that is on another box, or in another region, is a refusal the person
        // can act on, and finding out after a machine exists is worse.
        let workspace: any = null
        if (b.workspace_id) {
          const claim = await claimForBox(db, me.id, Number(b.workspace_id), region, undefined, provider.kind)
          if (!claim.ok) return json(c, 409, { error: claim.reason })
          workspace = claim.workspace
        }

        // The instance's own ceiling, checked before anybody's entitlement to
        // a box. Somebody may have paid for this and it still cannot be built:
        // the cap is about what the machine costs the person whose provider
        // account it lands on, and past it nothing new starts at all.
        const room = await withinCap(db, provider.kind === "digitalocean" ? await costCentsPerHour(db, size) : 0)
        if (!room.ok) return json(c, 409, { error: room.reason })

        // A GPU box is an admin's decision, not a member's.
        //
        // Nothing is charged to anybody here — the bill lands on whoever
        // installed this — and the cheapest card is a hundred times the hourly
        // cost of the cheapest ordinary box. The instance cap bounds the
        // damage and the idle sweep shortens it, but neither is a reason to
        // let anybody with an account spend four dollars an hour of somebody
        // else's money without being trusted with anything else.
        if (gpu && !atLeast(me.role, "admin")) {
          return json(c, 403, { error: "GPU boxes are for admins on this instance. Ask whoever runs it." })
        }

        // A box with nowhere to keep its work.
        //
        // Given a small workspace rather than none, because every sweep here
        // only ever touches boxes carrying one — a box without a workspace
        // holds the only copy of what is on it, so it can never be put to
        // sleep, which is exactly backwards for the machines nobody is
        // watching. A gigabyte is the smallest a volume can be and costs about
        // ten cents a month.
        if (!workspace) {
          // A GPU box is never allowed to go without one. The idle sweep only
          // ever touches boxes carrying a workspace — that rule is what makes
          // sleeping a machine safe rather than destructive — so a GPU box
          // without one is a four-dollar-an-hour machine that can never be put
          // down automatically. Ten gigabytes rather than the free tier's one:
          // a checkpoint is not a dotfile.
          const freeGb = Number(await getSetting(db, SETTING.freeWorkspaceGb))
          const gb = gpu ? Math.max(10, Number.isFinite(freeGb) ? freeGb : 0) : freeGb
          if (Number.isFinite(gb) && gb > 0) {
            workspace = await grantWorkspace(db, provider, me.id, region, gb, name).catch(err => {
              // Not fatal. A box with no workspace is worse than one with, and
              // far better than no box at all because a volume could not be
              // made — it simply never sleeps.
              console.error("[devpipe] could not grant a free workspace:", err)
              return null
            })
          }
          if (gpu && !workspace) {
            return json(c, 502, {
              error: "A GPU box needs a workspace and one could not be created. Try again in a moment.",
            })
          }
        }

        // Refuse a build that would be killed by the OOM killer later. The
        // failure it prevents looks like a random disconnect mid-task, which
        // is far harder to diagnose than being told no now.
        // Only a question for the CPU sizes. The smallest GPU box has 32 GB of
        // memory, which is more than the whole catalogue asks for put together.
        const providerSize = providerCatalog?.sizes.find(item => item.slug === size)
        const providerNeeded = memoryFor(tools) + 140
        const memory = gpu
          ? { ok: true, needed: 0, available: gpu.memoryMb }
          : providerSize
            ? { ok: providerNeeded <= providerSize.memoryMb, needed: providerNeeded, available: providerSize.memoryMb }
            : fits(tools, size)
        if (!memory.ok) {
          return json(c, 422, {
            error: `That selection needs about ${memory.needed} MB and this size has ${memory.available} MB. Pick a larger box or fewer tools.`,
          })
        }

        const domain = await getSetting(db, SETTING.domain)
        const host = `${me.username}-${shortId(5)}`
        const hostname = `${host}.${domain}`
        const agentToken = randomToken()

        const rows = (await db.execute(
          from("boxes")
            .insert({
              user_id: me.id,
              name,
              hostname,
              provider: provider.kind,
              shell,
              synapse: b.synapse ? 1 : 0,
              workspace_id: workspace?.id ?? null,
              region,
              size,
              status: "creating",
              agent_token: agentToken,
              manifest: JSON.stringify({ tools, size, region }),
            })
            .returning("id"),
        )) as any[]
        const boxId = rows[0].id

        try {
          await provision(db, {
            provider,
            operationKind: "provision",
            idempotencyKey: `provision:${boxId}`,
            appUrl,
            boxId,
            userId: me.id,
            hostname,
            host,
            domain,
            region,
            size,
            tools,
            shell,
            synapse: Boolean(b.synapse),
            agentToken,
            // Minted against the row rather than generated above, so the hash
            // is stored against a box that definitely exists — a token whose
            // box was rolled back would authenticate as nothing anyway, but
            // this keeps the two from ever disagreeing.
            vaultToken: await rotateVaultToken(db, boxId),
            workspace,
          })
          await audit(db, me.id, "box.created", hostname)
          return json(c, 201, { id: boxId, hostname, status: "installing" })
        } catch (err: any) {
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(boxId))
              .update({ status: "failed", status_detail: String(err?.message ?? err).slice(0, 200) }),
          )
          // The clock only started if a droplet actually existed, so what this
          // counts is the minutes that machine was alive — and then it stops,
          // rather than running forever against a box nobody can use.
          await stopMetering(db, boxId)
          return json(c, 502, { error: String(err?.message ?? "Could not create that box.") })
        }
      }),
    ),

    /**
     * Building the machine back for a box that was reclaimed while idle.
     *
     * Not "create a new box like the old one" — the row, the name, the tools
     * and the workspace are all still here. Only the droplet was given back,
     * which is the only part that was being charged for by the hour.
     */
    /**
     * Putting a box down on purpose.
     *
     * The sweep has always been able to do this; a person could not, which
     * meant the only way to stop paying for a machine before its idle window
     * ran out was to destroy it — and destroying is the one action here that
     * is not reversible. Waking takes about three minutes and brings back the
     * name, the tools and the files.
     *
     * Refused without a workspace, and that refusal is the whole safety of it.
     * Sleeping releases the droplet, and a box whose files are only on the
     * droplet loses them. The sweep applies the same rule for the same reason;
     * this is not a place to be more permissive because somebody asked.
     */
    post(
      "/boxes/:id/sleep",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull()),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })
        if (row.status === ASLEEP) return json(c, 409, { error: "That box is already asleep." })
        if (row.status !== "ready") {
          // A box mid-build has cloud-init running on it and a callback still
          // to come. Taking the machine away underneath that leaves a row
          // waiting for news from a droplet that no longer exists.
          return json(c, 409, { error: "Wait for that box to finish setting up." })
        }
        if (!row.workspace_id) {
          return json(c, 409, {
            error: "That box has no workspace, so its files only exist on the machine. Sleeping would lose them.",
          })
        }
        if (!row.provider_id) {
          return json(c, 409, { error: "That box has no machine to release." })
        }

        const slept = await sleepBox(
          db,
          {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            hostname: row.hostname,
            provider: row.provider,
            providerId: String(row.provider_id),
            workspaceId: Number(row.workspace_id),
            idleHours: 0,
          },
          "asleep because you asked",
        )
        if (!slept) {
          // `sleepBox` refuses rather than forces when the volume will not
          // detach, and leaving the box awake is the correct outcome — it is
          // the alternative that loses a workspace.
          return json(c, 502, { error: "That box could not be put to sleep. It is still running." })
        }
        return json(c, 200, { id: row.id, status: ASLEEP })
      }),
    ),

    post(
      "/boxes/:id/wake",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull()),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })
        if (row.status !== ASLEEP) {
          return json(c, 409, { error: "That box is already awake." })
        }

        let provider: MachineProvider
        try {
          provider = await requireProvider(db, row.provider)
        } catch (err) {
          if (!(err instanceof ProviderUnavailable)) throw err
          return json(c, 503, { error: err.message })
        }

        // Waking is starting a machine, so the instance's ceiling applies
        // exactly as it does to creating one.
        const rate =
          row.cost_cents === null || row.cost_cents === undefined
            ? provider.kind === "digitalocean"
              ? await costCentsPerHour(db, row.size)
              : 0
            : Number(row.cost_cents) || 0
        const room = await withinCap(db, rate)
        if (!room.ok) return json(c, 409, { error: room.reason })

        // Waking a GPU box is starting one, so it asks what creating one did.
        if (isGpuSize(row.size) && !atLeast(me.role, "admin")) {
          return json(c, 403, { error: "GPU boxes are for admins on this instance. Ask whoever runs it." })
        }

        // The workspace has to still be free. It is normally still attached to
        // nothing, but somebody can have given it to another box while this one
        // slept, and waking into a workspace already mounted elsewhere is the
        // one thing block storage will not do.
        //
        // Excluding this box is the whole point: a sleeping box keeps its
        // `workspace_id`, so without it the check finds itself holding the lock
        // and refuses — "That workspace is on sleeper", where `sleeper` is the
        // box asking. Every slept box was unwakeable.
        let workspace: any = null
        if (row.workspace_id) {
          const claim = await claimForBox(db, me.id, row.workspace_id, row.region, row.id, provider.kind)
          if (!claim.ok) return json(c, 409, { error: claim.reason })
          workspace = claim.workspace
        }

        const domain = await getSetting(db, SETTING.domain)
        await db.execute(
          from("boxes")
            .where(q => q("id").equals(row.id))
            .update({ status: "creating", status_detail: "" }),
        )
        try {
          await provision(db, {
            provider,
            operationKind: "wake",
            idempotencyKey: `wake:${row.id}:${Date.now()}`,
            appUrl,
            boxId: row.id,
            userId: me.id,
            hostname: row.hostname,
            host: row.hostname.replace(`.${domain}`, ""),
            domain,
            region: row.region,
            size: row.size,
            tools: safeTools(row.manifest),
            shell: row.shell ?? "bash",
            synapse: Boolean(row.synapse),
            // The same token the daemon was built with, so a client holding the
            // old connection details is not silently locked out of its own box.
            agentToken: row.agent_token,
            // A *fresh* vault credential, unlike the agent token above. Only
            // its hash was ever stored, so the old one cannot be handed back —
            // and that is the better behaviour anyway: waking rotates it, so a
            // token lifted from a sleeping box's disk image is already dead.
            vaultToken: await rotateVaultToken(db, row.id),
            workspace,
          })
          await audit(db, me.id, "box.woken", row.hostname)
          return json(c, 200, { id: row.id, hostname: row.hostname, status: "installing" })
        } catch (err: any) {
          // Back to asleep rather than failed. Nothing was lost, the workspace
          // is still there, and trying again is the obvious next move.
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(row.id))
              .update({ status: ASLEEP, status_detail: String(err?.message ?? "could not wake").slice(0, 200) }),
          )
          // And a wake that did not take is not an hour anybody owes for
          // beyond the minutes a droplet was actually up.
          await stopMetering(db, row.id)
          return json(c, 502, { error: String(err?.message ?? "Could not wake that box.") })
        }
      }),
    ),

    del(
      "/boxes/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })

        let releaseOperation: MachineOperation | null = null
        if (row.provider_id) {
          let provider: MachineProvider
          try {
            provider = await requireProvider(db, row.provider)
          } catch (err) {
            if (!(err instanceof ProviderUnavailable)) throw err
            return json(c, 503, {
              error: `${err.message} The provider resource has not been changed, so this box is still in your list.`,
            })
          }

          const workspace = row.workspace_id
            ? ((await db.one(from("workspaces").where(q => q("id").equals(row.workspace_id)))) as any)
            : null
          releaseOperation = await beginOperation(db, {
            idempotencyKey: `destroy:${row.id}:${row.provider_id}`,
            provider: provider.kind,
            kind: "destroy",
            boxId: row.id,
            workspaceId: workspace?.id ?? null,
          })
          try {
            await operationStep(db, releaseOperation, "releasing-machine", String(row.provider_id))
            // The provider owns the order. DigitalOcean detaches first; Docker
            // removes the container while preserving its named volume.
            await provider.compute.release(db, {
              machineId: String(row.provider_id),
              workspaceId: workspace?.volume_id ?? null,
              preserveWorkspace: Boolean(workspace),
            })

            if (provider.network) {
              const domain = await getSetting(db, SETTING.domain)
              await provider.network.remove(db, domain, row.hostname.replace(`.${domain}`, "")).catch(err => {
                console.error("dns cleanup failed", err)
              })
            }
          } catch (err) {
            await operationFailed(db, releaseOperation.id, err)
            console.error(`[devpipe] could not destroy ${row.hostname}:`, err)
            return json(c, 502, {
              error: `That box could not be destroyed: ${String((err as any)?.message ?? err)}. It is still running, so it has been left in your list to try again.`,
            })
          }
        }

        // The last partial hour, charged before the row stops being one this
        // can be worked out from. After the droplet is actually gone, so a
        // destroy that failed above has not billed for time the machine went
        // on running.
        await stopMetering(db, row.id)

        await db.execute(
          from("boxes")
            .where(q => q("id").equals(row.id))
            .update({ status: "destroyed", provider_id: null, endpoint: null, destroyed_at: new Date() }),
        )
        // Neither the sessions nor the ports are coming back, so neither are
        await retireSharing(db, row.id)
        if (releaseOperation) await operationSucceeded(db, releaseOperation.id)
        await audit(db, me.id, "box.destroyed", row.hostname)
        return json(c, 200, { ok: true })
      }),
    ),

    // Setup output, newest last. `after` lets the client poll for only what it
    // has not seen, so a long build does not re-send its whole history every
    // few seconds.
    get(
      "/boxes/:id/events",
      authed(async c => {
        const me = currentUser(c)
        const box = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!box) return json(c, 404, { error: "No such box." })

        const after = Number(c.query.after ?? 0)
        const rows = (await db.all(
          from("box_events")
            .where(q => q("box_id").equals(box.id))
            .where(q => q("id").greaterThan(Number.isFinite(after) ? after : 0))
            .select("id", "phase", "line", "at")
            .orderBy("id", "ASC")
            .limit(500),
        )) as any[]
        return json(c, 200, { status: box.status, detail: box.status_detail, events: rows })
      }),
    ),

    // ---- agent logins ------------------------------------------------------
    //
    // A box is cattle; the login is not. Signing in to an agent CLI again on
    // every new box is the single most tedious thing about destroying one, and
    // it is what stops "destroy and recreate" from being the cheap act the
    // wizard's stored manifest is meant to make it.
    //
    // Authenticated by the box's own token, like the setup callbacks: the box
    // proves which box it is, and the control plane decides whose logins those
    // are. Deliberately *not* passed through cloud-init — user data is stored
    // by the provider and served to anything on the box that can reach the
    // metadata service, which is a poor place for a credential that reaches
    // somebody's Anthropic account.

    get(
      "/boxes/callback/logins",
      callbackGet(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const hostname = String(c.query.hostname ?? "")
        if (!presented || !hostname) return json(c, 400, { error: "bad callback" })
        const box = (await db.one(from("boxes").where(q => q("hostname").equals(hostname)))) as any
        if (!box || box.agent_token !== presented) return json(c, 403, { error: "no" })
        if (!secretsAvailable()) return json(c, 200, { files: [] })
        const rows = (await db.all(from("agent_logins").where(q => q("user_id").equals(box.user_id)))) as any[]
        const files: { path: string; content: string }[] = []
        for (const row of rows) {
          const content = await open(row.sealed)
          // A row sealed under a rotated key is not an error to report — it is
          // a login that has to be done once more.
          if (content !== null) files.push({ path: row.path, content })
        }
        return json(c, 200, { files })
      }),
    ),

    post(
      "/boxes/callback/logins",
      callbackJson(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const b = c.body as { hostname?: string; tool?: string; path?: string; content?: string }
        if (!presented || !b.hostname) return json(c, 400, { error: "bad callback" })
        const box = (await db.one(from("boxes").where(q => q("hostname").equals(b.hostname!)))) as any
        if (!box || box.agent_token !== presented) return json(c, 403, { error: "no" })
        if (!secretsAvailable()) {
          return json(c, 503, { error: "This instance cannot store logins: DEVPIPE_SECRET_KEY is not set." })
        }

        const tool = String(b.tool ?? "").slice(0, 40)
        const path = String(b.path ?? "")
        const content = String(b.content ?? "")
        // Only paths the catalogue names. Without this a box could ask the
        // control plane to keep any file it liked, which is a storage service
        // with no quota rather than a login.
        const known =
          CATALOG.some(t => t.id === tool && (t.credentials ?? []).includes(path)) ||
          // The account's Synapse configuration rides the same encrypted path.
          (tool === "synapse" && (SYNAPSE_FILES as readonly string[]).includes(path))
        if (!known) return json(c, 422, { error: "not a login file" })
        if (content.length > 256_000) return json(c, 413, { error: "too large" })

        const sealed = await seal(content)
        const existing = (await db.one(
          from("agent_logins")
            .where(q => q("user_id").equals(box.user_id))
            .where(q => q("tool").equals(tool))
            .where(q => q("path").equals(path)),
        )) as any
        if (existing) {
          await db.execute(
            from("agent_logins")
              .where(q => q("id").equals(existing.id))
              .update({ sealed, updated_at: new Date() }),
          )
        } else {
          await db.execute(from("agent_logins").insert({ user_id: box.user_id, tool, path, sealed }))
        }
        return json(c, 200, { ok: true })
      }),
    ),

    // The box streams its setup output here while cloud-init runs.
    post(
      "/boxes/callback/log",
      callback(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const b = c.body as { hostname?: string; phase?: string; text?: string }
        if (!presented || !b.hostname) return json(c, 400, { error: "bad callback" })

        const box = (await db.one(from("boxes").where(q => q("hostname").equals(b.hostname!)))) as any
        if (!box || box.agent_token !== presented) return json(c, 403, { error: "no" })

        // Bounded per request and per line: this is the one endpoint a box can
        // post to freely, and an unbounded write is a way to fill the disk.
        const lines = String(b.text ?? "")
          .split("\n")
          .map(l => l.replace(/\s+$/, "").slice(0, 500))
          .filter(l => l.length > 0)
          .slice(0, 400)

        for (const line of lines) {
          await db.execute(
            from("box_events").insert({
              box_id: box.id,
              phase: String(b.phase ?? "").slice(0, 40),
              line,
            }),
          )
        }
        // Surfaces the current step in the box list without reading the log.
        if (b.phase) {
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(box.id))
              .update({ status_detail: String(b.phase).slice(0, 60) }),
          )
        }
        return json(c, 200, { ok: true, stored: lines.length })
      }),
    ),

    // The box reports in when cloud-init finishes. Authenticated with the
    // box's own agent token, which only that box and this server know.
    post(
      "/boxes/callback",
      callback(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const b = c.body as { hostname?: string; failed?: string }
        if (!presented || !b.hostname) return json(c, 400, { error: "bad callback" })

        const row = (await db.one(from("boxes").where(q => q("hostname").equals(b.hostname!)))) as any
        if (!row || row.agent_token !== presented) return json(c, 403, { error: "no" })

        const failed = (b.failed ?? "")
          .replace(/FAILED:\s*/g, "")
          .split(",")
          .filter(Boolean)
        await db.execute(
          from("boxes")
            .where(q => q("id").equals(row.id))
            .update({
              status: "ready",
              ready_at: new Date(),
              status_detail: failed.length ? `Some tools did not install: ${failed.join(", ")}` : "",
            }),
        )
        await audit(db, row.user_id, "box.ready", row.hostname)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}

/**
 * Polls until the droplet has a public address, then points DNS at it.
 *
 * Runs detached from the request that created the box: a droplet takes tens of
 * seconds to get an address and nobody should watch a spinner for it.
 */
const settleAddress = async (
  db: Connection,
  provider: MachineProvider,
  boxId: number,
  machineId: string,
  domain: string,
  host: string,
): Promise<boolean> => {
  let providerErrors = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5_000))

    // Bail if the box went away while we were waiting. Without this check a
    // box destroyed mid-provision has its DNS record written *after* the
    // destroy already removed it — leaving a name pointing at an address that
    // has gone back into the provider's pool, and will eventually belong to
    // somebody else's machine.
    const still = (await db.one(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .where(q => q("provider").equals(provider.kind))
        .where(q => q("provider_id").equals(machineId))
        .where(q => q("destroyed_at").isNull()),
    )) as any
    if (!still) return false

    let machine: Machine | null
    try {
      machine = await provider.compute.inspect(db, machineId)
    } catch (err) {
      providerErrors += 1
      console.error(`[devpipe] could not inspect ${provider.kind} machine ${machineId}:`, err)
      continue
    }
    if (!machine?.address) continue
    try {
      if (provider.network) await provider.network.publish(db, domain, host, machine.address)
      await db.execute(
        from("boxes")
          .where(q => q("id").equals(boxId))
          .where(q => q("provider_id").equals(machineId))
          .update({ ip: machine.address, endpoint: machine.endpoint }),
      )
    } catch (err) {
      console.error("dns for", host, err)
      continue
    }
    return true
  }
  if (providerErrors > 0) throw new Error(`Could not confirm the ${provider.label} machine's address.`)
  return false
}

const abandonProvisioning = async (
  db: Connection,
  provider: MachineProvider,
  operation: MachineOperation,
  boxId: number,
  machineId: string,
  workspace: any | null,
  error: unknown,
) => {
  try {
    await provider.compute.release(db, {
      machineId,
      workspaceId: workspace?.volume_id ?? null,
      preserveWorkspace: Boolean(workspace),
    })
  } catch (cleanupError) {
    await operationRetry(db, operation.id, "cleanup-needed", cleanupError)
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .where(q => q("provider_id").equals(machineId))
        .update({
          status_detail: `Cleanup needs retry: ${String((cleanupError as any)?.message ?? cleanupError)}`.slice(0, 200),
        }),
    )
    throw cleanupError
  }
  await stopMetering(db, boxId)
  const status = operation.kind === "wake" ? ASLEEP : "failed"
  const current = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
  if (!current?.provider_id || String(current.provider_id) === machineId) {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({
          status,
          provider_id: null,
          endpoint: null,
          ip: "",
          status_detail: String((error as any)?.message ?? error).slice(0, 200),
        }),
    )
  }
  await operationFailed(db, operation.id, error)
}

const finishProvisioning = async (
  db: Connection,
  provider: MachineProvider,
  operation: MachineOperation,
  boxId: number,
  machineId: string,
  workspace: any | null,
  domain: string,
  host: string,
): Promise<void> => {
  try {
    if (workspace) {
      if (!provider.workspaces) throw new Error(`${provider.label} cannot attach persistent workspaces.`)
      await operationStep(db, operation, "attaching-workspace", machineId)
      await provider.workspaces.ensureAttached(db, String(workspace.volume_id), machineId)
    }
  } catch (err) {
    await abandonProvisioning(db, provider, operation, boxId, machineId, workspace, err)
    return
  }

  await operationStep(db, operation, "waiting-for-address", machineId)
  let settled: boolean
  try {
    settled = await settleAddress(db, provider, boxId, machineId, domain, host)
  } catch (err) {
    // Provider outages are not evidence that the machine failed. Leave the
    // operation unfinished so the startup reconciler can resume it.
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .where(q => q("provider_id").equals(machineId))
        .update({ status_detail: String((err as any)?.message ?? err).slice(0, 200) }),
    )
    throw err
  }
  if (!settled) {
    await abandonProvisioning(
      db,
      provider,
      operation,
      boxId,
      machineId,
      workspace,
      new Error("The provider never gave this box an address."),
    )
    return
  }

  if (provider.capabilities.managedBootstrap) {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .where(q => q("provider_id").equals(machineId))
        .update({ status: "ready", status_detail: "", ready_at: new Date() }),
    )
  }
  await operationSucceeded(db, operation.id)
}

/** Resume provider mutations that survived an API restart. */
export const resumeProvisioning = async (db: Connection): Promise<void> => {
  const operations = (await unfinishedOperations(db)).filter(
    operation => operation.kind === "provision" || operation.kind === "wake",
  )
  for (const operation of operations) {
    try {
      const provider = await requireProvider(db, operation.provider)
      const box = operation.box_id
        ? ((await db.one(
            from("boxes")
              .where(q => q("id").equals(operation.box_id!))
              .where(q => q("destroyed_at").isNull()),
          )) as any)
        : null
      if (!box) {
        await operationFailed(db, operation.id, "The box row no longer exists.")
        continue
      }

      let machineId = operation.resource_id || box.provider_id
      if (!machineId) {
        const found = await provider.compute.findByOperation(db, operation.id)
        machineId = found?.id ?? null
      }
      if (!machineId) {
        await operationFailed(db, operation.id, "No provider resource was created.")
        await db.execute(
          from("boxes")
            .where(q => q("id").equals(box.id))
            .update({ status: operation.kind === "wake" ? ASLEEP : "failed", status_detail: "Provisioning stopped." }),
        )
        continue
      }

      const machine = await provider.compute.inspect(db, String(machineId))
      if (!machine) {
        await operationFailed(db, operation.id, "The provider resource no longer exists.")
        await db.execute(
          from("boxes")
            .where(q => q("id").equals(box.id))
            .update({
              status: operation.kind === "wake" ? ASLEEP : "failed",
              provider_id: null,
              endpoint: null,
              status_detail: "The provider resource no longer exists.",
            }),
        )
        continue
      }
      await db.execute(
        from("boxes")
          .where(q => q("id").equals(box.id))
          .update({ provider: provider.kind, provider_id: machine.id, endpoint: machine.endpoint }),
      )
      const workspace = box.workspace_id
        ? ((await db.one(from("workspaces").where(q => q("id").equals(box.workspace_id)))) as any)
        : null
      if (operation.step === "cleanup-needed") {
        await abandonProvisioning(
          db,
          provider,
          operation,
          box.id,
          machine.id,
          workspace,
          new Error(operation.last_error || "Provisioning cleanup was interrupted."),
        )
        continue
      }
      await finishProvisioning(
        db,
        provider,
        operation,
        box.id,
        machine.id,
        workspace,
        String(operation.payload.domain ?? ""),
        String(operation.payload.host ?? ""),
      )
    } catch (err) {
      // Provider or database unavailable: keep the operation live for the next
      // restart. Marking it failed would turn uncertainty into forgotten spend.
      console.error(`[devpipe] could not resume machine operation ${operation.id}:`, err)
    }
  }
}
