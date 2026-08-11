import type { Connection } from "@atlas/db"
import { SIZES } from "../boxes/catalog.ts"
import { getSetting, SETTING } from "../settings/index.ts"

/**
 * What a box costs the person running it.
 *
 * The provider's monthly price is the floor and the owner adds a margin on
 * top. Nothing here creates a Stripe Price: the margin is a setting that can
 * change, and a stored Price would have to be recreated every time it did.
 * Checkout carries the amount inline instead, so the price a customer agreed
 * to is fixed at the moment they agreed to it.
 */

export const DEFAULT_MARGIN_PCT = 100

/** Above this a typo has clearly happened, and a typo here charges a card. */
const MAX_MARGIN_PCT = 1000

// DigitalOcean bills in USD, so the cost basis is USD. Offering another
// display currency would be a conversion problem, not a setting.
export const CURRENCY = "usd"

export type Plan = {
  readonly size: string
  readonly label: string
  readonly memoryMb: number
  /** What the provider charges, in cents. */
  readonly costCents: number
  /** What the customer is charged, in cents. */
  readonly priceCents: number
  /** The same figure in whole currency, for display. */
  readonly monthly: number
}

/**
 * An unset, malformed or negative margin falls back to the default rather
 * than to zero: a bad value in the settings table should not quietly start
 * selling boxes at cost.
 */
export const normalizeMargin = (raw: string | number): number => {
  const text = typeof raw === "number" ? String(raw) : raw.trim()
  if (text === "") return DEFAULT_MARGIN_PCT
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MARGIN_PCT
  return Math.min(n, MAX_MARGIN_PCT)
}

export const marginPct = async (db: Connection): Promise<number> =>
  normalizeMargin(await getSetting(db, SETTING.billingMarginPct))

export const planFor = (size: string, margin: number): Plan | null => {
  const spec = SIZES.find(s => s.slug === size)
  if (!spec) return null
  const costCents = spec.monthly * 100
  const priceCents = Math.round(costCents * (1 + normalizeMargin(margin) / 100))
  return {
    size: spec.slug,
    label: spec.label,
    memoryMb: spec.memoryMb,
    costCents,
    priceCents,
    monthly: priceCents / 100,
  }
}

export const plansFor = (margin: number): Plan[] =>
  SIZES.map(s => planFor(s.slug, margin)).filter((p): p is Plan => p !== null)

/** What a line item is called on the invoice and in the Stripe dashboard. */
export const planName = (plan: Plan): string => `Devpipe box (${plan.label})`
