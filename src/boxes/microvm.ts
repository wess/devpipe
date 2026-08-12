/**
 * Packing free-tier boxes onto a host, as microVMs.
 *
 * A box is a droplet, which is right for somebody paying for it and absurd for
 * somebody who is not: the cheapest droplet is $4/mo and a free box that sits
 * idle costs exactly as much as one being used. Firecracker changes the shape
 * of that — a microVM that nobody is using can be written to disk and taken out
 * of memory entirely, and put back faster than the page it is behind loads.
 *
 * The numbers below are measured, not assumed. On a DigitalOcean s-2vcpu-4gb in
 * nyc3, with Firecracker v1.16.1 and a 512MB guest:
 *
 * | cold boot to kernel | 238–274 ms, ~240 median |
 * | snapshot a running VM | ~1.7 s |
 * | restore from snapshot | 20–26 ms |
 * | snapshot memory file | 513 MB raw, 5.3 MB gzipped |
 *
 * Two of those decide the design. Restore at ~22ms means idleness can be
 * aggressive — a VM can be put away after minutes rather than hours, because
 * coming back is faster than a page load. And a memory file that is exactly
 * guest RAM means storage, not memory, is what bounds how many idle boxes a
 * host holds; the compression ratio is what makes that affordable, and it is
 * only that good because an idle guest is mostly zero pages.
 *
 * Nothing here talks to Firecracker. This is the arithmetic the control plane
 * needs to decide whether a host can take another box, which is worth having
 * separate from the part that has to run on the host to be tested at all.
 */

/** What a host has to spend. */
export type Host = {
  /** Total memory, MB. */
  memoryMb: number
  /** Disk available for snapshots, GB. */
  diskGb: number
}

/** What one free-tier box is allowed. */
export type Shape = {
  memoryMb: number
  /** How small its snapshot gets on disk. 1 means stored raw. */
  compression: number
}

/**
 * Held back for the host itself.
 *
 * The host runs Firecracker per VM, a bridge, and whatever routes connections
 * to the right guest. Measured overhead was 42MB of resident memory per idle
 * Firecracker process on top of the guest's own allocation, and the host OS
 * wants its own room — a host that packs to the last megabyte starts killing
 * guests under load, which is a worse failure than refusing the last one.
 */
export const HOST_RESERVE_MB = 1024

/** Firecracker's own resident cost per running VM, measured. */
export const SUPERVISOR_MB = 42

/**
 * A snapshot compresses well because an idle guest is mostly zeroes. A guest
 * that has actually been worked in does not, so the default is deliberately
 * pessimistic against the 5.3MB that was measured on a freshly booted one.
 */
export const DEFAULT_COMPRESSION = 8

export const FREE_SHAPE: Shape = { memoryMb: 512, compression: DEFAULT_COMPRESSION }

/** How many boxes can be *running at once* on this host. */
export const concurrentCapacity = (host: Host, shape: Shape = FREE_SHAPE): number => {
  const usable = host.memoryMb - HOST_RESERVE_MB
  const each = shape.memoryMb + SUPERVISOR_MB
  if (usable <= 0 || each <= 0) return 0
  return Math.floor(usable / each)
}

/** How many idle boxes the host can *hold on disk*. */
export const storedCapacity = (host: Host, shape: Shape = FREE_SHAPE): number => {
  const perSnapshotMb = shape.memoryMb / Math.max(1, shape.compression)
  if (perSnapshotMb <= 0) return 0
  return Math.floor((host.diskGb * 1024) / perSnapshotMb)
}

/**
 * How many people a host supports, given how many are typing at once.
 *
 * The binding limit moves: at low concurrency it is disk, because most boxes
 * are stored rather than running, and at high concurrency it is memory. Taking
 * the smaller of the two is the whole point — a host sized on memory alone runs
 * out of disk quietly, and one sized on disk alone starts refusing to wake
 * people up.
 */
export const seatsFor = (host: Host, concurrencyPct: number, shape: Shape = FREE_SHAPE): number => {
  const pct = Math.min(Math.max(concurrencyPct, 0.01), 1)
  const byMemory = Math.floor(concurrentCapacity(host, shape) / pct)
  return Math.min(byMemory, storedCapacity(host, shape))
}

/** What one seat costs per month, given the host's price. */
export const costPerSeat = (host: Host, monthly: number, concurrencyPct: number, shape: Shape = FREE_SHAPE): number => {
  const seats = seatsFor(host, concurrencyPct, shape)
  return seats > 0 ? monthly / seats : Infinity
}

/**
 * Whether packing beats a droplet each.
 *
 * Worth asking in code rather than in a spreadsheet, because the answer depends
 * on the host price and the concurrency, and it is genuinely *no* for a host
 * that is too small or a tier too generous. Straight packing with no snapshots
 * — every VM resident all the time — lands within pennies of the cheapest
 * droplet, which is not worth an entire virtualisation subsystem.
 */
export const beatsDroplets = (
  host: Host,
  monthly: number,
  concurrencyPct: number,
  dropletMonthly = 4,
  shape: Shape = FREE_SHAPE,
): boolean => costPerSeat(host, monthly, concurrencyPct, shape) < dropletMonthly
