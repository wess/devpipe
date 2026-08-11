import { createHmac } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { attachSubscription, billingRoutes, releaseSubscription, requireSubscriptionForBox } from "../src/billing/index.ts"
import { DEFAULT_MARGIN_PCT, normalizeMargin, planFor, plansFor } from "../src/billing/plans.ts"
import { verifyWebhook } from "../src/billing/stripe.ts"
import { CREDENTIAL, setCredential, setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

const HOOK_SECRET = "whsec_test_secret_for_signing"

let app: (req: Request) => Promise<Response>
let ownerId = 0
let boxId = 0
let otherBoxId = 0
let ownerToken = ""

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await app(
    new Request(`http://test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

/** Signs like Stripe does, from scratch, so this proves nothing by construction. */
const sign = (payload: string, secret: string, at: number) => {
  const mac = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex")
  return `t=${at},v1=${mac}`
}

const sendWebhook = async (event: unknown, opts: { secret?: string; at?: number } = {}) => {
  const payload = JSON.stringify(event)
  const header = sign(payload, opts.secret ?? HOOK_SECRET, opts.at ?? Math.floor(Date.now() / 1000))
  const res = await app(
    new Request("http://test/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    }),
  )
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

// ---- Stripe stub ----------------------------------------------------------
// Everything the routes send to api.stripe.com is answered from here. A test
// that reaches the network is a test that fails on a plane.

const realFetch = globalThis.fetch
let stripeCalls: { method: string; path: string; body: string }[] = []

beforeAll(async () => {
    await truncateAll()
  app = router(...authRoutes(db), ...billingRoutes(db, "http://web")) as any

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init)

    const path = url.slice("https://api.stripe.com/v1".length)
    const method = String(init.method ?? "GET")
    stripeCalls.push({ method, path, body: String(init.body ?? "") })

    const reply = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })

    if (path.startsWith("/customers?")) return reply({ object: "list", data: [] })
    if (path === "/customers") return reply({ id: "cus_test", email: "member@example.com" })
    if (path === "/checkout/sessions") {
      return reply({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test", customer: "cus_test" })
    }
    if (path === "/billing_portal/sessions") {
      return reply({ url: "https://billing.stripe.com/p/session/test" })
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${path}` } }), { status: 404 })
  }) as any

  const owner = await call("POST", "/auth/register", {
    email: "owner@devpipe.com",
    username: "gatekeeper",
    password: "a-very-long-password",
  })
  ownerId = owner.data.user.id
  ownerToken = owner.data.token
  // Signups are invite-only by default and this suite is not about that gate.
  await setSetting(db, SETTING.signupsOpen, "1")

  const mkBox = async (hostname: string) =>
    Number(
      (
        (await db.execute(
          from("boxes")
            .insert({ user_id: ownerId, name: hostname, hostname, status: "ready" })
            .returning("id"),
        )) as any[]
      )[0].id,
    )
  boxId = await mkBox("billing-a.devpipe.com")
  otherBoxId = await mkBox("billing-b.devpipe.com")
})

afterAll(async () => {
  globalThis.fetch = realFetch
})

describe("prices", () => {
  test("the margin is a percentage on top of what the provider charges", () => {
    // 512MB costs $4 at the provider; at the default 100% margin it sells for $8.
    expect(planFor("s-1vcpu-512mb-10gb", 100)?.priceCents).toBe(800)
    expect(planFor("s-1vcpu-1gb", 100)?.priceCents).toBe(1200)
    expect(planFor("s-1vcpu-2gb", 100)?.priceCents).toBe(2400)
    expect(planFor("s-2vcpu-4gb", 100)?.priceCents).toBe(4800)
  })

  test("a zero margin sells at cost, and the cost is still reported", () => {
    const plan = planFor("s-1vcpu-2gb", 0)
    expect(plan?.priceCents).toBe(1200)
    expect(plan?.costCents).toBe(1200)
    expect(plan?.monthly).toBe(12)
  })

  test("a fractional margin lands on a whole cent", () => {
    // $6 at 35% is $8.10, not $8.099999...
    expect(planFor("s-1vcpu-1gb", 35)?.priceCents).toBe(810)
    expect(planFor("s-1vcpu-512mb-10gb", 33.33)?.priceCents).toBe(533)
  })

  test("a missing or nonsense margin falls back to the default rather than to cost", () => {
    expect(normalizeMargin("")).toBe(DEFAULT_MARGIN_PCT)
    expect(normalizeMargin("not a number")).toBe(DEFAULT_MARGIN_PCT)
    expect(normalizeMargin("-20")).toBe(DEFAULT_MARGIN_PCT)
    expect(normalizeMargin("0")).toBe(0)
    expect(normalizeMargin("35")).toBe(35)
    // Clamped, because a typo here charges somebody's card.
    expect(normalizeMargin("99999")).toBe(1000)
  })

  test("an unknown size has no plan", () => {
    expect(planFor("s-96vcpu-nonsense", 100)).toBeNull()
    expect(plansFor(100).length).toBe(4)
  })
})

