import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { CREDENTIAL, setCredential, setSetting, SETTING } from "../src/settings/index.ts"
import { claimForBox, holderOf, workspaceRoutes } from "../src/workspaces/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Storage that outlives the box.
 *
 * The rules worth testing are the ones a customer discovers by losing work: a
 * workspace is on one box at a time, it cannot cross regions, and deleting it
 * is refused while something is using it. None of those are enforced by
 * DigitalOcean on our behalf — attach a volume to a second droplet and the API
 * simply says no, long after the box has been created and paid for.
 */

const realFetch = globalThis.fetch
let volumes: { id: string; name: string; region: string }[] = []
let deleted: string[] = []
let created: any[] = []

/** Answers the volume endpoints, so a test never reaches DigitalOcean. */
const stubOcean = () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
    const path = url.slice("https://api.digitalocean.com/v2".length)
    const method = String(init.method ?? "GET")

    if (path === "/volumes" && method === "POST") {
      const body = JSON.parse(String(init.body))
      created.push(body)
      // A name already taken is the real API's 422, and it is the case that
      // decides whether two customers can both have a "main".
      if (volumes.some(v => v.name === body.name)) {
        return new Response(JSON.stringify({ message: "already exists" }), { status: 422 })
      }
      const v = { id: `vol-${volumes.length + 1}`, name: body.name, region: body.region }
      volumes.push(v)
      return new Response(
        JSON.stringify({
          volume: { ...v, region: { slug: body.region }, size_gigabytes: body.size_gigabytes, droplet_ids: [] },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )
    }
    if (method === "DELETE" && path.startsWith("/volumes/")) {
      deleted.push(path.slice("/volumes/".length))
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ message: `unstubbed ${method} ${path}` }), { status: 404 })
  }) as any
}

const app = router(...authRoutes(db), ...workspaceRoutes(db)) as any

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

const register = async (email: string, username: string) => {
  const res = await call("POST", "/auth/register", { email, username, password: "a-very-long-password" })
  return { id: res.data?.user?.id as number, token: res.data?.token as string }
}

/** A live box holding a workspace — the lock, written directly. */
const boxOn = async (userId: number, workspaceId: number | null, name = "box-1") => {
  const rows = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name,
        hostname: `${name}.devpipe.com`,
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: "ready",
        workspace_id: workspaceId,
      })
      .returning("id"),
  )) as any[]
  return rows[0].id as number
}

let me: { id: number; token: string }
let other: { id: number; token: string }

beforeEach(async () => {
  await truncateAll()
  volumes = []
  deleted = []
  created = []
  stubOcean()
  await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_test")
  me = await register("me@devpipe.com", "alfa")
  // Signups are invite-only past the owner, and this suite is not about that
  // gate — it needs a second account to prove a workspace is not shared.
  await setSetting(db, SETTING.signupsOpen, "1")
  other = await register("other@devpipe.com", "bravo")
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("creating one", () => {
  test("returns a workspace and asks the provider for a volume", async () => {
    const res = await call("POST", "/workspaces", { name: "main", region: "nyc3", size_gb: 20 }, me.token)
    expect(res.status).toBe(201)
    expect(res.data.name).toBe("main")
    expect(res.data.region).toBe("nyc3")
    expect(res.data.size_gb).toBe(20)
    expect(res.data.attached_to).toBeNull()
    expect(created[0].filesystem_type).toBe("ext4")
    expect(created[0].size_gigabytes).toBe(20)
  })

  test("refuses a region that is not offered", async () => {
    const res = await call("POST", "/workspaces", { name: "main", region: "mars-1" }, me.token)
    expect(res.status).toBe(422)
    expect(volumes).toHaveLength(0)
  })

  test("refuses a second workspace with the same name", async () => {
    await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const again = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    expect(again.status).toBe(409)
  })

  // Volume names are unique per DigitalOcean account, and two customers both
  // calling one "main" is the ordinary case. If the name were the customer's
  // text alone, the second one would get the provider's 422.
  test("two people can both have a 'main'", async () => {
    const mine = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const theirs = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, other.token)
    expect(mine.status).toBe(201)
    expect(theirs.status).toBe(201)
    expect(created[0].name).not.toBe(created[1].name)
  })

  test("a provider failure creates no row", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "no capacity" }), { status: 503 })) as any
    const res = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    expect(res.status).toBe(502)
    stubOcean()
    const list = await call("GET", "/workspaces", undefined, me.token)
    expect(list.data).toHaveLength(0)
  })
})

describe("the lock", () => {
  test("holderOf finds the live box and ignores a destroyed one", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const dead = await boxOn(me.id, ws.data.id, "old")
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(dead))
        .update({ destroyed_at: new Date() }),
    )
    expect(await holderOf(db, ws.data.id)).toBeNull()

    const live = await boxOn(me.id, ws.data.id, "new")
    expect((await holderOf(db, ws.data.id))?.id).toBe(live)
  })

  test("claimForBox allows a free workspace in the same region", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const claim = await claimForBox(db, me.id, ws.data.id, "nyc3")
    expect(claim.ok).toBe(true)
  })

  test("claimForBox refuses one already on a box", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    await boxOn(me.id, ws.data.id, "holder")
    const claim = await claimForBox(db, me.id, ws.data.id, "nyc3")
    expect(claim.ok).toBe(false)
    expect((claim as any).reason).toContain("holder")
  })

  // Block storage is pinned to a region, so this is the one people hit by
  // accident: the workspace is theirs and free, and the box still cannot have it.
  test("claimForBox refuses one in another region", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const claim = await claimForBox(db, me.id, ws.data.id, "sfo3")
    expect(claim.ok).toBe(false)
    expect((claim as any).reason).toMatch(/lives in/)
  })

  test("claimForBox refuses somebody else's", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const claim = await claimForBox(db, other.id, ws.data.id, "nyc3")
    expect(claim.ok).toBe(false)
  })
})

