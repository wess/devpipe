import { createHmac } from "node:crypto"
import { digestsMatch } from "../util/token.ts"

/**
 * The Stripe side of billing, over `fetch`.
 *
 * No SDK. The surface needed is five calls and a signature check, and the
 * official package is a large dependency to carry for that. Like the
 * DigitalOcean client, every call takes the key as an argument rather than
 * reading a module-level cache, so which key a request runs under is visible
 * at the call site. The key must never reach a log line — Stripe's own error
 * messages are safe to surface, the credential is not.
 */

const API = "https://api.stripe.com/v1"

// Pinned rather than left to the account default. From 2025-03-31 onward
// `current_period_end` moved off the subscription and onto its items; pinning
// here keeps the shape this code and the subscriptions table expect, and makes
// an upgrade a deliberate edit instead of a surprise from the dashboard.
const API_VERSION = "2024-06-20"

/**
 * Stripe takes form-encoded bodies with bracketed paths for nested values
 * (`line_items[0][price_data][unit_amount]`). Flattening here means call
 * sites can pass ordinary objects.
 */
const form = (data: Record<string, unknown>): string => {
  const parts: string[] = []
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(v, `${key}[${i}]`)
      return
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, key ? `${key}[${k}]` : k)
      }
      return
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  walk(data, "")
  return parts.join("&")
}

const request = async (
  key: string,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<any> => {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": API_VERSION,
    },
    body: init.body ? form(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Stripe names the parameter it objected to, which is worth passing on.
    const message =
      res.status === 401
        ? "Stripe rejected the API key."
        : res.status === 429
          ? "Stripe is rate limiting us. Try again shortly."
          : (body?.error?.message ?? `Stripe returned ${res.status}.`)
    throw new Error(String(message))
  }
  return body
}

export type Customer = {
  readonly id: string
  readonly email: string
}

export type CheckoutSession = {
  readonly id: string
  readonly url: string
  readonly customerId: string
}

export type Subscription = {
  readonly id: string
  readonly customerId: string
  readonly status: string
  /** Null while Stripe has not settled the first invoice. */
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
  readonly metadata: Record<string, string>
}

/** An id field that may arrive expanded into the whole object. */
export const idOf = (value: unknown): string =>
  typeof value === "string" ? value : (value as any)?.id ? String((value as any).id) : ""

const secondsToDate = (value: unknown): Date | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

export const shapeSubscription = (raw: any): Subscription => ({
  id: String(raw?.id ?? ""),
  customerId: idOf(raw?.customer),
  status: String(raw?.status ?? ""),
  // The item fallback covers an account pinned to a newer API version than
  // this client asks for, where the field lives on the item.
  currentPeriodEnd: secondsToDate(raw?.current_period_end ?? raw?.items?.data?.[0]?.current_period_end),
  cancelAtPeriodEnd: Boolean(raw?.cancel_at_period_end),
  metadata: (raw?.metadata ?? {}) as Record<string, string>,
})

/**
 * Fails if the key is not a live, accepted key for this account, before it is
 * stored. It reads rather than writes, so a restricted key with no write scope
 * still passes here and fails at the first checkout — worth knowing, but not
 * worth creating a customer on somebody's live account to find out.
 */
export const verifyKey = async (key: string): Promise<void> => {
  await request(key, "/customers?limit=1")
}

export const createCustomer = async (
  key: string,
  opts: { email: string; name?: string; metadata?: Record<string, string> },
): Promise<Customer> => {
  const body = await request(key, "/customers", {
    method: "POST",
    body: { email: opts.email, name: opts.name, metadata: opts.metadata },
  })
  return { id: String(body.id), email: String(body.email ?? opts.email) }
}

/**
 * A subscription Checkout Session with the amount inline.
 *
 * `subscriptionMetadata` is what the `customer.subscription.*` webhooks carry;
 * without it an update for a subscription this instance has not recorded yet
 * has nothing to tie it to a user.
 */
