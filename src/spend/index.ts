import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { getSetting, SETTING } from "../settings/index.ts"

/**
 * What the instance is costing, and the ceiling it may not go past.
 *
 * This is the half of billing that matters on an instance with no billing.
 * Nobody is charged for a box here. Devpipe runs on your own DigitalOcean
 * account, so the only money question is what the machines are costing *you* —
 * and the failure that actually happens is a box left running over a holiday.
 * A spending cap is the whole answer to that, and it needs three things:
 *
 *  - **Every box measured, not just the hourly ones.** A $4/month box is not
 *    interesting on its own and twenty of them are.
 *  - **Volumes counted.** They are charged for whether or not a box is attached,
 *    and they are what is left when everything else has been tidied away.
 *  - **Accumulation.** A cap computed from what is running right now resets
 *    every time somebody destroys something, which is not a cap.
 *
 * The provider's own price, with no margin on it. This number answers "what
 * will DigitalOcean charge me", and a margin would make it answer nothing.
 */

/** DigitalOcean's block storage, in cents per gigabyte per month. */
export const VOLUME_CENTS_PER_GB_MONTH = 10

/**
 * Hours in the month the provider bills against. DigitalOcean prices monthly
 * as 730 hours, so a volume's hourly cost is its monthly price over that — use
 * their arithmetic rather than a real calendar or the two disagree by a few
 * percent every February.
 */
const HOURS_PER_MONTH = 730

export const volumeCentsPerHour = (sizeGb: number): number =>
  (VOLUME_CENTS_PER_GB_MONTH * Math.max(0, sizeGb)) / HOURS_PER_MONTH

/**
 * The start of the period a cap applies to: the first of the month, UTC.
 *
 * Matched to the provider's own cycle rather than made configurable. A cap
 * whose period is out of step with the invoice it is protecting produces a
 * number nobody can reconcile against anything.
 */
export const periodStart = (now = new Date()): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

export const record = async (
  db: Connection,
  entry: {
    cents: number
    kind: "box" | "workspace"
    boxId?: number | null
    workspaceId?: number | null
    userId?: number | null
    note?: string
    periodStart?: Date
    periodEnd?: Date
  },
): Promise<void> => {
  await db.execute(
    from("spend_ledger").insert({
      cents: entry.cents,
      kind: entry.kind,
      box_id: entry.boxId ?? null,
      workspace_id: entry.workspaceId ?? null,
      user_id: entry.userId ?? null,
      note: (entry.note ?? "").slice(0, 200),
      period_start: entry.periodStart ?? null,
      period_end: entry.periodEnd ?? null,
    }),
  )
}

/** What has been spent since the start of the provider's billing month. */
export const spentThisPeriod = async (db: Connection, now = new Date()): Promise<number> => {
  const row = (await db.one(
    from("spend_ledger")
      .where(q => q("created_at").greaterThanOrEqual(periodStart(now)))
      .select("COALESCE(SUM(cents), 0) AS spent"),
  )) as any
  return Number(row?.spent ?? 0)
}

/**
 * What everything currently running will cost per hour if nothing changes.
 *
 * The forward-looking half. Spend alone says where you have been; a cap is
 * useful because it can say "at this rate you reach it on Thursday", and
 * refusing a box is a decision about the future rather than the past.
 */
export const runRateCentsPerHour = async (db: Connection): Promise<number> => {
  const boxes = (await db.all(
    from("boxes")
      .where(q => q("metered_at").isNotNull())
      .where(q => q("destroyed_at").isNull())
      .select("cost_cents"),
  )) as any[]
  const volumes = (await db.all(
    from("workspaces")
      .where(q => q("deleted_at").isNull())
      .select("size_gb"),
  )) as any[]

  const fromBoxes = boxes.reduce((sum, b) => sum + (Number(b.cost_cents) || 0), 0)
  const fromVolumes = volumes.reduce((sum, w) => sum + volumeCentsPerHour(Number(w.size_gb) || 0), 0)
  return fromBoxes + fromVolumes
}

export type Cap = {
  /** 0 means no cap. */
  readonly capCents: number
  readonly spentCents: number
  readonly runRateCentsPerHour: number
  /** Fraction of the cap used, 0–1+. Zero when there is no cap. */
  readonly used: number
  readonly warnAtPct: number
  readonly warning: boolean
  readonly over: boolean
  /** When the cap would be reached at the current rate. Null if never, or no cap. */
  readonly reachedAt: string | null
  readonly periodStart: string
}

