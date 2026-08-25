import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { adminRoutes } from "../src/admin/index.ts"
import { authRoutes } from "../src/auth/index.ts"
import { sessionRoutes } from "../src/auth/sessions.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { CREDENTIAL, SETTING, setCredential, setSetting } from "../src/settings/index.ts"
import { userRoutes } from "../src/users/index.ts"
import { waitlistRoutes } from "../src/waitlist/index.ts"
import { db, truncateAll } from "./setup.ts"

let fetchApp: (req: Request) => Promise<Response>

/**
 * Every request here arrives from the same address, so a suite that registers
 * eight accounts would spend the hourly budget four tests in. The limiter has
 * its own suite; these are about what the routes do, so each test starts with
 * its own budget.
 */
const clearLimits = (conn: Connection) => conn.execute({ text: "DELETE FROM rate_limits", values: [] } as any)

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetchApp(
    new Request(`http://test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, data: data as any }
}

beforeAll(async () => {
    await truncateAll()
  fetchApp = router(
    ...authRoutes(db),
    ...sessionRoutes(db),
    ...userRoutes(db),
    ...boxRoutes(db, "http://test"),
    ...adminRoutes(db),
    ...waitlistRoutes(db),
  ) as any
})

describe("accounts", () => {
  beforeEach(() => clearLimits(db))

  let ownerToken = ""
  let memberToken = ""
  let memberId = 0

  test("a fresh instance says it needs an owner", async () => {
    const { data } = await call("GET", "/auth/state")
    expect(data.needs_owner).toBe(true)
  })

  test("the first account registered becomes the owner", async () => {
    const { status, data } = await call("POST", "/auth/register", {
      email: "owner@devpipe.com",
      username: "bosslady",
      password: "a-very-long-password",
    })
    expect(status).toBe(201)
    expect(data.user.is_owner).toBe(true)
    ownerToken = data.token
    expect((await call("GET", "/auth/state")).data.needs_owner).toBe(false)

    // Signups are closed by default now — an instance that provisions paid
    // infrastructure should not be open the moment it boots. The rest of this
    // suite is about accounts, not the gate, so open it here.
    await call("PATCH", "/admin/settings", { signups_open: "1" }, ownerToken)
  })

  test("the second account does not", async () => {
    const { data } = await call("POST", "/auth/register", {
      email: "member@example.com",
      username: "member",
      password: "another-long-password",
    })
    expect(data.user.is_owner).toBe(false)
    memberToken = data.token
    memberId = data.user.id
  })

  test("a username that would collide with a reserved hostname is refused", async () => {
    const { status } = await call("POST", "/auth/register", {
      email: "x@example.com",
      username: "www",
      password: "a-very-long-password",
    })
    expect(status).toBe(422)
  })

  test("short passwords and malformed emails are refused", async () => {
    expect(
      (await call("POST", "/auth/register", { email: "a@b.co", username: "shorty", password: "abc" }))
        .status,
    ).toBe(422)
    expect(
      (await call("POST", "/auth/register", { email: "nope", username: "nope1", password: "a-very-long-password" }))
        .status,
    ).toBe(422)
  })

  test("a duplicate email is refused", async () => {
    const { status } = await call("POST", "/auth/register", {
      email: "owner@devpipe.com",
      username: "other",
      password: "a-very-long-password",
    })
    expect(status).toBe(409)
  })

  test("a wrong password says the same thing as an unknown address", async () => {
    const unknown = await call("POST", "/auth/login", { email: "ghost@x.com", password: "whatever-long" })
    const wrong = await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "wrong-password-x" })
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    // Identical, so this cannot be used to discover who has an account.
    expect(unknown.data.error).toBe(wrong.data.error)
  })

  test("an unauthenticated request is refused", async () => {
    expect((await call("GET", "/auth/me")).status).toBe(401)
    expect((await call("GET", "/boxes")).status).toBe(401)
  })

  test("only the owner reaches admin", async () => {
    expect((await call("GET", "/admin/overview", undefined, memberToken)).status).toBe(403)
    expect((await call("GET", "/admin/overview", undefined, ownerToken)).status).toBe(200)
  })

  test("suspending a member ends their sessions immediately", async () => {
    expect((await call("GET", "/auth/me", undefined, memberToken)).status).toBe(200)
    const { status } = await call("PATCH", `/admin/users/${memberId}`, { suspended: true }, ownerToken)
    expect(status).toBe(200)
    // Not "valid until the token expires" — the session rows are gone.
    expect((await call("GET", "/auth/me", undefined, memberToken)).status).toBe(401)
  })

  test("the owner cannot suspend themselves", async () => {
    const me = await call("GET", "/auth/me", undefined, ownerToken)
    const { status } = await call("PATCH", `/admin/users/${me.data.user.id}`, { suspended: true }, ownerToken)
    expect(status).toBe(422)
  })

  test("signing out invalidates the token", async () => {
    const { data } = await call("POST", "/auth/login", {
      email: "owner@devpipe.com",
      password: "a-very-long-password",
    })
    expect((await call("POST", "/auth/logout", undefined, data.token)).status).toBe(200)
    expect((await call("GET", "/auth/me", undefined, data.token)).status).toBe(401)
  })

  test("creating a box without a provider says so instead of failing obscurely", async () => {
    const { status, data } = await call(
      "POST",
      "/boxes",
      { name: "test", tools: ["git"] },
      ownerToken,
    )
    expect(status).toBe(503)
    expect(data.error).toContain("provider")
  })

  test("the wizard catalog is served so web and iOS cannot drift", async () => {
    const { data } = await call("GET", "/boxes/catalog", undefined, ownerToken)
    expect(data.tools.length).toBeGreaterThan(5)
    expect(data.sizes[0].slug).toBe("s-1vcpu-512mb-10gb")
    // Install commands are the server's business and never leave it.
    expect(data.tools[0].install).toBeUndefined()
  })

  test("the waitlist takes an address once and rejects junk", async () => {
    expect((await call("POST", "/waitlist", { email: "a@b.co" })).status).toBe(200)
    expect((await call("POST", "/waitlist", { email: "A@B.co" })).status).toBe(200)
    expect((await call("POST", "/waitlist", { email: "nope" })).status).toBe(422)
    const { data } = await call("GET", "/admin/waitlist", undefined, ownerToken)
    expect(data.length).toBe(1)
  })
})

describe("setup logging", () => {
  beforeEach(() => clearLimits(db))

  let token = ""
  let boxId = 0
  let agent = ""

  test("a box streams its setup output to the control plane", async () => {
    const reg = await call("POST", "/auth/register", {
      email: "logger@example.com",
      username: "logger",
      password: "a-very-long-password",
    })
    token = reg.data.token

    // Stand a box row up directly: provisioning needs a provider, and what is
    // under test is the reporting path, not DigitalOcean.
    agent = "agent-token-for-logging"
    await db.execute({
      text: `INSERT INTO boxes (user_id, name, hostname, status, agent_token)
             VALUES ($1, 'log box', 'logbox.devpipe.com', 'installing', $2)`,
      values: [reg.data.user.id, agent],
    } as any)
    const row = (await db.one({
      text: "SELECT id FROM boxes WHERE hostname = $1",
      values: ["logbox.devpipe.com"],
    } as any)) as any
    boxId = row.id

    // The box authenticates with its own agent token, not a user session.
    const sent = await call(
      "POST",
      "/boxes/callback/log",
      {
        hostname: "logbox.devpipe.com",
        phase: "system",
        text: "── Preparing the system ──\n✓ base packages\n\n",
      },
      agent,
    )
    expect(sent.status).toBe(200)
    // Blank lines are dropped; two real lines remain.
    expect(sent.data.stored).toBe(2)

    const events = await call("GET", `/boxes/${boxId}/events`, undefined, token)
    expect(events.status).toBe(200)
    expect(events.data.events.length).toBe(2)
    expect(events.data.events[1].line).toBe("✓ base packages")
    expect(events.data.events[0].phase).toBe("system")
  })

  test("polling with `after` returns only what is new", async () => {
    const first = await call("GET", `/boxes/${boxId}/events`, undefined, token)
    const cursor = first.data.events.at(-1).id

    await call(
      "POST",
      "/boxes/callback/log",
      { hostname: "logbox.devpipe.com", phase: "daemon", text: "✓ daemon running" },
      agent,
    )

    const next = await call("GET", `/boxes/${boxId}/events?after=${cursor}`, undefined, token)
    expect(next.data.events.length).toBe(1)
    expect(next.data.events[0].line).toBe("✓ daemon running")
  })

  test("the current phase surfaces on the box itself", async () => {
    const boxes = await call("GET", "/boxes", undefined, token)
    expect(boxes.data[0].status_detail).toBe("daemon")
  })

  test("a wrong agent token cannot write to someone's log", async () => {
    const res = await fetchApp(
      new Request("http://test/boxes/callback/log", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
        body: JSON.stringify({ hostname: "logbox.devpipe.com", text: "injected" }),
      }),
    )
    expect(res.status).toBe(403)
  })

  test("another user cannot read the log", async () => {
    const other = await call("POST", "/auth/register", {
      email: "nosy@example.com",
      username: "nosy",
      password: "a-very-long-password",
    })
    const res = await call("GET", `/boxes/${boxId}/events`, undefined, other.data.token)
    expect(res.status).toBe(404)
  })

  test("an oversized report is bounded rather than filling the disk", async () => {
    const huge = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n")
    const out = await call(
      "POST",
      "/boxes/callback/log",
      { hostname: "logbox.devpipe.com", text: huge },
      agent,
    )
    expect(out.data.stored).toBeLessThanOrEqual(400)
  })
})

describe("the signup gate", () => {
      let app: (req: Request) => Promise<Response>
  let ownerToken = ""

  const hit = async (method: string, path: string, body?: unknown, token?: string) => {
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

  beforeAll(async () => {
    await truncateAll()
    app = router(...authRoutes(db), ...adminRoutes(db)) as any
  })

  beforeEach(() => clearLimits(db))

  test("the first account is always allowed — somebody has to claim the instance", async () => {
    const { status, data } = await hit("POST", "/auth/register", {
      email: "first@devpipe.com",
      username: "first",
      password: "a-very-long-password",
    })
    expect(status).toBe(201)
    expect(data.user.is_owner).toBe(true)
    ownerToken = data.token
  })

  test("signups are closed by default, so nobody else can spend the owner's money", async () => {
    const state = await hit("GET", "/auth/state")
    expect(state.data.invite_required).toBe(true)

    const { status, data } = await hit("POST", "/auth/register", {
      email: "stranger@example.com",
      username: "stranger",
      password: "a-very-long-password",
    })
    expect(status).toBe(403)
    expect(data.error).toContain("invite")
  })

  test("a wrong code is refused", async () => {
    const { status } = await hit("POST", "/auth/register", {
      email: "stranger@example.com",
      username: "stranger",
      password: "a-very-long-password",
      invite: "not-a-real-code",
    })
    expect(status).toBe(403)
  })

  test("invite codes come from the CSPRNG, not Math.random", async () => {
    // An invite is the only way past a closed signup gate, and registering
    // leads straight to creating a box that costs the owner money. These used
    // to come from `Math.random`, whose internal state a handful of observed
    // outputs is enough to recover — so one invite handed to the wrong person
    // was a key to the others.
    //
    // Randomness cannot be asserted directly. What can be: the shape is the one
    // `shortId` produces, and a batch has no repeats — a generator that has
    // been swapped for something degenerate fails both.
    const codes = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const made = await hit("POST", "/admin/invites", { note: `batch ${i}` }, ownerToken)
      expect(made.status).toBe(201)
      expect(made.data.code).toMatch(/^[bcdfghjkmnpqrstvwxz23456789]{10}$/)
      codes.add(made.data.code)
    }
    expect(codes.size).toBe(24)
  })

  test("a valid invite lets exactly one person in", async () => {
    const made = await hit("POST", "/admin/invites", { note: "for a friend" }, ownerToken)
    expect(made.status).toBe(201)
    const code = made.data.code

    const first = await hit("POST", "/auth/register", {
      email: "friend@example.com",
      username: "friend",
      password: "a-very-long-password",
      invite: code,
    })
    expect(first.status).toBe(201)
    expect(first.data.user.is_owner).toBe(false)

    // The same code a second time must not work.
    const second = await hit("POST", "/auth/register", {
      email: "gatecrasher@example.com",
      username: "gatecrasher",
      password: "a-very-long-password",
      invite: code,
    })
    expect(second.status).toBe(403)
  })

  test("opening signups removes the requirement", async () => {
    await hit("PATCH", "/admin/settings", { signups_open: "1" }, ownerToken)
    expect((await hit("GET", "/auth/state")).data.invite_required).toBe(false)
    const { status } = await hit("POST", "/auth/register", {
      email: "walkin@example.com",
      username: "walkin",
      password: "a-very-long-password",
    })
    expect(status).toBe(201)
  })

  test("a used invite cannot be revoked, an unused one can", async () => {
    const made = await hit("POST", "/admin/invites", { note: "spare" }, ownerToken)
    const list = await hit("GET", "/admin/invites", undefined, ownerToken)
    const unused = list.data.find((i: any) => i.code === made.data.code)
    const used = list.data.find((i: any) => i.used_at)
    expect((await hit("DELETE", `/admin/invites/${unused.id}`, undefined, ownerToken)).status).toBe(200)
    expect((await hit("DELETE", `/admin/invites/${used.id}`, undefined, ownerToken)).status).toBe(409)
  })
})

/**
 * The limiter and the subscription gate have their own suites, which test them
 * as units. These test that they are actually attached to the routes — the
 * thing a unit test of either cannot see, and the thing that quietly stops
 * being true when a route is rewritten.
 */
describe("the routes are actually guarded", () => {
  beforeEach(() => clearLimits(db))

  test("registration is rate limited by address", async () => {
    for (let i = 0; i < 3; i++) {
      const { status } = await call("POST", "/auth/register", {
        email: `flood${i}@example.com`,
        username: `flood${i}`,
        password: "a-very-long-password",
      })
      expect(status).toBe(201)
    }
    const { status, data } = await call("POST", "/auth/register", {
      email: "flood3@example.com",
      username: "flood3",
      password: "a-very-long-password",
    })
    expect(status).toBe(429)
    expect(data.error).toContain("Too many requests")
  })

  test("a throwaway address cannot claim an account", async () => {
    const { status, data } = await call("POST", "/auth/register", {
      email: "someone@mailinator.com",
      username: "throwaway",
      password: "a-very-long-password",
    })
    expect(status).toBe(422)
    expect(data.error).toContain("Throwaway")
  })

  // What used to be a subscription gate. Nobody is charged for a box any more
  // — the bill lands on whoever installed the instance — so the only thing
  // that refuses one on money grounds is the ceiling they set.
  test("the instance's spending cap refuses a box before a droplet exists", async () => {
    const reg = await call("POST", "/auth/register", {
      email: "payer@example.com",
      username: "payer",
      password: "a-very-long-password",
    })
    expect(reg.status).toBe(201)

    // The provider token has to be present or the create refuses for that
    // reason first.
    await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_not-a-real-token")
    await setSetting(db, SETTING.spendCapCents, "1000")
    await db.execute({
      text: `INSERT INTO spend_ledger (cents, kind, note) VALUES (2000, 'box', 'last month was expensive')`,
      values: [],
    } as any)

    const { status, data } = await call(
      "POST",
      "/boxes",
      { name: "over-cap", size: "s-1vcpu-1gb", tools: ["git"] },
      reg.data.token,
    )
    // 409, not 402: nothing is for sale, so this is a conflict with a limit
    // rather than a missing payment.
    expect(status).toBe(409)
    expect(data.error).toContain("cap")
    // Nothing was written, so nothing is left holding a name or a droplet.
    expect((await db.all(from("boxes").where(q => q("name").equals("over-cap")))).length).toBe(0)

    await setSetting(db, SETTING.spendCapCents, "0")
  })
})
