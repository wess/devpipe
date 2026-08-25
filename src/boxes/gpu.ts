import type { Connection } from "@atlas/db"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../settings/index.ts"
import * as ocean from "./digitalocean.ts"

/**
 * GPU boxes.
 *
 * Everything about them differs from a CPU box in the same three ways, and
 * they are the reason this is its own file rather than four more entries in
 * `SIZES`:
 *
 *  - **The list is not ours to write down.** DigitalOcean adds cards, retires
 *    them, and changes what a region will sell, several times a year. A
 *    hardcoded table is wrong the week after it is written, and wrong in the
 *    expensive direction: a stale hourly price is a price we charge somebody.
 *    So the catalogue is read from the provider and cached, and when it cannot
 *    be read there are simply no GPU sizes on offer.
 *
 *  - **They cost by the hour, and the hours are large.** $0.76 for the
 *    smallest and $4.41 for an H100 — a month of an H100 is $3,281 on the
 *    account of whoever installed this. The spending cap is what bounds that,
 *    and the forced idle sleep is what stops a finished job costing anything.
 *
 *  - **They boot a different image.** The Debian snapshot the CPU boxes are
 *    baked from has no NVIDIA driver and no CUDA. DigitalOcean's AI/ML-ready
 *    images do, and which one depends on whose silicon it is.
 */

/** Spot sizes are excluded — see `usable` below. */
export type GpuSize = {
  readonly slug: string
  readonly label: string
  readonly memoryMb: number
  readonly vcpus: number
  readonly diskGb: number
  readonly vramGb: number
  readonly count: number
  readonly vendor: "nvidia" | "amd"
  /** What DigitalOcean charges for it, in cents per hour. There is no other price. */
  readonly centsPerHour: number
  /** The only regions this size can be created in. Never empty. */
  readonly regions: readonly string[]
}

export const isGpuSize = (slug: string): boolean => slug.startsWith("gpu-")

/**
 * DigitalOcean's AI/ML-ready image for this card.
 *
 * The image is per-vendor and per-topology rather than per-card: one NVIDIA
 * image for a single card, another carrying the NVLink stack for an eight-card
 * machine, and one for AMD's ROCm. Guessing wrong gives a box with a GPU the
 * drivers cannot see, which looks like working hardware right up until the
 * first `torch.cuda.is_available()`.
 */
export const gpuImageFor = (size: GpuSize): string => {
  if (size.vendor === "amd") return "gpu-amd-base"
  return size.count >= 8 ? "gpu-h100x8-base" : "gpu-h100x1-base"
}

/**
 * "RTX 4000 Ada GPU Droplet - 1X" is the provider's name for it; "RTX 4000 Ada
 * ×1" is what fits in a tile. The card is the part a person is choosing, so
 * everything that is true of all of them — that it is a GPU, that it is a
 * droplet — comes out.
 */
const label = (description: string, count: number): string => {
  const stripped = description
    .replace(/\s*GPU Droplet\s*/i, " ")
    .replace(/\s*GPU\s*/i, " ")
    .replace(/\s*-\s*\d+X\s*/i, " ")
    .replace(/\s+/g, " ")
    .trim()
  return `${stripped || description} ×${count}`
}

/**
 * Whether a provider size belongs on the menu.
 *
 * Spot sizes are deliberately left off. DigitalOcean reclaims them with a few
 * minutes' notice, and nothing in this product watches for a droplet that
 * vanished — a spot box would keep saying "ready" while the machine behind it
 * no longer existed, which is a worse thing to sell than a more expensive box.
 * They come back the day something notices the machine is gone.
 *
 * An empty region list is not "available everywhere", it is "this account
 * cannot create this anywhere", which every other field on the size reports as
 * healthy.
 */
const usable = (s: ocean.Size): boolean =>
  isGpuSize(s.slug) && s.available && !s.slug.endsWith("-spot") && s.regions.length > 0 && Boolean(s.gpu)