describe("the subscription gate", () => {
  test("an instance with no Stripe key does not gate anything", async () => {
    const check = await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")
    expect(check.ok).toBe(true)
  })

  test("once billing exists, no subscription means no box", async () => {
    await setCredential(db, CREDENTIAL.stripeSecretKey, "sk_test_key")
    await setCredential(db, CREDENTIAL.stripeWebhookSecret, HOOK_SECRET)

    const check = await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")
    expect(check.ok).toBe(false)
    expect(check.reason).toContain("Subscribe")
  })

  test("a cancelled subscription does not entitle anyone to anything", async () => {
    await db.execute(
      from("subscriptions").insert({
        user_id: ownerId,
        stripe_customer_id: "cus_test",
        stripe_subscription_id: "sub_dead",
        status: "canceled",
        size: "s-1vcpu-1gb",
      }),
    )
    expect((await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")).ok).toBe(false)
  })

  test("an active subscription covers exactly its own size", async () => {
    await db.execute(
      from("subscriptions").insert({
        user_id: ownerId,
        stripe_customer_id: "cus_test",
        stripe_subscription_id: "sub_live",
        status: "active",
        size: "s-1vcpu-1gb",
      }),
    )

    const right = await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")
    expect(right.ok).toBe(true)
    expect(right.subscriptionId).toBeGreaterThan(0)

    const wrong = await requireSubscriptionForBox(db, ownerId, "s-2vcpu-4gb")
    expect(wrong.ok).toBe(false)
    // The message names both sizes, so it says what to do rather than just no.
    expect(wrong.reason).toContain("1 GB")
    expect(wrong.reason).toContain("4 GB")
  })

  test("a subscription already attached to a box cannot cover a second one", async () => {
    const claim = await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")
    expect(await attachSubscription(db, claim.subscriptionId!, boxId)).toBe(true)

    const again = await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")
    expect(again.ok).toBe(false)
    expect(again.reason).toContain("one box")
  })

  test("two creates racing one subscription: the second is told it lost", async () => {
    // Both passed the gate before either attached, which is the state two
    // concurrent POST /boxes end up in. The loser must not keep its box.
    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_live")),
    )) as any
    expect(await attachSubscription(db, row.id, otherBoxId)).toBe(false)
    const after = (await db.one(from("subscriptions").where(q => q("id").equals(row.id)))) as any
    expect(after.box_id).toBe(boxId)
  })

  test("destroying the box frees the subscription for the next one", async () => {
    await releaseSubscription(db, boxId)
    expect((await requireSubscriptionForBox(db, ownerId, "s-1vcpu-1gb")).ok).toBe(true)
  })

  test("status reports the sizes a box could be created at right now", async () => {
    const { data } = await call("GET", "/billing/status", undefined, ownerToken)
    expect(data.configured).toBe(true)
    expect(data.can_create).toEqual(["s-1vcpu-1gb"])
    expect(data.plans.find((p: any) => p.size === "s-1vcpu-1gb").price_cents).toBe(1200)
  })
})

