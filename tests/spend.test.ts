import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { capState, periodStart, spentThisPeriod, volumeCentsPerHour, withinCap } from "../src/spend/index.ts"
import { meterAll, startWorkspaceMetering } from "../src/spend/meter.ts"
import { SETTING, setSetting } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The spending cap.
 *
 * This is the half of billing that matters on an instance with no billing.
 * Somebody self-hosting has no customers — what they have is a provider
 * account with their own card behind it, and the thing that actually goes
 * wrong is a box left running over a holiday.
 */

let userId = 0

const box = async (opts: { cost?: number; agoMs?: number; status?: string; workspace?: number | null } = {}) => {
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: "b",
        hostname: `b-${Math.random().toString(36).slice(2, 8)}.devpipe.com`,
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: opts.status ?? "ready",
        provider_id: "5001",
        agent_token: "t",
        cost_cents: opts.cost ?? 1,
        workspace_id: opts.workspace ?? null,
        metered_at: opts.agoMs === undefined ? null : new Date(Date.now() - opts.agoMs),
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

const workspace = async (sizeGb: number) => {
  const rows = (await db.execute(
    from("workspaces")
      .insert({
        user_id: userId,
        name: `w${sizeGb}`,
        region: "nyc3",
        size_gb: sizeGb,
        volume_id: `vol-${Math.random().toString(36).slice(2, 8)}`,
        volume_name: "dp-w",
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

beforeEach(async () => {
  await truncateAll()
  const users = (await db.execute(
    from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
  )) as any[]
  userId = users[0].id
})

describe("what it counts", () => {
  test("the period is the provider's month, not a rolling window", () => {
    const start = periodStart(new Date("2026-08-21T13:45:00Z"))
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z")
  })

  // A cap that only counted droplets would read low and be trusted anyway.
  // Volumes are charged for whether or not a box is attached to them.
  test("a volume costs money on its own", () => {
    // Ten cents per gigabyte per month, over the 730 hours the provider prices
    // a month as.
    expect(volumeCentsPerHour(100)).toBeCloseTo(1000 / 730, 6)
    expect(volumeCentsPerHour(0)).toBe(0)
  })

  test("the run rate is every live box plus every live volume", async () => {
    await box({ cost: 100, agoMs: 1000 })
    await box({ cost: 50, agoMs: 1000 })
    await workspace(730)
    // 150 cents of droplets, and 730 GB at ten cents a month is ten cents an
    // hour on the nose.
    expect((await capState(db)).runRateCentsPerHour).toBeCloseTo(160, 6)
  })

  test("a destroyed box stops adding to the rate but not to what was spent", async () => {
    const id = await box({ cost: 100, agoMs: 3_600_000 })
    await meterAll(db)
    expect(await spentThisPeriod(db)).toBe(100)

    await db.execute(
      from("boxes")
        .where(q => q("id").equals(id))
        .update({ destroyed_at: new Date(), metered_at: null }),
    )
    expect((await capState(db)).runRateCentsPerHour).toBe(0)
    // The whole point. "Spend less by deleting the evidence" is not a cap.
    expect(await spentThisPeriod(db)).toBe(100)
  })

  test("a volume is metered even with no box attached to it", async () => {
    const id = await workspace(730)
    await startWorkspaceMetering(db, id)
    await db.execute(
      from("workspaces")
        .where(q => q("id").equals(id))
        .update({ metered_at: new Date(Date.now() - 3_600_000) }),
    )
    await meterAll(db)
    expect(await spentThisPeriod(db)).toBe(10)
  })
})

describe("the gate", () => {
  test("lets everything through when there is no cap", async () => {
    await box({ cost: 100_000, agoMs: 3_600_000 })
    await meterAll(db)
    expect((await withinCap(db, 10_000)).ok).toBe(true)
  })

  test("refuses once the month's spend has reached it", async () => {
    await setSetting(db, SETTING.spendCapCents, "5000")
    await box({ cost: 6000, agoMs: 3_600_000 })
    await meterAll(db)

    const out = await withinCap(db)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("$50.00")
    expect(out.cap.over).toBe(true)
  })

  // The moment to say no is free; every moment afterwards costs money.
  test("refuses a box whose first hour would cross the line", async () => {
    await setSetting(db, SETTING.spendCapCents, "5000")
    await box({ cost: 4900, agoMs: 3_600_000 })
    await meterAll(db)

    expect((await withinCap(db, 50)).ok).toBe(true)
    expect((await withinCap(db, 200)).ok).toBe(false)
  })

  test("says so before it says no", async () => {
    await setSetting(db, SETTING.spendCapCents, "1000")
    await setSetting(db, SETTING.spendWarnPct, "80")
    await box({ cost: 850, agoMs: 3_600_000 })
    await meterAll(db)

    const cap = await capState(db)
    expect(cap.warning).toBe(true)
    expect(cap.over).toBe(false)
    expect((await withinCap(db)).ok).toBe(true)
  })

  test("and says when the rate will get there", async () => {
    await setSetting(db, SETTING.spendCapCents, "10000")
    await box({ cost: 100, agoMs: 1000 })
    const cap = await capState(db)
    // A dollar an hour against a hundred dollars left is a hundred hours.
    expect(cap.reachedAt).not.toBeNull()
    const hours = (new Date(cap.reachedAt as string).getTime() - Date.now()) / 3_600_000
    expect(hours).toBeCloseTo(100, 0)
  })

  test("never reached when nothing is running", async () => {
    await setSetting(db, SETTING.spendCapCents, "10000")
    expect((await capState(db)).reachedAt).toBeNull()
  })
})
