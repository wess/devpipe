import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, pipeline, post, put } from "@atlas/server"
import type { AuthUser } from "../auth/guard.ts"
import { currentUser, requireAuth, requireOwner } from "../auth/guard.ts"
import { SIZES } from "../boxes/catalog.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { CREDENTIAL, credentialHint, getCredential, SETTING, setCredential, setSetting } from "../settings/index.ts"
import { audit } from "../util/audit.ts"
import { CURRENCY, marginPct, normalizeMargin, planFor, planName, plansFor } from "./plans.ts"
import * as stripe from "./stripe.ts"

/**
 * A box is a subscription.
 *
 * One active subscription buys one box of the size it was bought at. That is
 * the whole model, and keeping it that literal is what makes the check on the
 * create path a single query instead of a proration calculation.
 */

/** Statuses that entitle someone to a box. `past_due` deliberately does not. */
const ENTITLED = ["active", "trialing"] as const

const sizeLabel = (slug: string) => SIZES.find(s => s.slug === slug)?.label ?? slug

const publicSubscription = (row: any) => ({
  id: row.id,
  status: row.status,
  size: row.size,
  label: sizeLabel(row.size),
  box_id: row.box_id ?? null,
  current_period_end: row.current_period_end ?? null,
  cancel_at_period_end: Boolean(row.cancel_at_period_end),
})

// ---- the gate -------------------------------------------------------------

export type SubscriptionCheck = {
  readonly ok: boolean
  readonly reason: string
  /** The row that would cover this box; pass it to `attachSubscription`. */
  readonly subscriptionId?: number
}

/**
 * Whether this user may create a box of this size right now.
 *
 * Called from the box create path before anything is provisioned, because a
 * droplet that exists is already costing money whether or not it was paid for.
 */
export const requireSubscriptionForBox = async (
  db: Connection,
  userId: number,
  size: string,
): Promise<SubscriptionCheck> => {
  // An instance with no Stripe key has no way to sell anything, and gating on
  // a subscription there would mean nobody can ever create a box. Billing
  // enforces itself only once billing exists.
  if (!(await getCredential(db, CREDENTIAL.stripeSecretKey))) return { ok: true, reason: "" }

  const mine = (await db.all(
    from("subscriptions")
      .where(q => q("user_id").equals(userId))
      .where(q => q("status").inList([...ENTITLED])),
  )) as any[]

  if (mine.length === 0) {
    return { ok: false, reason: "Subscribe before creating a box." }
  }

  const free = mine.filter(r => r.box_id === null || r.box_id === undefined)
  if (free.length === 0) {
    return {
      ok: false,
      reason: "Each subscription covers one box. Destroy a box you have, or subscribe again.",
    }
  }

  const match = free.find(r => r.size === size)
  if (!match) {
    const have = [...new Set(free.map(r => sizeLabel(r.size)))].join(", ")
    return {
      ok: false,
      reason: `Your unused subscription is for ${have}. Create that size, or subscribe to ${sizeLabel(size)}.`,
    }
  }

  return { ok: true, reason: "", subscriptionId: Number(match.id) }
}

/**
 * Claims a subscription for a box, and says whether the claim won.
 *
 * The `box_id IS NULL` guard makes a repeat call a no-op rather than a way to
 * move a subscription off another box. Two creates that pass the gate at the
 * same time see the same free row, so the loser gets `false` back here and its
 * caller must not keep the box — checking the gate is not enough on its own.
 */
export const attachSubscription = async (db: Connection, subscriptionId: number, boxId: number): Promise<boolean> => {
  const claimed = (await db.execute(
    from("subscriptions")
      .where(q => q("id").equals(subscriptionId))
      .where(q => q("box_id").isNull())
      .update({ box_id: boxId })
      .returning("id"),
  )) as any[]
  return claimed.length > 0
}

/** Frees a subscription when its box goes away, so it can cover the next one. */
export const releaseSubscription = async (db: Connection, boxId: number): Promise<void> => {
  await db.execute(
    from("subscriptions")
      .where(q => q("box_id").equals(boxId))
      .update({ box_id: null }),
  )
}

// ---- webhook handling -----------------------------------------------------