export const createCheckoutSession = async (
  key: string,
  opts: {
    customerId: string
    currency: string
    unitAmount: number
    productName: string
    successUrl: string
    cancelUrl: string
    clientReferenceId?: string
    metadata?: Record<string, string>
    subscriptionMetadata?: Record<string, string>
  },
): Promise<CheckoutSession> => {
  const body = await request(key, "/checkout/sessions", {
    method: "POST",
    body: {
      mode: "subscription",
      customer: opts.customerId,
      client_reference_id: opts.clientReferenceId,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: opts.currency,
            unit_amount: opts.unitAmount,
            recurring: { interval: "month" },
            product_data: { name: opts.productName },
          },
        },
      ],
      metadata: opts.metadata,
      subscription_data: { metadata: opts.subscriptionMetadata },
    },
  })
  return { id: String(body.id), url: String(body.url ?? ""), customerId: idOf(body.customer) }
}

export const getSubscription = async (key: string, id: string): Promise<Subscription | null> => {
  try {
    return shapeSubscription(await request(key, `/subscriptions/${encodeURIComponent(id)}`))
  } catch {
    return null
  }
}

export const cancelSubscription = async (key: string, id: string): Promise<Subscription> =>
  shapeSubscription(await request(key, `/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }))

export const createPortalSession = async (
  key: string,
  opts: { customerId: string; returnUrl: string },
): Promise<{ url: string }> => {
  const body = await request(key, "/billing_portal/sessions", {
    method: "POST",
    body: { customer: opts.customerId, return_url: opts.returnUrl },
  })
  return { url: String(body.url ?? "") }
}

// ---- webhooks -------------------------------------------------------------

export type WebhookEvent = {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: { readonly object: any }
}

export type WebhookResult = { ok: true; event: WebhookEvent } | { ok: false; reason: string }

/** Stripe's own default. Five minutes of clock skew is generous already. */
const TOLERANCE_SECONDS = 300

const isHexDigest = (value: string) => /^[0-9a-f]{64}$/i.test(value)

/**
 * Checks a `Stripe-Signature` header against the raw body.
 *
 * The header is `t=<unix>,v1=<hex>,...`, and the signed material is
 * `<t>.<body>` under HMAC-SHA256 with the endpoint's signing secret. This is
 * the only thing standing between the webhook route and anyone who can POST
 * JSON, so it takes the *raw* body — reserialising parsed JSON changes the
 * bytes and the signature stops matching for a reason that looks like a bug.
 *
 * The timestamp is inside the signed material, so it cannot be moved; checking
 * it against a tolerance is what stops one captured delivery being replayed
 * forever. `now` is injectable so that is testable without waiting.
 */
export const verifyWebhook = (
  payload: string,
  header: string | null,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): WebhookResult => {
  if (!secret) return { ok: false, reason: "No webhook signing secret is configured." }
  if (!header) return { ok: false, reason: "Missing signature." }

  let timestamp = ""
  const signatures: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === "t") timestamp = value
    // More than one v1 arrives while a secret is being rotated; either is valid.
    else if (name === "v1" && isHexDigest(value)) signatures.push(value)
  }

  const sentAt = Number(timestamp)
  if (!timestamp || !Number.isFinite(sentAt)) return { ok: false, reason: "Malformed signature." }
  if (signatures.length === 0) return { ok: false, reason: "Malformed signature." }

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const tolerance = opts.toleranceSeconds ?? TOLERANCE_SECONDS
  if (Math.abs(now - sentAt) > tolerance) {
    return { ok: false, reason: "Signature timestamp is outside the tolerance." }
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")
  if (!signatures.some(sig => digestsMatch(expected, sig.toLowerCase()))) {
    return { ok: false, reason: "Signature does not match." }
  }

  let event: WebhookEvent
  try {
    event = JSON.parse(payload) as WebhookEvent
  } catch {
    return { ok: false, reason: "Body is not JSON." }
  }
  if (!event?.id || !event?.type) return { ok: false, reason: "Event has no id or type." }
  return { ok: true, event }
}
