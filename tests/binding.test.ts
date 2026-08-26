import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { agentClass, sameClient } from "../src/auth/fingerprint.ts"
import { setAppOrigin } from "../src/auth/cookie.ts"
import { sessionRoutes } from "../src/auth/sessions.ts"
import { sha256Hex } from "../src/util/token.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * A session is held by one program for its whole life. A stolen token is
 * almost always presented by a different one.
 */

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
const CHROME_MAC_NEWER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
const DEVPIPE_CLI = "devpipe/0.1.0 (workstation) Darwin/24.6.0"

describe("what a client is called", () => {
  test("the program and the machine, without versions", () => {
    expect(agentClass(CHROME_MAC)).toBe("Chrome/Mac")
    expect(agentClass(DEVPIPE_CLI)).toBe("Devpipe/Mac")
    expect(agentClass("curl/8.7.1")).toBe("curl/")
  })

  /**
   * The property the whole design rests on. A browser updates itself every few
   * weeks, and a rule that noticed would sign its user out every few weeks —
   * which is how a security control gets turned off.
   */
  test("a browser update does not change it", () => {
    expect(agentClass(CHROME_MAC)).toBe(agentClass(CHROME_MAC_NEWER))
  })

  test("but a different program does", () => {
    expect(agentClass(CHROME_MAC)).not.toBe(agentClass("curl/8.7.1"))
    expect(agentClass(CHROME_MAC)).not.toBe(agentClass(DEVPIPE_CLI))
  })

  /** Chrome says "Safari" in its agent, and Edge says "Chrome". */
  test("the ambiguous ones resolve to the right program", () => {
    expect(agentClass("Mozilla/5.0 (Windows NT 10.0) Chrome/141 Safari/537.36 Edg/141")).toBe("Edge/Windows")
    expect(agentClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/18 Safari/604.1")).toBe(
      "Safari/iPhone",
    )
  })

  /**
   * Everything unrecognised hashing to one value would bind every such client
   * together, which is worse than binding none of them.
   */
  test("an agent that says nothing is unbound, not its own class", () => {
    expect(agentClass("")).toBe("")
    expect(agentClass(null)).toBe("")
    expect(sameClient("", "Chrome/Mac")).toBe(true)
  })

  test("the renamed CLI keeps its existing session binding", () => {
    expect(sameClient("dpctl/Mac", "Devpipe/Mac")).toBe(true)
  })
})

describe("a session in use", () => {
  let fetchApp: (req: Request) => Promise<Response>
  let userId: number

  const sessionFor = async (userAgent: string, storedClass?: string) => {
    const raw = `tok-${Math.random().toString(36).slice(2)}`
    await db.execute(
      from("sessions").insert({
        user_id: userId,
        token_hash: sha256Hex(raw),
        user_agent: userAgent,
        ...(storedClass === undefined ? {} : { agent_class: storedClass }),
        expires_at: new Date(Date.now() + 3_600_000),
      }),
    )
    return raw
  }

  const call = (path: string, token: string, userAgent: string) =>
    fetchApp(
      new Request(`http://test${path}`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": userAgent },
      }),
    )

  beforeEach(async () => {
    await truncateAll()
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    userId = users[0].id
    fetchApp = router(...sessionRoutes(db), ...authRoutes(db)) as any
  })

  test("the client that started it is let through", async () => {
    const token = await sessionFor(CHROME_MAC, "Chrome/Mac")
    expect((await call("/sessions", token, CHROME_MAC)).status).toBe(200)
  })

  test("the same client after an update is let through", async () => {
    const token = await sessionFor(CHROME_MAC, "Chrome/Mac")
    expect((await call("/sessions", token, CHROME_MAC_NEWER)).status).toBe(200)
  })

  /** The theft this exists to stop: a cookie lifted and replayed by a script. */
  test("a different client is refused", async () => {
    const token = await sessionFor(CHROME_MAC, "Chrome/Mac")
    const res = await call("/sessions", token, "curl/8.7.1")
    expect(res.status).toBe(401)
    expect((await res.json()).error).toContain("started somewhere else")
  })

  /**
   * Refusing and leaving the row alive means the holder tries again with a
   * better disguise. There is nothing to protect once a token has been seen in
   * the wrong hands.
   */
  test("and the session is ended, not just refused", async () => {
    const token = await sessionFor(CHROME_MAC, "Chrome/Mac")
    await call("/sessions", token, "curl/8.7.1")
    expect((await call("/sessions", token, CHROME_MAC)).status).toBe(401)
  })

  /**
   * A session created before the column existed binds to the agent recorded
   * when it was made — not to whoever presents it next, which would hand the
   * binding to an attacker who got there first.
   */
  test("an older session binds to the client that made it, not the next one", async () => {
    const token = await sessionFor(CHROME_MAC, "")
    expect((await call("/sessions", token, "curl/8.7.1")).status).toBe(401)
  })

  test("and one made by a client that sent no agent stays unbound", async () => {
    const token = await sessionFor("", "")
    expect((await call("/sessions", token, "curl/8.7.1")).status).toBe(200)
  })
})

/**
 * Both of these read the current session from what the request presented. They
 * used to re-derive it from `Authorization`, which a browser stopped sending
 * when the session became a cookie.
 */
describe("the device list", () => {
  let fetchApp: (req: Request) => Promise<Response>
  let userId: number
  let mine: string

  // As a browser sends it: the cookie, and the origin the app is served from.
  // A cookie-authenticated mutation without a matching origin is refused, which
  // is the CSRF defence and is exercised in `tests/cookie.test.ts`.
  const cookieCall = (method: string, path: string, token: string) =>
    fetchApp(
      new Request(`http://test${path}`, {
        method,
        headers: {
          cookie: `dp_session=${token}`,
          origin: "http://test",
          "user-agent": CHROME_MAC,
        },
      }),
    )

  beforeEach(async () => {
    await truncateAll()
    setAppOrigin("http://test")
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    userId = users[0].id
    const make = async (ua: string) => {
      const raw = `tok-${Math.random().toString(36).slice(2)}`
      await db.execute(
        from("sessions").insert({
          user_id: userId,
          token_hash: sha256Hex(raw),
          user_agent: ua,
          agent_class: agentClass(ua),
          expires_at: new Date(Date.now() + 3_600_000),
        }),
      )
      return raw
    }
    mine = await make(CHROME_MAC)
    await make(DEVPIPE_CLI)
    fetchApp = router(...sessionRoutes(db)) as any
  })

  test("says which device is this one, for a cookie request", async () => {
    const rows = (await (await cookieCall("GET", "/sessions", mine)).json()) as any[]
    expect(rows).toHaveLength(2)
    expect(rows.filter(r => r.current)).toHaveLength(1)
  })

  /**
   * The regression that mattered most. With no header to read, the excluded
   * hash was of the empty string, which matches nothing — so "sign out
   * everywhere else" signed you out of here too.
   */
  test("signing out everywhere else keeps this one", async () => {
    expect((await cookieCall("DELETE", "/sessions", mine)).status).toBe(200)
    const left = (await db.all(from("sessions").where(q => q("user_id").equals(userId)))) as any[]
    expect(left).toHaveLength(1)
    expect(left[0]?.token_hash).toBe(sha256Hex(mine))
  })
})