const upsertSubscription = async (
  db: Connection,
  fields: {
    userId: number
    customerId: string
    subscriptionId: string
    size: string
    status: string
    currentPeriodEnd?: Date | null
    cancelAtPeriodEnd?: boolean
  },
): Promise<void> => {
  const existing = (await db.one(
    from("subscriptions").where(q => q("stripe_subscription_id").equals(fields.subscriptionId)),
  )) as any

  if (existing) {
    // Stripe never revives a cancelled subscription id, so an event that would
    // move this row out of `canceled` is a late or out-of-order delivery — the
    // checkout session that has been sitting in Stripe's retry queue since
    // before the cancellation, most often. Honouring it hands the box back.
    if (existing.status === "canceled") return

    await db.execute(
      from("subscriptions")
        .where(q => q("id").equals(existing.id))
        .update({
          status: fields.status,
          // A period end only ever arrives from Stripe; a handler that does
          // not know one must not blank the one already recorded. Same for the
          // cancellation flag: `checkout.session.completed` carries neither.
          current_period_end: fields.currentPeriodEnd ?? existing.current_period_end,
          cancel_at_period_end:
            fields.cancelAtPeriodEnd === undefined ? existing.cancel_at_period_end : fields.cancelAtPeriodEnd ? 1 : 0,
        }),
    )
    return
  }

  await db.execute(
    from("subscriptions").insert({
      user_id: fields.userId,
      stripe_customer_id: fields.customerId,
      stripe_subscription_id: fields.subscriptionId,
      status: fields.status,
      size: fields.size,
      current_period_end: fields.currentPeriodEnd ?? null,
      cancel_at_period_end: fields.cancelAtPeriodEnd ? 1 : 0,
    }),
  )
}

/**
 * Every branch is an upsert keyed on the Stripe subscription id, so the order
 * events arrive in does not matter and a redelivery that slips past the event
 * log still cannot produce a second row.
 */
const applyEvent = async (db: Connection, event: stripe.WebhookEvent): Promise<void> => {
  const object = event.data?.object ?? {}

  if (event.type === "checkout.session.completed") {
    const subscriptionId = stripe.idOf(object.subscription)
    const userId = Number(object.metadata?.user_id ?? object.client_reference_id ?? 0)
    const size = String(object.metadata?.size ?? "")
    if (!subscriptionId || !userId || !size) return
    // A session completes before the money necessarily moves — anything Stripe
    // settles asynchronously reports `unpaid` here and pays later. Recording
    // that as active sells a box on a payment that has not happened; recording
    // it as incomplete costs nothing, because the `customer.subscription.*`
    // event that follows carries the real status either way.
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required"
    await upsertSubscription(db, {
      userId,
      customerId: stripe.idOf(object.customer),
      subscriptionId,
      size,
      status: paid ? "active" : "incomplete",
    })
    return
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const sub = stripe.shapeSubscription(object)
    if (!sub.id) return

    const existing = (await db.one(from("subscriptions").where(q => q("stripe_subscription_id").equals(sub.id)))) as any

    // Metadata is set on the subscription at checkout, so an event that
    // arrives before the session completed still knows whose it is.
    const userId = Number(existing?.user_id ?? sub.metadata?.user_id ?? 0)
    const size = String(existing?.size ?? sub.metadata?.size ?? "")
    if (!userId || !size) return

    await upsertSubscription(db, {
      userId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      size,
      // A deleted subscription is reported however Stripe last saw it; the
      // row has to say `canceled` or the gate keeps honouring it.
      status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    })
    // `box_id` is deliberately left alone on cancellation: the gate already
    // ignores a cancelled row, and keeping the link is how anyone finds the
    // box that is still running without one.
  }
}

// ---- routes ---------------------------------------------------------------

const ensureCustomer = async (db: Connection, key: string, me: AuthUser): Promise<string> => {
  const row = (await db.one(from("users").where(q => q("id").equals(me.id)))) as any
  if (row?.stripe_customer_id) return String(row.stripe_customer_id)

  const customer = await stripe.createCustomer(key, {
    email: me.email,
    name: me.name,
    metadata: { user_id: String(me.id), username: me.username },
  })
  // Only if nobody else got there first. Two first checkouts at once each
  // create a customer, and the one that loses this must go on to use the id
  // that was recorded rather than its own — a subscription bought under a
  // customer the user row does not point at can never be reached from the
  // portal, which is the only place anyone can cancel.
  const claimed = (await db.execute(
    from("users")
      .where(q => q("id").equals(me.id))
      .where(q => q("stripe_customer_id").equals(""))
      .update({ stripe_customer_id: customer.id })
      .returning("id"),
  )) as any[]
  if (claimed.length > 0) return customer.id

  const winner = (await db.one(from("users").where(q => q("id").equals(me.id)))) as any
  return String(winner?.stripe_customer_id ?? customer.id)
}

