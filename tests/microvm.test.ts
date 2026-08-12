import { describe, expect, test } from "bun:test"
import {
  beatsDroplets,
  concurrentCapacity,
  costPerSeat,
  FREE_SHAPE,
  type Host,
  seatsFor,
  storedCapacity,
} from "../src/boxes/microvm.ts"

/**
 * The arithmetic that decides whether packing free boxes is worth building.
 *
 * These are the numbers the case rests on, so they are worth pinning: if
 * snapshotting is dropped, or the free tier grows, the answer changes and this
 * should be what says so.
 */

// DigitalOcean s-4vcpu-8gb, $48/mo — the host the case was made on.
const HOST: Host = { memoryMb: 8192, diskGb: 160 }

describe("what a host holds", () => {
  test("running at once is bounded by memory", () => {
    // 8192 less 1024 reserved, over 512 + 42 of supervisor.
    expect(concurrentCapacity(HOST)).toBe(12)
  })

  test("stored on disk is bounded by the snapshot size", () => {
    // A snapshot is guest RAM, compressed. 512/8 = 64MB each into 160GB.
    expect(storedCapacity(HOST)).toBe(2560)
  })

  test("a host too small for one box holds none, rather than a negative number", () => {
    expect(concurrentCapacity({ memoryMb: 512, diskGb: 10 })).toBe(0)
    expect(seatsFor({ memoryMb: 512, diskGb: 10 }, 0.05)).toBe(0)
  })
})

describe("what it costs per person", () => {
  // The claim the whole idea rests on: a free seat should cost cents, not
  // dollars, or it is not a free tier — it is a discount.
  test("at 5% concurrency a seat is well under a dollar", () => {
    const seats = seatsFor(HOST, 0.05)
    expect(seats).toBe(240)
    expect(costPerSeat(HOST, 48, 0.05)).toBeCloseTo(0.2, 1)
  })

  test("busier tiers cost more per seat, and it is still cheap", () => {
    expect(costPerSeat(HOST, 48, 0.1)).toBeLessThan(1)
    expect(costPerSeat(HOST, 48, 0.05)).toBeLessThan(costPerSeat(HOST, 48, 0.1))
  })

  // The finding that decides the design. Without snapshotting, every VM is
  // resident, "concurrency" is 100%, and packing saves almost nothing over a
  // droplet each — which is not worth an entire virtualisation subsystem.
  test("packing without snapshots does not beat a droplet each", () => {
    expect(costPerSeat(HOST, 48, 1)).toBeCloseTo(4, 0)
    expect(beatsDroplets(HOST, 48, 1)).toBe(false)
    expect(beatsDroplets(HOST, 48, 0.05)).toBe(true)
  })

  test("disk becomes the limit before memory does when almost nobody is active", () => {
    // At 1% concurrency memory would allow 1200 seats, but only 2560 snapshots
    // fit — and on a smaller disk that bites first.
    const small: Host = { memoryMb: 8192, diskGb: 20 }
    expect(seatsFor(small, 0.01)).toBe(storedCapacity(small))
    expect(seatsFor(small, 0.01)).toBeLessThan(1200)
  })

  test("a bigger free box is a more expensive free box", () => {
    const generous = { ...FREE_SHAPE, memoryMb: 1024 }
    expect(costPerSeat(HOST, 48, 0.05, generous)).toBeGreaterThan(costPerSeat(HOST, 48, 0.05))
  })
})