describe("webhook signatures", () => {
  const payload = '{"id":"evt_x","type":"ping"}'
  const now = 1_700_000_000

  test("a signature made with the right secret verifies", () => {
    const header = sign(payload, HOOK_SECRET, now)
    const out = verifyWebhook(payload, header, HOOK_SECRET, { now })
    expect(out.ok).toBe(true)
  })

  test("a signature made with a different secret does not", () => {
    const header = sign(payload, "whsec_someone_elses_secret", now)
    const out = verifyWebhook(payload, header, HOOK_SECRET, { now })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain("does not match")
  })

  test("a body altered after signing does not", () => {
    const header = sign(payload, HOOK_SECRET, now)
    const out = verifyWebhook('{"id":"evt_x","type":"customer.subscription.created"}', header, HOOK_SECRET, { now })
    expect(out.ok).toBe(false)
  })

  test("a signature captured earlier cannot be replayed later", () => {
    const header = sign(payload, HOOK_SECRET, now)
    // Valid inside the tolerance...
    expect(verifyWebhook(payload, header, HOOK_SECRET, { now: now + 299 }).ok).toBe(true)
    // ...and not outside it, in either direction.
    const late = verifyWebhook(payload, header, HOOK_SECRET, { now: now + 3600 })
    expect(late.ok).toBe(false)
    expect(late.ok === false && late.reason).toContain("tolerance")
    expect(verifyWebhook(payload, header, HOOK_SECRET, { now: now - 3600 }).ok).toBe(false)
  })

  test("a missing, malformed or unconfigured signature is refused", () => {
    expect(verifyWebhook(payload, null, HOOK_SECRET, { now }).ok).toBe(false)
    expect(verifyWebhook(payload, "garbage", HOOK_SECRET, { now }).ok).toBe(false)
    expect(verifyWebhook(payload, `t=${now}`, HOOK_SECRET, { now }).ok).toBe(false)
    expect(verifyWebhook(payload, `t=${now},v1=nothex`, HOOK_SECRET, { now }).ok).toBe(false)
    // No secret configured means nothing can be trusted, not that everything can.
    expect(verifyWebhook(payload, sign(payload, "", now), "", { now }).ok).toBe(false)
  })

  test("a second signature from a rotating secret is accepted alongside the first", () => {
    const mine = createHmac("sha256", HOOK_SECRET).update(`${now}.${payload}`).digest("hex")
    const header = `t=${now},v1=${"0".repeat(64)},v1=${mine}`
    expect(verifyWebhook(payload, header, HOOK_SECRET, { now }).ok).toBe(true)
  })

  test("a signed body that is not an event is refused", () => {
    const body = '{"nope":true}'
    expect(verifyWebhook(body, sign(body, HOOK_SECRET, now), HOOK_SECRET, { now }).ok).toBe(false)
  })
})

