import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { spentThisPeriod } from "../src/spend/index.ts"
import {
  meterAll,
  meterBox,
  meterWorkspace,
  startMetering,
  startWorkspaceMetering,
  stopMetering,
  stopWorkspaceMetering,
} from "../src/spend/meter.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The clock.
 *
 * The arithmetic is the point. A meter that runs on a timer gets to be wrong in
 * two directions — counting the same hour twice, and inventing a surcharge out
 * of how often it happens to tick — and both are invisible until somebody adds
 * up an invoice and finds it does not match.
 */

let userId = 0

const boxFor = async (opts: { rate?: number; agoMs?: number } = {}) => {
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: "gpu",
        hostname: `b-${Math.random().toString(36).slice(2, 8)}.devpipe.com`,
        region: "tor1",
        size: "gpu-4000adax1-20gb",
        status: "ready",
        provider_id: "9001",
        agent_token: "tok",
        cost_cents: opts.rate ?? 100,
        metered_at: opts.agoMs === undefined ? null : new Date(Date.now() - opts.agoMs),
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

const workspaceFor = async (sizeGb: number, agoMs?: number) => {
  const rows = (await db.execute(
    from("workspaces")
      .insert({
        user_id: userId,
        name: `w${sizeGb}`,
        region: "tor1",
        size_gb: sizeGb,
        volume_id: `vol-${Math.random().toString(36).slice(2, 8)}`,
        volume_name: "dp-w",
        metered_at: agoMs === undefined ? null : new Date(Date.now() - agoMs),
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

describe("counting a box", () => {
  // The bug this exists to prevent is a surcharge invented by the sweep
  // interval: rounding a five-minute span up to a whole cent every tick is a
  // fifteen percent markup on a box costing seventy-six cents an hour that
  // nobody chose and nothing would explain.
  test("counts whole cents and carries the fraction", async () => {
    // A hundred cents an hour, a hundred seconds elapsed: 2.77 cents earned,
    // two of them counted, and the clock advanced by exactly the 72 seconds
    // those two cents paid for.
    const boxId = await boxFor({ rate: 100, agoMs: 100_000 })
    const before = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any

    expect(await meterBox(db, boxId)).toBe(2)
    expect(await spentThisPeriod(db)).toBe(2)

    const after = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
    const advanced = new Date(after.metered_at).getTime() - new Date(before.metered_at).getTime()
    expect(advanced).toBe(72_000)
  })

  test("counts nothing for a span too short to be worth a cent", async () => {
    const boxId = await boxFor({ rate: 100, agoMs: 10_000 })
    expect(await meterBox(db, boxId)).toBe(0)
    expect(await spentThisPeriod(db)).toBe(0)
  })

  // Two sweeps overlapping — a slow tick, a restart, a second process — must
  // count the hour once between them rather than once each.
  test("two ticks at once count the span once", async () => {
    const boxId = await boxFor({ rate: 100, agoMs: 100_000 })
    const [a, b] = await Promise.all([meterBox(db, boxId), meterBox(db, boxId)])
    expect(a + b).toBe(2)
    expect(await spentThisPeriod(db)).toBe(2)
  })

  test("stopping counts the last fraction and lets go of the clock", async () => {
    const boxId = await boxFor({ rate: 100, agoMs: 10_000 })
    // Ten seconds is a third of a cent, which a periodic tick leaves alone and
    // a final one rounds up — the only place rounding goes up, once, at the
    // end of a box's life.
    expect(await stopMetering(db, boxId)).toBe(1)
    const row = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
    expect(row.metered_at).toBeNull()
  })

  test("a box that was never on the clock costs nothing to stop", async () => {
    const boxId = await boxFor({ rate: 100 })
    expect(await stopMetering(db, boxId)).toBe(0)
    expect(await spentThisPeriod(db)).toBe(0)
  })

  test("starting the clock records the rate the provider quoted", async () => {
    const boxId = await boxFor()
    await startMetering(db, boxId, 76)
    const row = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
    expect(row.cost_cents).toBe(76)
    expect(row.metered_at).not.toBeNull()
  })

  // A size the provider has never heard of reports zero, and zero means "do
  // not count this" rather than "count it as free and pretend that is a
  // number".
  test("a box with no known rate is left alone", async () => {
    const boxId = await boxFor({ rate: 0, agoMs: 3_600_000 })
    expect(await meterBox(db, boxId)).toBe(0)
    expect(await spentThisPeriod(db)).toBe(0)
  })
})

describe("counting a volume", () => {
  // Charged for whether or not a box is attached, which is exactly why they
  // are metered separately rather than folded into the box that mounted them.
  test("a volume with no box on it is still costing money", async () => {
    // 730 GB at ten cents a gigabyte a month is ten cents an hour on the nose.
    const id = await workspaceFor(730, 3_600_000)
    expect(await meterWorkspace(db, id)).toBe(10)
    expect(await spentThisPeriod(db)).toBe(10)
  })

  // Ten cents an hour over six minutes is one cent. The periodic path floors,
  // so it stays one however many milliseconds the test itself took — which is
  // the property worth pinning: a tick must never charge for time it has not
  // measured.
  test("a whole cent is a whole cent, and the fraction waits", async () => {
    const id = await workspaceFor(730, 360_000)
    expect(await meterWorkspace(db, id)).toBe(1)
    expect(await spentThisPeriod(db)).toBe(1)
  })

  test("stopping rounds the last fraction up and lets go of the clock", async () => {
    const id = await workspaceFor(730, 60_000)
    // A minute is a sixth of a cent, which a periodic tick leaves alone and a
    // final one rounds up — the only place rounding goes up.
    expect(await stopWorkspaceMetering(db, id)).toBe(1)
    const row = (await db.one(from("workspaces").where(q => q("id").equals(id)))) as any
    expect(row.metered_at).toBeNull()
  })

  test("starting the clock is what a new volume gets", async () => {
    const id = await workspaceFor(10)
    await startWorkspaceMetering(db, id)
    const row = (await db.one(from("workspaces").where(q => q("id").equals(id)))) as any
    expect(row.metered_at).not.toBeNull()
  })
})

describe("one pass over everything", () => {
  test("counts every live box and every live volume", async () => {
    await boxFor({ rate: 100, agoMs: 3_600_000 })
    await boxFor({ rate: 50, agoMs: 3_600_000 })
    await workspaceFor(730, 3_600_000)
    expect(await meterAll(db)).toBe(160)
    expect(await spentThisPeriod(db)).toBe(160)
  })

  test("and nothing that has already been given back", async () => {
    const boxId = await boxFor({ rate: 100, agoMs: 3_600_000 })
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ destroyed_at: new Date() }),
    )
    const wsId = await workspaceFor(730, 3_600_000)
    await db.execute(
      from("workspaces")
        .where(q => q("id").equals(wsId))
        .update({ deleted_at: new Date() }),
    )
    expect(await meterAll(db)).toBe(0)
  })

  test("the rows say what the money went on", async () => {
    await boxFor({ rate: 100, agoMs: 3_600_000 })
    await meterAll(db)
    const row = (await db.one(from("spend_ledger").orderBy("id", "DESC"))) as any
    expect(row.kind).toBe("box")
    expect(row.user_id).toBe(userId)
    expect(row.note).toContain("gpu-4000adax1-20gb")
    // The span it covers, so a charge can be explained a month later without
    // the sweep's logs.
    expect(row.period_start).not.toBeNull()
    expect(row.period_end).not.toBeNull()
  })
})