export const billingRoutes = (db: Connection, appUrl: string) => {
  const authed = pipeline(requireAuth({ db }))
  // Both of these spend a call on Stripe's account-wide quota, and checkout
  // also creates a customer the first time. A signed-in user retrying a
  // checkout a few times is normal; hundreds is either a loop or an attempt to
  // get the account rate limited for everybody.
  //
  // The subject bucket is tighter than the address bucket here, which is the
  // opposite of the sign-in routes. The subject is a session, not an email
  // somebody else can name, so nobody can burn a stranger's budget: the only
  // account it can lock out is the one holding the token.
  const checkoutLimited = pipeline(
    requireAuth({ db }),
    rateLimit({ db, key: "billing.checkout", limit: 60, windowSeconds: 3600, subject: signedInUser, subjectLimit: 20 }),
    parseJson,
  )
  const portalLimited = pipeline(
    requireAuth({ db }),
    rateLimit({ db, key: "billing.portal", limit: 60, windowSeconds: 3600, subject: signedInUser, subjectLimit: 20 }),
  )
  const owner = pipeline(requireAuth({ db }), requireOwner())
  const ownerJson = pipeline(requireAuth({ db }), requireOwner(), parseJson)

  const notConfigured = (c: any) =>
    json(c, 503, { error: "Billing is not set up yet. The instance owner needs to add Stripe keys." })

  return [
    get(
      "/billing/status",
      authed(async c => {
        const me = currentUser(c)
        const key = await getCredential(db, CREDENTIAL.stripeSecretKey)
        const margin = await marginPct(db)
        const rows = (await db.all(
          from("subscriptions")
            .where(q => q("user_id").equals(me.id))
            .orderBy("created_at", "DESC"),
        )) as any[]

        const entitled = rows.filter(r => (ENTITLED as readonly string[]).includes(r.status))
        const free = entitled.filter(r => r.box_id === null || r.box_id === undefined)

        return json(c, 200, {
          configured: Boolean(key),
          margin_pct: margin,
          currency: CURRENCY,
          plans: plansFor(margin).map(p => ({
            size: p.size,
            label: p.label,
            price_cents: p.priceCents,
            monthly: p.monthly,
          })),
          subscriptions: rows.map(publicSubscription),
          // The sizes this user could create a box at right now, which is what
          // the wizard needs to decide between "create" and "subscribe".
          can_create: free.map(r => r.size),
        })
      }),
    ),

    post(
      "/billing/checkout",
      checkoutLimited(async c => {
        const me = currentUser(c)
        const key = await getCredential(db, CREDENTIAL.stripeSecretKey)
        if (!key) return notConfigured(c)

        const size = String((c.body as any)?.size ?? "")
        const plan = planFor(size, await marginPct(db))
        if (!plan) return json(c, 422, { error: "Pick a size from the catalog." })

        try {
          const customerId = await ensureCustomer(db, key, me)
          const session = await stripe.createCheckoutSession(key, {
            customerId,
            currency: CURRENCY,
            unitAmount: plan.priceCents,
            productName: planName(plan),
            successUrl: `${appUrl}/billing?checkout=done`,
            cancelUrl: `${appUrl}/billing?checkout=cancelled`,
            clientReferenceId: String(me.id),
            metadata: { user_id: String(me.id), size: plan.size },
            subscriptionMetadata: { user_id: String(me.id), size: plan.size },
          })
          if (!session.url) return json(c, 502, { error: "Stripe did not return a checkout link." })
          await audit(db, me.id, "billing.checkout", plan.size)
          return json(c, 200, { url: session.url, size: plan.size, price_cents: plan.priceCents })
        } catch (err: any) {
          return json(c, 502, { error: String(err?.message ?? "Could not start checkout.") })
        }
      }),
    ),

    get(
      "/billing/portal",
      portalLimited(async c => {
        const me = currentUser(c)
        const key = await getCredential(db, CREDENTIAL.stripeSecretKey)
        if (!key) return notConfigured(c)

        const row = (await db.one(from("users").where(q => q("id").equals(me.id)))) as any
        if (!row?.stripe_customer_id) {
          return json(c, 409, { error: "There is nothing to manage yet. Subscribe first." })
        }

        try {
          const session = await stripe.createPortalSession(key, {
            customerId: String(row.stripe_customer_id),
            returnUrl: `${appUrl}/billing`,
          })
          return json(c, 200, { url: session.url })
        } catch (err: any) {
          return json(c, 502, { error: String(err?.message ?? "Could not open the billing portal.") })
        }
      }),
    ),

    /**
     * Not behind `requireAuth` — Stripe has no session. The signature is the
     * authentication, and it is checked against the raw body before anything
     * here reads a field.
     */
    post("/billing/webhook", async c => {
      const secret = await getCredential(db, CREDENTIAL.stripeWebhookSecret)
      const payload = await c.request.text()
      const verified = stripe.verifyWebhook(payload, c.headers.get("stripe-signature"), secret ?? "")
      if (!verified.ok) {
        // 400, not 401: there is no credential to challenge for, and Stripe
        // treats any non-2xx as a failed delivery and retries either way.
        return json(c, 400, { error: verified.reason })
      }

      const event = verified.event
      const seen = (await db.one(from("billing_events").where(q => q("id").equals(event.id)))) as any
      if (seen) return json(c, 200, { ok: true, duplicate: true })

      // Recorded after the handler, not before: a handler that throws should
      // be retried, and every branch is an upsert so a retry is harmless.
      await applyEvent(db, event)
      await db.execute(from("billing_events").insert({ id: event.id, type: event.type }))
      return json(c, 200, { ok: true })
    }),

    // ---- owner configuration ---------------------------------------------
    // Kept here rather than in /admin so the admin module and this one can be
    // worked on independently. The admin screen calls these.

    get(
      "/billing/config",
      owner(async c => {
        const key = await getCredential(db, CREDENTIAL.stripeSecretKey)
        const hook = await getCredential(db, CREDENTIAL.stripeWebhookSecret)
        return json(c, 200, {
          configured: Boolean(key && hook),
          margin_pct: await marginPct(db),
          currency: CURRENCY,
          secret_key: credentialHint(key),
          webhook_secret: credentialHint(hook),
          livemode: key ? key.startsWith("sk_live_") : null,
          plans: plansFor(await marginPct(db)).map(p => ({
            size: p.size,
            label: p.label,
            cost_cents: p.costCents,
            price_cents: p.priceCents,
          })),
        })
      }),
    ),

    put(
      "/billing/config",
      ownerJson(async c => {
        const me = currentUser(c)
        const b = (c.body ?? {}) as { margin_pct?: string | number; secret_key?: string; webhook_secret?: string }
        const changed: string[] = []

        if (b.margin_pct !== undefined) {
          const raw = typeof b.margin_pct === "number" ? b.margin_pct : String(b.margin_pct).trim()
          const n = Number(raw)
          if (!Number.isFinite(n) || n < 0) {
            return json(c, 422, { error: "The margin is a percentage: 0 or more." })
          }
          await setSetting(db, SETTING.billingMarginPct, String(normalizeMargin(raw)))
          changed.push("margin")
        }

        if (b.secret_key !== undefined) {
          const key = String(b.secret_key).trim()
          if (!key.startsWith("sk_") && !key.startsWith("rk_")) {
            return json(c, 422, { error: "That is not a Stripe secret key. It starts with sk_ or rk_." })
          }
          // Verified before it is stored, so a key that does not work is
          // caught here rather than at somebody's checkout.
          try {
            await stripe.verifyKey(key)
          } catch (err: any) {
            return json(c, 422, { error: String(err?.message ?? "That key did not work.") })
          }
          await setCredential(db, CREDENTIAL.stripeSecretKey, key)
          changed.push("secret key")
        }

        if (b.webhook_secret !== undefined) {
          const hook = String(b.webhook_secret).trim()
          if (!hook.startsWith("whsec_")) {
            return json(c, 422, { error: "That is not a webhook signing secret. It starts with whsec_." })
          }
          await setCredential(db, CREDENTIAL.stripeWebhookSecret, hook)
          changed.push("webhook secret")
        }

        // The values themselves never appear here or anywhere else.
        await audit(db, me.id, "billing.configured", changed.join(", "))
        return json(c, 200, { ok: true, changed })
      }),
    ),
  ]
}
