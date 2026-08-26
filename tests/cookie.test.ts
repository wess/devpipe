import { beforeEach, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { setAppOrigin } from "../src/auth/cookie.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The browser's session, in a cookie it cannot read.
 *
 * It used to be a string in `localStorage`, which made one injected script on
 * this origin an account takeover, with the `Content-Security-Policy` the only
 * thing in the way. That policy is good and it is still there; it was also the
 * entire defence, and one inline `<script>` added by somebody in a hurry would
 * have quietly turned every injection into a full compromise.
 *
 * The interesting half is not the cookie, it is what stops a page *using* one.
 * Boxes and previews live at `*.devpipe.com`, which is the same **site** as the
 * app — so `SameSite` does not separate them and cannot. The origin does.
 */

const APP = "https://app.test"

let fetchApp: (req: Request) => Promise<Response>

const raw = (method: string, path: string, init: RequestInit = {}) =>
  fetchApp(new Request(`http://test${path}`, { method, ...init }))

const call = async (method: string, path: string, init: RequestInit = {}) => {
  const res = await raw(method, path, init)
  return { status: res.status, res, data: (await res.json().catch(() => null)) as any }
}

const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""

beforeEach(async () => {
  await truncateAll()
  setAppOrigin(APP)
  fetchApp = router(...authRoutes(db), ...boxRoutes(db, APP)) as any
  await db.execute({ text: "DELETE FROM rate_limits", values: [] } as any)
})

const register = async () =>
  await call("POST", "/auth/register", {
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({
      email: "owner@devpipe.com",
      username: "bosslady",
      password: "a-very-long-password",
    }),
  })

describe("what signing in hands back", () => {
  test("a cookie no script can read, scoped to this host alone", async () => {
    const { res, status } = await register()
    expect(status).toBe(201)
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("dp_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    // No `Domain`. Host-only, so it is never sent to a box, to a preview, or to
    // anything else under the wildcard — which is most of what makes those
    // hostnames safe to point at somebody else's code.
    expect(cookie.toLowerCase()).not.toContain("domain=")
  })

  test("Secure only where the app is actually served over TLS", async () => {
    setAppOrigin("http://localhost:3001")
    const { res } = await register()
    expect(res.headers.get("set-cookie") ?? "").not.toContain("Secure")
    setAppOrigin(APP)
  })

  test("the token still comes back in the body, for the CLI keychain", async () => {
    // The CLI keeps it somewhere no web page can reach.
    const { data } = await register()
    expect(typeof data.token).toBe("string")
    expect(data.token.length).toBeGreaterThan(20)
  })
})

describe("using the cookie", () => {
  test("it authenticates a request from the app", async () => {
    const registered = await register()
    const { status, data } = await call("GET", "/boxes", {
      headers: { cookie: cookieFrom(registered.res), origin: APP },
    })
    expect(status).toBe(200)
    expect(data).toEqual([])
  })

  test("a page on another origin cannot spend it", async () => {
    // The attack this exists for: a preview serving somebody's half-written
    // application from p-xxx.devpipe.com, which is the same *site* as the app.
    // SameSite lets that request through. The origin check does not.
    const registered = await register()
    const cookie = cookieFrom(registered.res)

    const posted = await call("POST", "/boxes", {
      headers: { cookie, origin: "https://p-abcdef.devpipe.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "theirs" }),
    })
    expect(posted.status).toBe(403)
    expect(posted.data.error).toContain("did not come from this site")
  })

  test("a write with no origin at all is refused", async () => {
    // Every browser sends one on a request that can change something. Nothing
    // legitimate arrives here without it.
    const registered = await register()
    const { status } = await call("POST", "/boxes", {
      headers: { cookie: cookieFrom(registered.res), "content-type": "application/json" },
      body: JSON.stringify({ name: "quiet" }),
    })
    expect(status).toBe(403)
  })

  test("a read with no origin is allowed, because a navigation has none", async () => {
    const registered = await register()
    const { status } = await call("GET", "/boxes", {
      headers: { cookie: cookieFrom(registered.res) },
    })
    expect(status).toBe(200)
  })

  test("a bearer is not origin-checked, because a page cannot forge one", async () => {
    // The asymmetry is the point. A page can make a browser *send* a cookie
    // without being able to read it; a header has to be put there by whoever
    // holds the token, and a page that holds it has already lost elsewhere.
    const registered = await register()
    const { status } = await call("GET", "/boxes", {
      headers: { authorization: `Bearer ${registered.data.token}`, origin: "https://evil.example.com" },
    })
    expect(status).toBe(200)
  })
})

describe("signing out", () => {
  test("ends the session the request actually came in on, and clears the cookie", async () => {
    // Logout used to read the bearer back out of the header to find the row.
    // A browser no longer sends one, and "signed out" that leaves the session
    // alive is the worst possible answer to that button.
    const registered = await register()
    const cookie = cookieFrom(registered.res)

    const out = await call("POST", "/auth/logout", { headers: { cookie, origin: APP } })
    expect(out.status).toBe(200)
    expect(out.res.headers.get("set-cookie") ?? "").toContain("Max-Age=0")

    const after = await call("GET", "/boxes", { headers: { cookie, origin: APP } })
    expect(after.status).toBe(401)
  })

  test("a bearer session is ended by its own logout", async () => {
    const registered = await register()
    const bearer = { authorization: `Bearer ${registered.data.token}` }
    expect((await call("POST", "/auth/logout", { headers: bearer })).status).toBe(200)
    expect((await call("GET", "/boxes", { headers: bearer })).status).toBe(401)
  })
})

describe("what an injected script can still reach", () => {
  test("the cookie is not in the response the app can read", async () => {
    // `Set-Cookie` is stripped from what `fetch` exposes, but the token in the
    // body is not — so a login response is still worth something to an
    // attacker who can trigger one. They need the password to do it, which is
    // the point at which this stops being an XSS problem.
    const { data } = await register()
    expect(JSON.stringify(data)).not.toContain("dp_session")
  })
})
