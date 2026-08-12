import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { ASLEEP, expireDormant, idleBoxes, reclaimIdle, setLiveSessions } from "../src/boxes/reclaim.ts"
import { CREDENTIAL, setCredential, setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Giving back boxes nobody is using.
 *
 * Everything here is about refusing to reclaim. The saving is easy; the reason
 * this is safe to run unattended at all is the set of boxes it will not touch,
 * and those are what the tests are for.
 */

const realFetch = globalThis.fetch
let destroyed: number[] = []
let detached: string[] = []

const stubOcean = () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
    const path = url.slice("https://api.digitalocean.com/v2".length)
    const method = String(init.method ?? "GET")
    const reply = (d: unknown, s = 200) =>
      new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } })

    if (path.startsWith("/volumes/") && path.endsWith("/actions") && method === "POST") {
      detached.push(path.split("/")[2] as string)
      return reply({ action: { id: 1, status: "completed" } }, 201)
    }
    if (path.includes("/actions/")) return reply({ action: { id: 1, status: "completed" } })
    if (path.startsWith("/droplets/") && method === "DELETE") {
      destroyed.push(Number(path.split("/")[2]))
      return new Response(null, { status: 204 })
    }
    return reply({}, 200)
  }) as any
}

let userId = 0
let workspaceId = 0

/** A box that has been sitting unused for `hours`. */
const boxAged = async (hours: number, opts: { workspace?: boolean; status?: string; name?: string } = {}) => {
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: opts.name ?? `box-${hours}`,
        hostname: `${opts.name ?? `box-${hours}`}.devpipe.com`,
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: opts.status ?? "ready",
        provider_id: String(1000 + hours),
        agent_token: "tok",
        manifest: JSON.stringify({ tools: ["git"], size: "s-1vcpu-1gb", region: "nyc3" }),
        workspace_id: opts.workspace === false ? null : workspaceId,
        last_active_at: new Date(Date.now() - hours * 3_600_000),
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

beforeEach(async () => {
  await truncateAll()
  destroyed = []
  detached = []
  stubOcean()
  setLiveSessions(async () => [])
  await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_test")
  await setSetting(db, SETTING.idleHours, "6")

  const users = (await db.execute(
    from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
  )) as any[]
  userId = users[0].id
  const ws = (await db.execute(
    from("workspaces")
      .insert({ user_id: userId, name: "main", region: "nyc3", size_gb: 10, volume_id: "vol-1", volume_name: "dp-1-main" })
      .returning("id"),
  )) as any[]
  workspaceId = ws[0].id
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("what it will not touch", () => {
  // The rule the whole feature rests on. A box without a workspace holds the
  // only copy of whatever is on it.
  test("never a box without a workspace, however idle", async () => {
    await boxAged(500, { workspace: false })
    expect(await idleBoxes(db, 6)).toHaveLength(0)
    expect(await reclaimIdle(db)).toHaveLength(0)
    expect(destroyed).toHaveLength(0)
  })

  test("not a box used recently", async () => {
    await boxAged(1)
    expect(await idleBoxes(db, 6)).toHaveLength(0)
  })

  // An agent working through a long task with nobody watching is still work.
  test("not a box with a live session, however long since a human looked", async () => {
    await boxAged(500)
    setLiveSessions(async () => [{ id: "s1" }])
    expect(await idleBoxes(db, 6)).toHaveLength(0)
  })

  // A daemon that cannot be reached is a network problem, not evidence of
  // idleness — and reclaiming on that basis takes a machine somebody is using.
  test("not a box that failed to answer", async () => {
    await boxAged(500)
    setLiveSessions(async () => {
      throw new Error("unreachable")
    })
    expect(await idleBoxes(db, 6)).toHaveLength(0)
  })

  test("not a box that is still being built", async () => {
    await boxAged(500, { status: "installing" })
    expect(await idleBoxes(db, 6)).toHaveLength(0)
  })

  test("not one already asleep", async () => {
    await boxAged(500, { status: ASLEEP })
    expect(await idleBoxes(db, 6)).toHaveLength(0)
  })

  // Off unless somebody sets the hours. An instance that has not been told what
  // idle means must not start handing machines back because a default said so.
  test("nothing at all when the setting is off", async () => {
    await boxAged(500)
    await setSetting(db, SETTING.idleHours, "0")
    expect(await reclaimIdle(db)).toHaveLength(0)
    expect(destroyed).toHaveLength(0)
  })
})

describe("what it does reclaim", () => {
  test("an idle box with a workspace and no sessions", async () => {
    const id = await boxAged(500)
    const idle = await idleBoxes(db, 6)
    expect(idle).toHaveLength(1)
    expect(idle[0]?.id).toBe(id)
  })

  test("releases the droplet and keeps everything else", async () => {
    const id = await boxAged(500)
    const slept = await reclaimIdle(db)
    expect(slept).toHaveLength(1)
    expect(destroyed).toEqual([1500])

    const row = (await db.one(from("boxes").where(q => q("id").equals(id)))) as any
    expect(row.status).toBe(ASLEEP)
    // The row, the name, the tools and the workspace all survive — that is
    // what makes this sleeping rather than destroying.
    expect(row.destroyed_at).toBeNull()
    expect(row.workspace_id).toBe(workspaceId)
    expect(row.provider_id).toBeNull()
    expect(JSON.parse(row.manifest).tools).toEqual(["git"])
    expect(row.status_detail).toContain("workspace")
  })

  // A volume still attached to a droplet that no longer exists is not freed by
  // the droplet going away, and cannot be attached anywhere else.
  test("detaches the workspace before releasing the machine", async () => {
    await boxAged(500)
    await reclaimIdle(db)
    expect(detached).toEqual(["vol-1"])
  })

  test("leaves the box awake if the workspace will not detach", async () => {
    await boxAged(500)
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input)
      if (url.includes("/volumes/")) return new Response(JSON.stringify({ message: "busy" }), { status: 500 })
      return realFetch(input, init)
    }) as any
    expect(await reclaimIdle(db)).toHaveLength(0)
    expect(destroyed).toHaveLength(0)
    stubOcean()
  })
})