describe("the webhook endpoint", () => {
  let userId = 0

  const checkoutCompleted = (id: string, size: string, subscription: string, paymentStatus = "paid") => ({
    id,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "cs_test",
        customer: "cus_test",
        subscription,
        payment_status: paymentStatus,
        client_reference_id: String(userId),
        metadata: { user_id: String(userId), size },
      },
    },
  })

  beforeAll(async () => {
    const reg = await call("POST", "/auth/register", {
      email: "hooked@example.com",
      username: "hooked",
      password: "a-very-long-password",
    })
    userId = reg.data.user.id
  })

  test("an unsigned request is refused, so nobody can grant themselves a subscription", async () => {
    const res = await app(
      new Request("http://test/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutCompleted("evt_forged", "s-2vcpu-4gb", "sub_forged")),
      }),
    )
    expect(res.status).toBe(400)
    const row = await db.one(from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_forged")))
    expect(row).toBeNull()
  })

  test("a request signed with the wrong secret is refused", async () => {
    const out = await sendWebhook(checkoutCompleted("evt_forged2", "s-2vcpu-4gb", "sub_forged2"), {
      secret: "whsec_not_the_configured_one",
    })
    expect(out.status).toBe(400)
    expect(await db.one(from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_forged2")))).toBeNull()
  })

  test("a stale signature is refused even though it is genuine", async () => {
    const out = await sendWebhook(checkoutCompleted("evt_stale", "s-2vcpu-4gb", "sub_stale"), {
      at: Math.floor(Date.now() / 1000) - 3600,
    })
    expect(out.status).toBe(400)
    expect(out.data.error).toContain("tolerance")
  })

  test("a completed checkout records the subscription", async () => {
    const out = await sendWebhook(checkoutCompleted("evt_1", "s-1vcpu-2gb", "sub_new"))
    expect(out.status).toBe(200)

    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_new")),
    )) as any
    expect(row.user_id).toBe(userId)
    expect(row.size).toBe("s-1vcpu-2gb")
    expect(row.status).toBe("active")
    expect((await requireSubscriptionForBox(db, userId, "s-1vcpu-2gb")).ok).toBe(true)
  })

  test("redelivering the same event does not create a second subscription", async () => {
    const again = await sendWebhook(checkoutCompleted("evt_1", "s-1vcpu-2gb", "sub_new"))
    expect(again.status).toBe(200)
    expect(again.data.duplicate).toBe(true)

    const rows = (await db.all(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_new")),
    )) as any[]
    expect(rows.length).toBe(1)
  })

  test("a different event id carrying the same subscription still does not duplicate it", async () => {
    // Stripe fans one state change out over several events; the row is keyed
    // on the subscription, so the second one updates rather than inserts.
    const out = await sendWebhook({
      id: "evt_2",
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_new",
          customer: "cus_test",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: true,
          metadata: { user_id: String(userId), size: "s-1vcpu-2gb" },
        },
      },
    })
    expect(out.status).toBe(200)

    const rows = (await db.all(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_new")),
    )) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].cancel_at_period_end).toBe(1)
    // A timestamptz comes back as a Date, not the ISO string SQLite stored.
    expect(new Date(rows[0].current_period_end).getUTCFullYear()).toBe(2027)
  })

  test("a subscription that arrives before its checkout session is still attributed", async () => {
    const out = await sendWebhook({
      id: "evt_3",
      type: "customer.subscription.created",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_early",
          customer: "cus_test",
          status: "active",
          metadata: { user_id: String(userId), size: "s-2vcpu-4gb" },
        },
      },
    })
    expect(out.status).toBe(200)
    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_early")),
    )) as any
    expect(row.user_id).toBe(userId)
    expect(row.size).toBe("s-2vcpu-4gb")
  })

  test("a deletion cancels once, and a retry does not cancel anything else", async () => {
    const deleted = {
      id: "evt_4",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "sub_new", customer: "cus_test", status: "canceled" } },
    }
    expect((await sendWebhook(deleted)).status).toBe(200)

    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_new")),
    )) as any
    expect(row.status).toBe("canceled")
    expect((await requireSubscriptionForBox(db, userId, "s-1vcpu-2gb")).ok).toBe(false)

    const retry = await sendWebhook(deleted)
    expect(retry.data.duplicate).toBe(true)
    // The other subscription is untouched: a retry cancels nothing extra.
    const other = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_early")),
    )) as any
    expect(other.status).toBe("active")
  })

  test("a session that completed without settling does not entitle anyone yet", async () => {
    const out = await sendWebhook(checkoutCompleted("evt_unpaid", "s-1vcpu-1gb", "sub_unpaid", "unpaid"))
    expect(out.status).toBe(200)

    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_unpaid")),
    )) as any
    expect(row.status).toBe("incomplete")
    expect((await requireSubscriptionForBox(db, userId, "s-1vcpu-1gb")).ok).toBe(false)
  })

  test("a checkout session delivered after the cancellation does not revive it", async () => {
    // Stripe queues a failed delivery for days and does not replay in order, so
    // the session that started `sub_new` can land after it has been cancelled.
    const late = await sendWebhook(checkoutCompleted("evt_late", "s-1vcpu-2gb", "sub_new"))
    expect(late.status).toBe(200)

    const row = (await db.one(
      from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_new")),
    )) as any
    expect(row.status).toBe("canceled")
    expect((await requireSubscriptionForBox(db, userId, "s-1vcpu-2gb")).ok).toBe(false)
  })

  test("an event for a subscription nobody can be identified from is ignored", async () => {
    const out = await sendWebhook({
      id: "evt_5",
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "sub_orphan", customer: "cus_someone", status: "active" } },
    })
    expect(out.status).toBe(200)
    expect(await db.one(from("subscriptions").where(q => q("stripe_subscription_id").equals("sub_orphan")))).toBeNull()
  })
})

