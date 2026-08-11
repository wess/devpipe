import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { json, parseJson, pipeline, post, router } from "@atlas/server"
import { isDisposableEmail, suspendUser } from "../src/security/abuse.ts"
import { consume, rateLimit, submittedEmail, sweepRateLimits } from "../src/security/ratelimit.ts"
import { securityHeaders } from "../src/security/headers.ts"
import { db, truncateAll } from "./setup.ts"

let fetchApp: (req: Request) => Promise<Response>

const hit = async (path: string, ip: string, body?: unknown) => {
  const res = await fetchApp(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    data: (await res.json().catch(() => null)) as any,
  }
}

beforeAll(async () => {
    await truncateAll()

  const ok = async (c: any) => json(c, 200, { ok: true })

  fetchApp = router(
    post("/t/ping", pipeline(rateLimit({ db, key: "ping", limit: 3, windowSeconds: 60 }))(ok)),
    // A stand-in for sign-in: room to spare on the address so the email bucket
    // is what refuses.
    post(
      "/t/login",
      pipeline(
        parseJson,
        rateLimit({
          db,
          key: "login",
          limit: 100,
          windowSeconds: 60,
          subject: submittedEmail,
          subjectLimit: 2,
        }),
      )(ok),
    ),
    post("/t/brief", pipeline(rateLimit({ db, key: "brief", limit: 1, windowSeconds: 1 }))(ok)),
  ) as any
})

describe("the rate limiter", () => {
  test("allows up to the limit and then refuses", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await hit("/t/ping", "10.0.0.1")).status).toBe(200)
    }
    const over = await hit("/t/ping", "10.0.0.1")
    expect(over.status).toBe(429)
    // The message has to say when, or the only thing left to do is keep trying.
    expect(over.data.error).toContain("Try again in")
    expect(Number(over.retryAfter)).toBeGreaterThan(0)
  })

  test("two addresses do not share a bucket", async () => {
    // 10.0.0.1 is already spent from the test above.
    expect((await hit("/t/ping", "10.0.0.2")).status).toBe(200)
    expect((await hit("/t/ping", "10.0.0.1")).status).toBe(429)
  })

  test("the right-most forwarded address is the one counted", async () => {
    // Caddy appends the peer it saw, so a client that sends its own header gets
    // its value in front of the real one. Counting the left-most would hand out
    // a fresh bucket per request.
    for (let i = 0; i < 3; i++) {
      expect((await hit("/t/ping", `1.1.1.${i}, 10.0.0.3`)).status).toBe(200)
    }
    expect((await hit("/t/ping", "9.9.9.9, 10.0.0.3")).status).toBe(429)
  })

  test("the window rolls over", async () => {
    expect((await hit("/t/brief", "10.0.1.1")).status).toBe(200)
    expect((await hit("/t/brief", "10.0.1.1")).status).toBe(429)
    await new Promise(r => setTimeout(r, 1_100))
    expect((await hit("/t/brief", "10.0.1.1")).status).toBe(200)
  })

  test("an auth route counts the submitted email as well as the address", async () => {
    const email = "target@example.com"
    // Same address, three different accounts: the email buckets are separate,
    // so nothing is refused.
    for (let i = 0; i < 3; i++) {
      expect((await hit("/t/login", "10.0.2.1", { email: `user${i}@example.com` })).status).toBe(200)
    }

    // Same account from three different addresses: the email bucket is not.
    expect((await hit("/t/login", "10.0.3.1", { email })).status).toBe(200)
    expect((await hit("/t/login", "10.0.3.2", { email })).status).toBe(200)
    expect((await hit("/t/login", "10.0.3.3", { email })).status).toBe(429)

    // Case is not a way around it, and somebody else's account is unaffected.
    expect((await hit("/t/login", "10.0.3.4", { email: "TARGET@Example.com" })).status).toBe(429)
    expect((await hit("/t/login", "10.0.3.5", { email: "bystander@example.com" })).status).toBe(200)
  })

  test("counting is per route, so one endpoint cannot spend another's budget", async () => {
    expect((await hit("/t/login", "10.0.0.1", { email: "elsewhere@example.com" })).status).toBe(200)
  })
})

