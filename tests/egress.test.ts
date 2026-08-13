import { describe, expect, test } from "bun:test"
import { bandwidthMbps, gigabytesOver, outboundMbps } from "../src/boxes/digitalocean.ts"
import { DAY_SECONDS, RELAY_FLOOR_GB, verdict, WINDOW_SECONDS } from "../src/security/egress.ts"

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

describe("reading both directions", () => {
  test("the direction asked for is the one requested", async () => {
    let asked = ""
    globalThis.fetch = (async (input: any) => {
      asked = String(input)
      return new Response(JSON.stringify(series(["10"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as any
    await bandwidthMbps("token", "1", "inbound", DAY_SECONDS)
    expect(asked).toContain("direction=inbound")
    globalThis.fetch = realFetch
  })
})

/**
 * The three shapes worth reporting, decided without a database or a provider.
 *
 * `limitGb` and `dailyGb` are the defaults. The figures are megabits per second
 * because that is what the provider reports: 445 for an hour is about 200GB,
 * 46 for a day is about 500GB.
 */
const limits = { limitGb: 200, dailyGb: 500 }

describe("deciding what a box is doing", () => {
  test("over the hour is a burst", () => {
    const found = verdict({ hourlyOut: 500, dailyOut: 500, dailyIn: 0, ...limits })
    expect(found?.reason).toBe("burst")
    expect(found?.window).toBe(WINDOW_SECONDS)
  })

  test("under the hour every hour is still a day's worth", () => {
    // The gap the hourly figure alone leaves. 60Mbps is a seventh of the hourly
    // line and never trips it; held for a day it is 648GB, which is not a shape
    // any developer's work has.
    const found = verdict({ hourlyOut: 60, dailyOut: 60, dailyIn: 5, ...limits })
    expect(gigabytesOver(60, WINDOW_SECONDS)).toBeLessThan(limits.limitGb)
    expect(found?.reason).toBe("sustained")
    expect(found?.window).toBe(DAY_SECONDS)
  })

  test("volume, and as much in as out, is a relay", () => {
    // Under both limits and still worth reporting: a proxy forwards what it
    // receives, so its two figures are nearly equal. This is the only test here
    // that catches a proxy run politely, which is how one would be run.
    const found = verdict({ hourlyOut: 20, dailyOut: 20, dailyIn: 18, ...limits })
    expect(gigabytesOver(20, DAY_SECONDS)).toBeLessThan(limits.dailyGb)
    expect(found?.reason).toBe("relay")
    expect(found?.received).toBeGreaterThan(0)
  })

  test("a box doing work is lopsided, and says nothing", () => {
    // Builds pull far more than they push. Reporting this is how a check like
    // this gets switched off after a fortnight.
    expect(verdict({ hourlyOut: 20, dailyOut: 20, dailyIn: 40, ...limits })).toBeNull()
  })

  test("a quiet box is symmetric too, and that is not a relay", () => {
    // Without a floor this fires on every idle machine: 50GB each way over a
    // day is perfectly balanced and perfectly boring. The ratio says what the
    // traffic is, the floor says whether there is enough of it to care.
    const under = verdict({ hourlyOut: 4, dailyOut: 4, dailyIn: 4, ...limits })
    expect(gigabytesOver(4, DAY_SECONDS)).toBeLessThan(RELAY_FLOOR_GB)
    expect(under).toBeNull()
  })

  test("no reading is not a quiet box", () => {
    // A droplet minutes old has no samples in either window.
    expect(verdict({ hourlyOut: null, dailyOut: null, dailyIn: null, ...limits })).toBeNull()
  })

  test("a missing hourly figure does not skip the day", () => {
    expect(verdict({ hourlyOut: null, dailyOut: 60, dailyIn: 5, ...limits })?.reason).toBe("sustained")
  })
})