describe("checkout and the portal", () => {
  let token = ""

  beforeAll(async () => {
    const reg = await call("POST", "/auth/register", {
      email: "buyer@example.com",
      username: "buyer",
      password: "a-very-long-password",
    })
    token = reg.data.token
    stripeCalls = []
  })

  test("the portal has nothing to show before there is a customer", async () => {
    const { status } = await call("GET", "/billing/portal", undefined, token)
    expect(status).toBe(409)
  })

  test("checkout sends the price the margin produces, not the provider's", async () => {
    await setSetting(db, SETTING.billingMarginPct, "50")
    const { status, data } = await call("POST", "/billing/checkout", { size: "s-1vcpu-2gb" }, token)
    expect(status).toBe(200)
    expect(data.url).toContain("checkout.stripe.com")
    // $12 at 50% is $18.
    expect(data.price_cents).toBe(1800)

    const session = stripeCalls.find(c => c.path === "/checkout/sessions")!
    expect(decodeURIComponent(session.body)).toContain("line_items[0][price_data][unit_amount]=1800")
    expect(decodeURIComponent(session.body)).toContain("mode=subscription")
    // The subscription carries who it is for, so a webhook that arrives before
    // the session completes can still be attributed.
    expect(decodeURIComponent(session.body)).toContain("subscription_data[metadata][user_id]")
    await setSetting(db, SETTING.billingMarginPct, "100")
  })

  test("a second checkout reuses the customer rather than creating another", async () => {
    await call("POST", "/billing/checkout", { size: "s-1vcpu-1gb" }, token)
    expect(stripeCalls.filter(c => c.method === "POST" && c.path === "/customers").length).toBe(1)
  })

  test("an unknown size is refused before Stripe is involved", async () => {
    stripeCalls = []
    const { status } = await call("POST", "/billing/checkout", { size: "s-1vcpu-9tb" }, token)
    expect(status).toBe(422)
    expect(stripeCalls.length).toBe(0)
  })

  test("the portal opens once there is a customer", async () => {
    const { status, data } = await call("GET", "/billing/portal", undefined, token)
    expect(status).toBe(200)
    expect(data.url).toContain("billing.stripe.com")
  })

  test("billing endpoints need a session", async () => {
    expect((await call("GET", "/billing/status")).status).toBe(401)
    expect((await call("POST", "/billing/checkout", { size: "s-1vcpu-1gb" })).status).toBe(401)
    expect((await call("GET", "/billing/portal")).status).toBe(401)
  })

  test("only the owner reads or changes the Stripe configuration", async () => {
    expect((await call("GET", "/billing/config", undefined, token)).status).toBe(403)
    expect((await call("PUT", "/billing/config", { margin_pct: 0 }, token)).status).toBe(403)
  })

  test("a user cannot open unlimited checkout sessions on the instance's Stripe account", async () => {
    let refused = 0
    for (let i = 0; i < 30; i++) {
      const { status } = await call("POST", "/billing/checkout", { size: "s-1vcpu-1gb" }, token)
      if (status === 429) refused++
    }
    expect(refused).toBeGreaterThan(0)
    // And nothing was sent to Stripe for the refused ones.
    expect(stripeCalls.filter(c => c.path === "/checkout/sessions").length).toBeLessThan(30)
  })

  test("the configuration never returns a key, only enough to tell two apart", async () => {
    const owner = await call("POST", "/auth/login", {
      email: "owner@devpipe.com",
      password: "a-very-long-password",
    })
    const { status, data } = await call("GET", "/billing/config", undefined, owner.data.token)
    expect(status).toBe(200)
    expect(data.secret_key).toBe("…_key")
    expect(JSON.stringify(data)).not.toContain("sk_test_key")

    const bad = await call("PUT", "/billing/config", { secret_key: "pk_live_oops" }, owner.data.token)
    expect(bad.status).toBe(422)
    const badHook = await call("PUT", "/billing/config", { webhook_secret: "nope" }, owner.data.token)
    expect(badHook.status).toBe(422)
  })
})
