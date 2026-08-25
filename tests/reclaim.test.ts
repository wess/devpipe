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
let attachedDroplet = 0

const stubOcean = () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
    const path = url.slice("https://api.digitalocean.com/v2".length)
    const method = String(init.method ?? "GET")
    const reply = (d: unknown, s = 200) =>
      new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } })

    if (path === "/volumes/vol-1" && method === "GET") {
      return reply({
        volume: {
          id: "vol-1",
          name: "dp-1-main",
          region: { slug: "nyc3" },
          size_gigabytes: 10,
          droplet_ids: attachedDroplet ? [attachedDroplet] : [],
        },
      })
    }
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
const boxAged = async (
  hours: number,
  opts: { workspace?: boolean; status?: string; name?: string; size?: string } = {},
) => {
  attachedDroplet = 1000 + hours
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: opts.name ?? `box-${hours}`,
        hostname: `${opts.name ?? `box-${hours}`}.devpipe.com`,
        region: "nyc3",
        size: opts.size ?? "s-1vcpu-1gb",
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
  attachedDroplet = 0
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

  /**
   * A share names a session id on a daemon that is about to stop existing, and
   * waking builds a new machine with an empty session list. Left live, the link
   * opens a socket that connects to nothing, forever, and a guest cannot tell
   * that from a slow box.
   *
   * A preview names a *port*, which is the same port when the box comes back —
   * so revoking those would mean re-sending every link after every sweep for a
   * URL that would have kept working.
   */
  test("closes the links to its terminals, and keeps the ones to its ports", async () => {
    const id = await boxAged(500)
    await db.execute(
      from("shares").insert({
        user_id: userId,
        box_id: id,
        session_id: "s1",
        token_hash: "hash",
        mode: "watch",
      }),
    )
    await db.execute(
      from("previews").insert({ user_id: userId, box_id: id, port: 3000, slug: "p-abcdefghij" }),
    )

    await reclaimIdle(db)

    const share = (await db.one(from("shares").where(q => q("box_id").equals(id)))) as any
    const preview = (await db.one(from("previews").where(q => q("box_id").equals(id)))) as any
    expect(share.revoked_at).not.toBeNull()
    expect(preview.revoked_at).toBeNull()
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

/**
 * Whose money is at stake.
 *
 * Not a judgement about who matters. The owner's idle box costs the owner and
 * they can see it; somebody else's experiment costs the owner too and they
 * cannot, which is why it is the one that sleeps sooner.
 */
describe("somebody else's box, and the owner's own", () => {
  /** Hands a box to the person who owns the instance. */
  const toOwner = async (boxId: number) => {
    const rows = (await db.execute(
      from("users")
        .insert({ email: "boss@b.co", username: "boss", password: "x", role: "owner" })
        .returning("id"),
    )) as any[]
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ user_id: rows[0].id }),
    )
  }

  test("somebody else's sleeps on the shorter window", async () => {
    await setSetting(db, SETTING.idleHours, "24")
    await setSetting(db, SETTING.freeIdleHours, "1")
    await boxAged(3, { name: "trial" })
    const idle = await idleBoxes(db, 24, 1)
    // Three hours idle: past the short hour, nowhere near the long day.
    expect(idle).toHaveLength(1)
    expect(idle[0]?.name).toBe("trial")
  })

  test("the owner's keeps the longer one", async () => {
    await setSetting(db, SETTING.idleHours, "24")
    await setSetting(db, SETTING.freeIdleHours, "1")
    const id = await boxAged(3, { name: "theirs" })
    await toOwner(id)
    expect(await idleBoxes(db, 24, 1)).toHaveLength(0)
  })

  test("the short window alone still works when the long one is off", async () => {
    await setSetting(db, SETTING.idleHours, "0")
    await setSetting(db, SETTING.freeIdleHours, "2")
    await boxAged(5)
    expect(await reclaimIdle(db)).toHaveLength(1)
  })
})

/**
 * The one window with no off switch.
 *
 * An idle CPU box is four dollars a month of somebody's patience. An idle H100
 * is four dollars an hour, and the box that ran a job on Friday and was
 * forgotten is the ordinary case — so the setting that turns idle reclaim off
 * for everything else does not reach these.
 */
describe("boxes billed by the hour", () => {
  const GPU = "gpu-4000adax1-20gb"

  test("slept even with idle reclaim switched off entirely", async () => {
    await setSetting(db, SETTING.idleHours, "0")
    await setSetting(db, SETTING.freeIdleHours, "0")
    await boxAged(3, { name: "card", size: GPU })
    const slept = await reclaimIdle(db)
    expect(slept.map(b => b.name)).toEqual(["card"])
    expect(destroyed).toHaveLength(1)
  })

  test("and the hours are the GPU ones, not the instance's", async () => {
    await setSetting(db, SETTING.idleHours, "48")
    await setSetting(db, SETTING.gpuIdleHours, "6")
    const recent = await boxAged(3, { name: "recent", size: GPU })
    expect(await idleBoxes(db, 48, 0, 6)).toHaveLength(0)
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(recent))
        .update({ destroyed_at: new Date() }),
    )
    await boxAged(8, { name: "forgotten", size: GPU, workspace: true })
    expect((await idleBoxes(db, 48, 0, 6)).map(b => b.name)).toEqual(["forgotten"])
  })

  // The rule the whole feature rests on applies here too: a box holding the
  // only copy of somebody's work is never taken away, whatever it costs.
  test("still never one without a workspace", async () => {
    await setSetting(db, SETTING.idleHours, "0")
    await boxAged(500, { workspace: false, size: GPU })
    expect(await reclaimIdle(db)).toHaveLength(0)
    expect(destroyed).toHaveLength(0)
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

  // The only thing here that destroys data. The person who installed the
  // instance is not somebody whose files get tidied up on a timer.
  test("never the owner's own box", async () => {
    const id = await asleep(90)
    const rows = (await db.execute(
      from("users")
        .insert({ email: "boss@b.co", username: "boss", password: "x", role: "owner" })
        .returning("id"),
    )) as any[]
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(id))
        .update({ user_id: rows[0].id }),
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