const shape = (s: ocean.Size): GpuSize => ({
  slug: s.slug,
  label: label(s.description, s.gpu?.count ?? 1),
  memoryMb: s.memoryMb,
  vcpus: s.vcpus,
  diskGb: s.diskGb,
  vramGb: s.gpu?.vramGb ?? 0,
  count: s.gpu?.count ?? 1,
  vendor: (s.gpu?.model ?? "").startsWith("amd") ? "amd" : "nvidia",
  centsPerHour: Math.round(s.hourly * 100),
  regions: s.regions,
})

// The provider's answer, kept for an hour. Sizes change on the scale of
// quarters, and the wizard asks for this on every open.
const TTL_MS = 3_600_000
let cache: { at: number; sizes: ocean.Size[] } | null = null
let inFlight: Promise<ocean.Size[]> | null = null

/** Drops the cached catalogue. For tests, and after the provider token changes. */
export const forgetGpuSizes = () => {
  cache = null
  inFlight = null
}

/**
 * Every size the provider sells, cached.
 *
 * Read by the GPU catalogue and by the spend meter, and both want the same
 * thing: what DigitalOcean will charge. Cached once for both, so the two do
 * not double the calls.
 */
export const providerSizes = async (db: Connection): Promise<ocean.Size[]> => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sizes
  if (inFlight) return inFlight

  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return []

  inFlight = (async () => {
    try {
      const sizes = await ocean.listSizes(token)
      cache = { at: Date.now(), sizes }
      return sizes
    } catch (err) {
      // No fallback table on purpose. A stale price is one we would charge
      // somebody, and a stale region list is a create that fails after the
      // wizard has taken every other answer.
      console.error("[devpipe] could not read the provider's size list:", err)
      return cache?.sizes ?? []
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * What the provider charges for a size, in cents per hour.
 *
 * Zero for a size it has never heard of, which the meter reads as "do not
 * charge for this" — the honest answer when the price is unknown, and it fails
 * towards under-reporting rather than towards inventing a bill.
 */
export const costCentsPerHour = async (db: Connection, slug: string): Promise<number> => {
  const size = (await providerSizes(db)).find(s => s.slug === slug)
  return size ? Math.round(size.hourly * 100) : 0
}

/**
 * What a person may choose from, cheapest first.
 *
 * Empty means GPU boxes are off, the provider is unreachable, or the account
 * has none available — three states the caller treats identically, because in
 * all three the honest answer to "can I have a GPU box" is no.
 */
export const gpuSizes = async (db: Connection): Promise<GpuSize[]> => {
  if (!(await gpuEnabled(db))) return []
  return (await providerSizes(db))
    .filter(usable)
    .map(shape)
    .sort((a, b) => a.centsPerHour - b.centsPerHour)
}

export const gpuSizeFor = async (db: Connection, slug: string): Promise<GpuSize | null> =>
  (await gpuSizes(db)).find(s => s.slug === slug) ?? null

export const gpuEnabled = async (db: Connection): Promise<boolean> => (await getSetting(db, SETTING.gpuEnabled)) === "1"

/**
 * The regions a GPU size can be created in, named.
 *
 * GPU cards live in datacentres the CPU catalogue never mentions — Atlanta,
 * Kansas City, Memphis — so the static region list cannot label them. Read
 * from the provider and cached the same way.
 */
let regionCache: { at: number; names: Record<string, string> } | null = null

export const regionNames = async (db: Connection): Promise<Record<string, string>> => {
  if (regionCache && Date.now() - regionCache.at < TTL_MS) return regionCache.names
  const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
  if (!token) return {}
  try {
    const names: Record<string, string> = {}
    for (const r of await ocean.listRegions(token)) names[r.slug] = r.name
    regionCache = { at: Date.now(), names }
    return names
  } catch {
    return regionCache?.names ?? {}
  }
}

export const forgetRegionNames = () => {
  regionCache = null
}
