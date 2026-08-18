import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { ASLEEP } from "../src/boxes/reclaim.ts"
import { holderOf } from "../src/workspaces/index.ts"
import { setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Putting a box down, and getting it back.
 *
 * Reclaim has had a suite since it shipped; waking has not, which is the wrong
 * way round — sleeping a machine is only safe if the way back is trustworthy.
 * These cover the refusals, because those are what stand between a wake and a
 * workspace mounted in two places at once, and between a deliberate sleep and
 * somebody's only copy of their files.
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

/** Somewhere for a box's files to live, so it is allowed to sleep. */
const workspaceRow = async () => {
  const rows = (await db.execute(
    from("workspaces")
      .insert({
        user_id: userId,
        name: "main",
        region: "nyc3",
        size_gb: 10,
        volume_id: "vol-1",
        volume_name: "dp-1-main",
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

describe("putting a box to sleep on purpose", () => {
  /**
   * The rule the whole action rests on. Sleeping releases the droplet, so a box
   * whose files exist only on the droplet loses them — which is the one outcome
   * a reversible action must not have. The sweep has always refused these; a
   * person asking is not a reason to be more permissive.
   */
  test("never a box without a workspace, however much somebody wants to", async () => {
    const id = await boxRow({ status: "ready", provider_id: "1", workspace_id: null })
    const { status, data } = await call("POST", `/boxes/${id}/sleep`, undefined, token)
    expect(status).toBe(409)
    expect(data.error).toContain("lose them")
  })

  test("not one that is still being built", async () => {
    // Cloud-init is still running on it and a callback is still to come. Taking
    // the machine away leaves a row waiting for news from a droplet that has
    // stopped existing.
    const id = await boxRow({ status: "installing", provider_id: "1", workspace_id: await workspaceRow() })
    const { status, data } = await call("POST", `/boxes/${id}/sleep`, undefined, token)
    expect(status).toBe(409)
    expect(data.error).toContain("finish setting up")
  })

  test("not one that is already asleep", async () => {
    const id = await boxRow({ workspace_id: await workspaceRow() })
    const { status, data } = await call("POST", `/boxes/${id}/sleep`, undefined, token)
    expect(status).toBe(409)
    expect(data.error).toContain("already asleep")
  })

  test("someone else's box is not found rather than forbidden", async () => {
    const id = await boxRow({ status: "ready", provider_id: "1", workspace_id: await workspaceRow() })
    await setSetting(db, SETTING.signupsOpen, "1")
    const other = await call("POST", "/auth/register", {
      email: "other@devpipe.com",
      username: "someoneelse",
      password: "a-very-long-password",
    })
    expect((await call("POST", `/boxes/${id}/sleep`, undefined, other.data.token)).status).toBe(404)
  })

  test("a box that will not give its volume back stays awake", async () => {
    // No DigitalOcean credential in this suite, so `sleepBox` cannot detach and
    // returns false. Leaving the box running is the correct outcome: the
    // alternative destroys a droplet with a volume still attached to it.
    const id = await boxRow({ status: "ready", provider_id: "1", workspace_id: await workspaceRow() })
    const { status } = await call("POST", `/boxes/${id}/sleep`, undefined, token)
    expect(status).toBe(502)
    const row = (await db.one(from("boxes").where(q => q("id").equals(id)))) as any
    expect(row.status).toBe("ready")
  })
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

describe("a sleeping box does not hold its own workspace against itself", () => {
  // The bug that made reclaim actively destructive: a slept box keeps its
  // `workspace_id`, so the wake path's "is this workspace free?" check found
  // *itself* and refused with "That workspace is on sleeper" — where `sleeper`
  // was the box asking. Every box reclaim put to sleep could never wake.
  const workspace = async () => {
    const rows = (await db.execute(
      from("workspaces")
        .insert({
          user_id: userId,
          name: "work",
          region: "nyc3",
          size_gb: 1,
          volume_id: "vol-1",
          volume_name: "dp-1-work",
        })
        .returning("id"),
    )) as any[]
    return rows[0].id as number
  }

  test("the box itself is not counted as the holder", async () => {
    const ws = await workspace()
    const id = await boxRow({ workspace_id: ws })
    expect(await holderOf(db, ws)).not.toBeNull()
    // ...but not when it is the one asking.
    expect(await holderOf(db, ws, id)).toBeNull()
  })

  test("another box still is", async () => {
    const ws = await workspace()
    const mine = await boxRow({ workspace_id: ws })
    const theirs = await boxRow({ workspace_id: ws, hostname: "other.devpipe.com", name: "other" })
    // Excluding myself must not excuse a genuine second holder — that is the
    // case block storage will not survive.
    const holder = await holderOf(db, ws, mine)
    expect(holder?.id).toBe(theirs)
  })

  test("waking past the check reaches the provider, rather than a 409", async () => {
    const ws = await workspace()
    const id = await boxRow({ workspace_id: ws })
    const { status, data } = await call("POST", `/boxes/${id}/wake`, undefined, token)
    // 503 (no provider configured in this suite) proves it got past the
    // workspace guard. A 409 would mean it refused itself again.
    expect(status).toBe(503)
    expect(data.error).toContain("provider")
  })
})