describe("boxes nobody is paying for", () => {
  /** A subscription covering a box is what makes it "paid" here. */
  const cover = async (boxId: number) => {
    await db.execute(
      from("subscriptions").insert({
        user_id: userId,
        box_id: boxId,
        size: "s-1vcpu-1gb",
        status: "active",
        stripe_subscription_id: `sub_${boxId}`,
      }),
    )
  }

  test("an unpaid box sleeps on the shorter free window", async () => {
    await setSetting(db, SETTING.idleHours, "24")
    await setSetting(db, SETTING.freeIdleHours, "1")
    await boxAged(3, { name: "trial" })
    const idle = await idleBoxes(db, 24, 1)
    // Three hours idle: past the free hour, nowhere near the paid day.
    expect(idle).toHaveLength(1)
    expect(idle[0]?.name).toBe("trial")
  })

  test("a paid box keeps the longer window", async () => {
    await setSetting(db, SETTING.idleHours, "24")
    await setSetting(db, SETTING.freeIdleHours, "1")
    const id = await boxAged(3, { name: "paid" })
    await cover(id)
    expect(await idleBoxes(db, 24, 1)).toHaveLength(0)
  })

  test("free hours alone still work when the paid window is off", async () => {
    await setSetting(db, SETTING.idleHours, "0")
    await setSetting(db, SETTING.freeIdleHours, "2")
    await boxAged(5)
    expect(await reclaimIdle(db)).toHaveLength(1)
  })
})

describe("trials nobody came back to", () => {
  const asleep = async (days: number, name = "abandoned") => {
    const id = await boxAged(days * 24, { name })
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(id))
        .update({ status: ASLEEP }),
    )
    return id
  }

  test("nothing happens unless a number of days is set", async () => {
    await asleep(90)
    await setSetting(db, SETTING.dormantDays, "0")
    expect(await expireDormant(db)).toBe(0)
    const ws = (await db.one(from("workspaces").where(q => q("id").equals(workspaceId)))) as any
    expect(ws.deleted_at).toBeNull()
  })

  test("an abandoned trial and its workspace are removed", async () => {
    const id = await asleep(90)
    await setSetting(db, SETTING.dormantDays, "30")
    expect(await expireDormant(db)).toBe(1)

    const box = (await db.one(from("boxes").where(q => q("id").equals(id)))) as any
    expect(box.destroyed_at).not.toBeNull()
    const ws = (await db.one(from("workspaces").where(q => q("id").equals(workspaceId)))) as any
    expect(ws.deleted_at).not.toBeNull()
  })

  test("not one that has not been asleep long enough", async () => {
    await asleep(5)
    await setSetting(db, SETTING.dormantDays, "30")
    expect(await expireDormant(db)).toBe(0)
  })

  // Somebody's files are not something to tidy up on a timer because they
  // stopped using a box for a month.
  test("never a box somebody is paying for", async () => {
    const id = await asleep(90)
    await db.execute(
      from("subscriptions").insert({
        user_id: userId,
        box_id: id,
        size: "s-1vcpu-1gb",
        status: "active",
        stripe_subscription_id: "sub_paid",
      }),
    )
    await setSetting(db, SETTING.dormantDays, "30")
    expect(await expireDormant(db)).toBe(0)
  })

  test("an awake box is never expired, however old", async () => {
    await boxAged(24 * 90, { name: "busy" })
    await setSetting(db, SETTING.dormantDays, "30")
    expect(await expireDormant(db)).toBe(0)
  })
})