describe("listing and deleting", () => {
  test("lists only your own, and says which box holds one", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    await call("POST", "/workspaces", { name: "theirs", region: "nyc3" }, other.token)
    const box = await boxOn(me.id, ws.data.id)

    const mine = await call("GET", "/workspaces", undefined, me.token)
    expect(mine.data).toHaveLength(1)
    expect(mine.data[0].attached_to).toBe(box)
  })

  test("deleting is refused while a box holds it", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    await boxOn(me.id, ws.data.id, "holder")
    const res = await call("DELETE", `/workspaces/${ws.data.id}`, undefined, me.token)
    expect(res.status).toBe(409)
    expect(deleted).toHaveLength(0)
  })

  test("deleting a free one removes the volume too", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const res = await call("DELETE", `/workspaces/${ws.data.id}`, undefined, me.token)
    expect(res.status).toBe(200)
    expect(deleted).toEqual(["vol-1"])
    const list = await call("GET", "/workspaces", undefined, me.token)
    expect(list.data).toHaveLength(0)
  })

  // A volume the provider still has and we have forgotten is a charge nobody
  // can explain, so the row has to survive a failed delete.
  test("a provider that refuses the delete leaves the workspace alone", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "busy" }), { status: 500 })) as any
    const res = await call("DELETE", `/workspaces/${ws.data.id}`, undefined, me.token)
    expect(res.status).toBe(502)
    stubOcean()
    const list = await call("GET", "/workspaces", undefined, me.token)
    expect(list.data).toHaveLength(1)
  })

  test("you cannot delete somebody else's", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3" }, me.token)
    const res = await call("DELETE", `/workspaces/${ws.data.id}`, undefined, other.token)
    expect(res.status).toBe(404)
    expect(deleted).toHaveLength(0)
  })

  test("signed out gets nothing", async () => {
    const res = await call("GET", "/workspaces")
    expect(res.status).toBe(401)
  })
})

describe("a box that carries one", () => {
  /**
   * The wiring, rather than the pieces.
   *
   * Both halves of this worked in isolation and the feature did nothing: the
   * volume was attached to the droplet, and the droplet was never told, so it
   * came up with an ordinary ~/work and lost everything in it when the box was
   * destroyed. Nothing below asserts on a volume being created or attached —
   * only that the box is told what to mount.
   */
  let created: any = null

  const stubProvider = () => {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(typeof input === "string" ? input : input.url)
      if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
      const path = url.slice("https://api.digitalocean.com/v2".length)
      const method = String(init.method ?? "GET")
      const body = init.body ? JSON.parse(String(init.body)) : null
      const reply = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

      if (path === "/volumes" && method === "POST") {
        return reply(
          { volume: { id: "vol-1", name: body.name, region: { slug: body.region }, size_gigabytes: body.size_gigabytes, droplet_ids: [] } },
          201,
        )
      }
      if (path === "/droplets" && method === "POST") {
        created = body
        return reply({ droplet: { id: 4242, networks: { v4: [] } } }, 202)
      }
      if (path.startsWith("/volumes/") && path.endsWith("/actions") && method === "POST") {
        return reply({ action: { id: 7, status: "completed" } }, 201)
      }
      if (path.includes("/actions/")) return reply({ action: { id: 7, status: "completed" } })
      if (path.startsWith("/droplets/4242")) {
        return reply({ droplet: { id: 4242, status: "active", networks: { v4: [] } } })
      }
      return reply({}, 200)
    }) as any
  }

  test("the box is told which volume to mount", async () => {
    const ws = await call("POST", "/workspaces", { name: "main", region: "nyc3", size_gb: 10 }, me.token)
    created = null
    stubProvider()

    const boxes = router(...boxRoutes(db, "http://test")) as any
    const res = await boxes(
      new Request("http://test/boxes", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${me.token}` },
        body: JSON.stringify({
          name: "carrier",
          region: "nyc3",
          size: "s-1vcpu-1gb",
          tools: ["git"],
          workspace_id: ws.data.id,
        }),
      }),
    )
    expect(res.status).toBe(201)
    expect(created).not.toBeNull()

    const script = String(created.user_data)
    expect(script).toContain("Mounting your workspace")
    // The provider's volume name, which is what the device path is built from.
    expect(script).toContain("/dev/disk/by-id/scsi-0DO_Volume_dp-1-main")
    stubOcean()
  })

  test("a box without one is told nothing about mounting", async () => {
    created = null
    stubProvider()
    const boxes = router(...boxRoutes(db, "http://test")) as any
    const res = await boxes(
      new Request("http://test/boxes", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${me.token}` },
        body: JSON.stringify({ name: "plain", region: "nyc3", size: "s-1vcpu-1gb", tools: ["git"] }),
      }),
    )
    expect(res.status).toBe(201)
    expect(String(created.user_data)).not.toContain("Mounting your workspace")
    stubOcean()
  })
})
