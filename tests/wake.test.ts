import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { ASLEEP } from "../src/boxes/reclaim.ts"
import { setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Waking a box back up.
 *
 * Reclaim has had a suite since it shipped; waking has not, which is the wrong
 * way round — sleeping a machine is only safe if the way back is trustworthy.
 * These cover the refusals, because those are what stand between a wake and a
 * workspace mounted in two places at once.
 */

let fetchApp: (req: Request) => Promise<Response>

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
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

beforeAll(() => {
  fetchApp = router(...authRoutes(db), ...boxRoutes(db, "http://test")) as any
})

let token = ""
let userId = 0

const boxRow = async (over: Record<string, unknown> = {}) => {
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: "dev",
        hostname: "dev.devpipe.com",
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: ASLEEP,
        agent_token: "tok",
        manifest: JSON.stringify({ tools: ["git"], size: "s-1vcpu-1gb", region: "nyc3" }),
        ...over,
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

beforeEach(async () => {
  await truncateAll()
  const { data } = await call("POST", "/auth/register", {
    email: "owner@devpipe.com",
    username: "bosslady",
    password: "a-very-long-password",
  })
  token = data.token
  userId = data.user.id
})

describe("waking a box", () => {
  test("a box that is already awake is refused", async () => {
    // Not an error to paper over: waking a running box would provision a second
    // droplet for a row that already names one, and the first would be left
    // billing with nothing pointing at it.
    const id = await boxRow({ status: "ready" })
    const { status, data } = await call("POST", `/boxes/${id}/wake`, undefined, token)
    expect(status).toBe(409)
    expect(data.error).toContain("already awake")
  })

  test("someone else's box is not found rather than forbidden", async () => {
    const id = await boxRow()
    // Signups close after the owner, so a second account needs the gate open.
    await setSetting(db, SETTING.signupsOpen, "1")
    const other = await call("POST", "/auth/register", {
      email: "other@devpipe.com",
      username: "someoneelse",
      password: "a-very-long-password",
    })
    // 404, not 403: telling a stranger the id exists is telling them what to
    // guess next.
    const { status } = await call("POST", `/boxes/${id}/wake`, undefined, other.data.token)
    expect(status).toBe(404)
  })

  test("a destroyed box cannot be woken", async () => {
    const id = await boxRow({ destroyed_at: new Date() })
    expect((await call("POST", `/boxes/${id}/wake`, undefined, token)).status).toBe(404)
  })

  test("waking needs a provider, and says so rather than half-provisioning", async () => {
    // No DigitalOcean credential is configured in this suite, so the route
    // should stop before it starts creating anything.
    const id = await boxRow()
    const { status, data } = await call("POST", `/boxes/${id}/wake`, undefined, token)
    expect(status).toBe(503)
    expect(data.error).toContain("provider")
    // And the box is still asleep, not stuck in "creating" with no droplet.
    const row = (await db.one(from("boxes").where(q => q("id").equals(id)))) as any
    expect(row.status).toBe(ASLEEP)
  })

  test("signing in is required", async () => {
    const id = await boxRow()
    expect((await call("POST", `/boxes/${id}/wake`)).status).toBe(401)
  })
})