export const capState = async (db: Connection, now = new Date()): Promise<Cap> => {
  const capCents = Math.max(0, Number(await getSetting(db, SETTING.spendCapCents)) || 0)
  const warnAtPct = Math.min(99, Math.max(1, Number(await getSetting(db, SETTING.spendWarnPct)) || 80))
  const spentCents = await spentThisPeriod(db, now)
  const rate = await runRateCentsPerHour(db)

  const used = capCents > 0 ? spentCents / capCents : 0
  const remaining = capCents > 0 ? capCents - spentCents : 0
  const hoursLeft = capCents > 0 && rate > 0 && remaining > 0 ? remaining / rate : null

  return {
    capCents,
    spentCents,
    runRateCentsPerHour: rate,
    used,
    warnAtPct,
    warning: capCents > 0 && used * 100 >= warnAtPct,
    over: capCents > 0 && spentCents >= capCents,
    reachedAt: hoursLeft === null ? null : new Date(now.getTime() + hoursLeft * 3_600_000).toISOString(),
    periodStart: periodStart(now).toISOString(),
  }
}

/**
 * Whether one more machine may be started.
 *
 * Refuses on what is already spent, and on what the new box would commit
 * before anybody could notice — an hour of runway, so a box created at 99% of
 * the cap does not put the instance over it before the next sweep. That is the
 * same shape as the credit runway rule, for the same reason: the moment to say
 * no is free, and every moment afterwards costs money.
 */
export const withinCap = async (
  db: Connection,
  addingCentsPerHour = 0,
): Promise<{ ok: boolean; reason: string; cap: Cap }> => {
  const cap = await capState(db)
  if (cap.capCents <= 0) return { ok: true, reason: "", cap }

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
  if (cap.over) {
    return {
      ok: false,
      reason: `This instance has spent ${money(cap.spentCents)} of its ${money(cap.capCents)} cap this month. Nothing new can be started until the cap is raised or the month turns over.`,
      cap,
    }
  }
  if (cap.spentCents + addingCentsPerHour > cap.capCents) {
    return {
      ok: false,
      reason: `That would take this instance past its ${money(cap.capCents)} monthly cap. ${money(cap.capCents - cap.spentCents)} is left.`,
      cap,
    }
  }
  return { ok: true, reason: "", cap }
}

/**
 * What one person's machines have cost this month.
 *
 * Nobody is billed for it — the invoice goes to whoever installed this — which
 * is exactly why everybody can see their own number. On an instance shared by
 * a team, the alternative is that the cost of a box left running is visible
 * only to the one person who did not leave it running.
 */
export const spendRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))

  return [
    get(
      "/spend/mine",
      authed(async c => {
        const me = currentUser(c)
        const start = periodStart()

        const total = (await db.one(
          from("spend_ledger")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("created_at").greaterThanOrEqual(start))
            .select("COALESCE(SUM(cents), 0) AS spent"),
        )) as any

        const rows = (await db.all(
          from("spend_ledger")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("created_at").greaterThanOrEqual(start))
            .orderBy("created_at", "DESC")
            .limit(100),
        )) as any[]

        // Their own live machines, so the page can say what the next hour
        // looks like as well as what the last month did.
        const boxes = (await db.all(
          from("boxes")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("metered_at").isNotNull())
            .where(q => q("destroyed_at").isNull())
            .select("cost_cents"),
        )) as any[]
        const volumes = (await db.all(
          from("workspaces")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("deleted_at").isNull())
            .select("size_gb"),
        )) as any[]
        const rate =
          boxes.reduce((sum, b) => sum + (Number(b.cost_cents) || 0), 0) +
          volumes.reduce((sum, w) => sum + volumeCentsPerHour(Number(w.size_gb) || 0), 0)

        const cap = await capState(db)
        return json(c, 200, {
          spent_cents: Number(total?.spent ?? 0),
          run_rate_cents_per_hour: rate,
          period_start: start.toISOString(),
          // The instance's ceiling, so somebody about to start a machine can
          // see there is no room for it before they are refused.
          cap_cents: cap.capCents,
          instance_spent_cents: cap.spentCents,
          entries: rows.map(r => ({
            id: r.id,
            cents: Number(r.cents),
            kind: r.kind,
            note: r.note,
            created_at: r.created_at,
          })),
        })
      }),
    ),
  ]
}
