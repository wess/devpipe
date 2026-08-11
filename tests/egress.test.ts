import { describe, expect, test } from "bun:test"
import { gigabytesOver, outboundMbps } from "../src/boxes/digitalocean.ts"
import { WINDOW_SECONDS } from "../src/security/egress.ts"

/**
 * The only measurement here that bounds abuse rather than inconveniencing it.
 * Everything else — the apt pin, the closed mail ports — raises the cost of an
 * obvious thing and stops nobody who tries twice.
 */

const realFetch = globalThis.fetch

const stub = (payload: unknown, status = 200) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as any
}

const series = (values: string[]) => ({
  data: { result: [{ values: values.map((v, i) => [1_700_000_000 + i * 120, v]) }] },
})

describe("reading what a box is sending", () => {
  test("averages the window rather than taking a peak", async () => {
    // One sample catches a `git push` of a large repository and calls it abuse.
    stub(series(["0", "0", "120", "0", "0"]))
    const mbps = await outboundMbps("token", "1")
    expect(mbps).toBeCloseTo(24, 5)
    globalThis.fetch = realFetch
  })

  test("no reading is not a quiet box", async () => {
    // A droplet created minutes ago has no samples. Treating that as zero would
    // make every new box look well behaved, which is the wrong default for the
    // one measurement that is supposed to catch something.
    stub({ data: { result: [] } })
    expect(await outboundMbps("token", "1")).toBeNull()
    globalThis.fetch = realFetch
  })
})

describe("turning a rate into a bill of bytes", () => {
  test("a gigabit held for an hour is about 450GB", () => {
    expect(Math.round(gigabytesOver(1000, 3600))).toBe(450)
  })

  test("the default limit is well above ordinary work", () => {
    // A container image, a dataset, a repository with history: tens of GB at
    // the top end. The line has to sit above that or it fires on a Tuesday.
    const ordinary = gigabytesOver(50, WINDOW_SECONDS)
    expect(ordinary).toBeLessThan(200)
  })

  test("and well below what a seedbox does on purpose", () => {
    const seeding = gigabytesOver(500, WINDOW_SECONDS)
    expect(seeding).toBeGreaterThan(200)
  })
})