describe("the sweep", () => {
  test("removes expired rows and leaves live ones", async () => {
    const at = Math.floor(Date.now() / 1000)
    await db.execute({
      text: "INSERT INTO rate_limits (bucket, count, window_start) VALUES ($1, $2, $3)",
      values: ["sweep|old", 9, at - 7_200],
    } as any)
    await db.execute({
      text: "INSERT INTO rate_limits (bucket, count, window_start) VALUES ($1, $2, $3)",
      values: ["sweep|fresh", 1, at],
    } as any)

    const removed = await sweepRateLimits(db)
    expect(removed).toBeGreaterThanOrEqual(1)

    const old = await db.one({
      text: "SELECT bucket FROM rate_limits WHERE bucket = $1",
      values: ["sweep|old"],
    } as any)
    const fresh = await db.one({
      text: "SELECT bucket FROM rate_limits WHERE bucket = $1",
      values: ["sweep|fresh"],
    } as any)
    expect(old).toBeNull()
    expect(fresh).not.toBeNull()
  })

  test("a swept bucket starts again from zero rather than staying blocked", async () => {
    const bucket = `direct-${Date.now()}`
    expect((await consume(db, bucket, 1, 60)).ok).toBe(true)
    expect((await consume(db, bucket, 1, 60)).ok).toBe(false)
    await sweepRateLimits(db, 0)
    expect((await consume(db, bucket, 1, 60)).ok).toBe(true)
  })
})

describe("abuse", () => {
  const makeUser = async (email: string, username: string, isOwner = 0) => {
    const rows = (await db.execute({
      text: `INSERT INTO users (email, username, password, is_owner)
             VALUES ($1, $2, 'x', $3) RETURNING id`,
      values: [email, username, isOwner],
    } as any)) as any[]
    return rows[0].id as number
  }

  test("suspending ends every session and condemns every live box", async () => {
    const userId = await makeUser("spammer@example.com", "spammer")
    // A bystander with the same shape of data. Every assertion below has a
    // matching one for this account: a where clause the builder dropped would
    // otherwise look identical to one it applied.
    const otherId = await makeUser("bystander@example.com", "bystander")

    for (const [owner, token] of [
      [userId, "hash-a"],
      [userId, "hash-b"],
      [otherId, "hash-c"],
    ] as const) {
      await db.execute({
        text: "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, '2099-01-01 00:00:00')",
        values: [owner, token],
      } as any)
    }
    await db.execute({
      text: `INSERT INTO boxes (user_id, name, hostname, status)
             VALUES ($1, 'live', 'live.devpipe.com', 'ready')`,
      values: [userId],
    } as any)
    await db.execute({
      text: `INSERT INTO boxes (user_id, name, hostname, status, destroyed_at)
             VALUES ($1, 'gone', 'gone.devpipe.com', 'destroyed', '2020-01-01')`,
      values: [userId],
    } as any)
    await db.execute({
      text: `INSERT INTO boxes (user_id, name, hostname, status)
             VALUES ($1, 'theirs', 'theirs.devpipe.com', 'ready')`,
      values: [otherId],
    } as any)

    const out = await suspendUser(db, userId, "provider abuse report: outbound scanning")
    expect(out.ok).toBe(true)
    expect(out.sessions).toBe(2)
    // The already-destroyed box is not counted or touched.
    expect(out.boxes).toBe(1)

    const left = (await db.all({
      text: "SELECT id FROM sessions WHERE user_id = $1",
      values: [userId],
    } as any)) as any[]
    expect(left.length).toBe(0)

    const live = (await db.one({
      text: "SELECT status, status_detail, destroyed_at FROM boxes WHERE hostname = 'live.devpipe.com'",
      values: [],
    } as any)) as any
    expect(live.status).toBe("pending_destroy")
    expect(live.status_detail).toContain("scanning")
    // Still real to whatever destroys it.
    expect(live.destroyed_at).toBeNull()

    const gone = (await db.one({
      text: "SELECT status FROM boxes WHERE hostname = 'gone.devpipe.com'",
      values: [],
    } as any)) as any
    expect(gone.status).toBe("destroyed")

    const user = (await db.one({
      text: "SELECT suspended_at FROM users WHERE id = $1",
      values: [userId],
    } as any)) as any
    expect(user.suspended_at).not.toBeNull()

    const theirSessions = (await db.all({
      text: "SELECT id FROM sessions WHERE user_id = $1",
      values: [otherId],
    } as any)) as any[]
    expect(theirSessions.length).toBe(1)
    const theirBox = (await db.one({
      text: "SELECT status FROM boxes WHERE hostname = 'theirs.devpipe.com'",
      values: [],
    } as any)) as any
    expect(theirBox.status).toBe("ready")
    const them = (await db.one({
      text: "SELECT suspended_at FROM users WHERE id = $1",
      values: [otherId],
    } as any)) as any
    expect(them.suspended_at).toBeNull()
  })

  test("the audit row names the actor in the column and the subject in the detail", async () => {
    const actorId = await makeUser("owner-acting@example.com", "acting")
    const userId = await makeUser("subject@example.com", "subject")

    await suspendUser(db, userId, "asked for by the owner", actorId)
    const byActor = (await db.one({
      text: "SELECT user_id, detail FROM audit WHERE action = 'user.suspended' AND user_id = $1",
      values: [actorId],
    } as any)) as any
    expect(byActor).not.toBeNull()
    expect(byActor.detail).toContain("subject@example.com")

    // No actor when nothing asked — an automatic response to a complaint.
    const autoId = await makeUser("auto@example.com", "auto")
    await suspendUser(db, autoId, "outbound scanning")
    const automatic = (await db.one({
      text: "SELECT user_id FROM audit WHERE action = 'user.suspended' AND detail LIKE 'auto@example.com%'",
      values: [],
    } as any)) as any
    expect(automatic.user_id).toBeNull()
  })

  test("the owner cannot be suspended", async () => {
    const bossId = await makeUser("boss@example.com", "boss", 1)
    const out = await suspendUser(db, bossId, "mistake")
    expect(out.ok).toBe(false)
    expect(out.error).toContain("owner")

    const user = (await db.one({
      text: "SELECT suspended_at FROM users WHERE id = $1",
      values: [bossId],
    } as any)) as any
    expect(user.suspended_at).toBeNull()
  })

  test("suspending someone who is not there says so instead of throwing", async () => {
    const out = await suspendUser(db, 99_999, "nobody")
    expect(out.ok).toBe(false)
  })

  test("throwaway addresses are recognised, ordinary ones are not", async () => {
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true)
    expect(isDisposableEmail("Someone@MAILINATOR.com")).toBe(true)
    // These providers hand out subdomains as well.
    expect(isDisposableEmail("a@inbox.mailinator.com")).toBe(true)
    expect(isDisposableEmail("a@yopmail.com.")).toBe(true)

    expect(isDisposableEmail("wess@devpipe.com")).toBe(false)
    expect(isDisposableEmail("a@notmailinator.com")).toBe(false)
    // Not a valid address, and not this function's rejection to make.
    expect(isDisposableEmail("mailinator.com")).toBe(false)
  })
})

/**
 * The policy is written in two places that have to agree: `securityHeaders`,
 * which both processes send, and the `header` block in `site/Caddyfile`, which
 * covers what Caddy serves directly. Drift between them is invisible until
 * something is blocked in production that worked locally, or — worse — allowed
 * in production that the code believed it had forbidden.
 */
describe("the content security policy", () => {
  const policy = securityHeaders("devpipe.com")

  const directives = (csp: string) =>
    new Map(
      csp
        .split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const [name, ...values] = part.split(/\s+/)
          return [name, values.sort().join(" ")] as const
        }),
    )

  test("script-src refuses inline scripts", () => {
    // The session token is in localStorage, so an injected script is account
    // takeover. This one token is what stands between the two, and it is the
    // reason the lander's script is an external file.
    const scriptSrc = directives(policy["content-security-policy"]).get("script-src")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    // The terminal emulator is WebAssembly, and this is the narrow form.
    expect(scriptSrc).toContain("'wasm-unsafe-eval'")
  })

  test("a terminal can still reach the box it belongs to", () => {
    const connect = directives(securityHeaders("example.test")["content-security-policy"]).get("connect-src")
    expect(connect).toContain("wss://*.example.test")
    expect(connect).toContain("'self'")
  })

  test("the page cannot be framed", () => {
    expect(directives(policy["content-security-policy"]).get("frame-ancestors")).toBe("'none'")
    expect(policy["x-frame-options"]).toBe("DENY")
  })

  test("the Caddyfile says exactly the same thing", async () => {
    const caddyfile = await Bun.file(`${import.meta.dir}/../site/Caddyfile`).text()
    const line = caddyfile.match(/Content-Security-Policy\s+"([^"]+)"/)
    expect(line, "no Content-Security-Policy in site/Caddyfile").not.toBeNull()

    // Compared as directives rather than as a string: the two are written in a
    // different order, and that difference is not a difference in meaning.
    expect(Object.fromEntries(directives(line![1]))).toEqual(
      Object.fromEntries(directives(policy["content-security-policy"])),
    )
  })
})
