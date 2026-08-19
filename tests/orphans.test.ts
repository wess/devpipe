import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { findOrphans, orphanSpend } from "../src/boxes/orphans.ts"
import { setSetting, SETTING } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Finding what nothing accounts for.
 *
 * Half of these are about what it finds; the other half are about what it must
 * never touch. A sweep that deletes the wrong thing is worse than the leak it
 * was written to stop — the wildcard record alone is every box and every
 * preview on the instance.
 */

const DOMAIN = "devpipe.test"
const realFetch = globalThis.fetch

type World = { droplets?: any[]; volumes?: any[]; records?: any[] }

const provider = (w: World) => {
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url)
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (url.includes("/droplets")) return reply({ droplets: w.droplets ?? [] })
    if (url.includes("/volumes")) return reply({ volumes: w.volumes ?? [] })
    if (url.includes("/records")) return reply({ domain_records: w.records ?? [] })
    return realFetch(input)
  }) as any
}

const droplet = (id: number, name: string, tags: string[], ip = "10.0.0.1") => ({
  id,
  name,
  status: "active",
  networks: { v4: [{ type: "public", ip_address: ip }] },
  region: { slug: "nyc3" },
  size: { slug: "s-1vcpu-1gb", price_monthly: 6 },
  memory: 1024,
  vcpus: 1,
  tags,
  created_at: "2026-08-01T00:00:00Z",
})

const boxRow = async (hostname: string, providerId: string | null, destroyed = false) => {
  const users = (await db.execute(
    from("users")
      .insert({ email: `${hostname}@x.co`, username: hostname.split(".")[0], password: "x" })
      .returning("id"),
  )) as any[]
  await db.execute(
    from("boxes").insert({
      user_id: users[0].id,
      name: hostname.split(".")[0],
      hostname,
      region: "nyc3",
      size: "s-1vcpu-1gb",
      status: destroyed ? "destroyed" : "ready",
      agent_token: "t",
      manifest: "{}",
      provider_id: providerId,
      ...(destroyed ? { destroyed_at: new Date() } : {}),
    }),
  )
}

beforeEach(async () => {
  await truncateAll()
  await setSetting(db, SETTING.domain, DOMAIN)
  globalThis.fetch = realFetch
})

describe("droplets", () => {
  test("a tagged droplet with no row is an orphan", async () => {
    provider({ droplets: [droplet(1, "alfa-abcde", ["devpipe-box"])] })
    const found = await findOrphans(db, "tok")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: "droplet", id: "1", monthly: 6 })
  })

  test("a tagged droplet a live row points at is not", async () => {
    await boxRow(`alfa-abcde.${DOMAIN}`, "1")
    provider({ droplets: [droplet(1, "alfa-abcde", ["devpipe-box"])] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  /**
   * The control plane, a mail server, somebody's VPN. None of them carries the
   * tag, and a tool whose job is deleting things must not be able to reach
   * them however the database looks.
   */
  test("an untagged droplet is never considered", async () => {
    provider({
      droplets: [
        droplet(2, "devpipe.com-app-and-outbox", ["devpipe", "web"]),
        droplet(3, "openvpnaccessserver", []),
        droplet(4, "pg.wess.dev", ["database"]),
      ],
    })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  /**
   * The bug this whole file exists for. A destroy that failed at the provider
   * but still marked the row destroyed leaves a droplet nothing will ever look
   * for again.
   */
  test("a droplet whose row was marked destroyed is found", async () => {
    await boxRow(`alfa-abcde.${DOMAIN}`, "1", true)
    provider({ droplets: [droplet(1, "alfa-abcde", ["devpipe-box"])] })
    expect(await findOrphans(db, "tok")).toHaveLength(1)
  })
})

describe("volumes", () => {
  test("a dp- volume with no workspace row is an orphan, priced by size", async () => {
    provider({ volumes: [{ id: "v1", name: "dp-1-work-abcd", region: { slug: "nyc3" }, size_gigabytes: 20 }] })
    const found = await findOrphans(db, "tok")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: "volume", id: "v1", monthly: 2 })
  })

  test("a volume a workspace still names is left alone", async () => {
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    await db.execute(
      from("workspaces").insert({ user_id: users[0].id, name: "work", volume_id: "v1", size_gb: 20, region: "nyc3" }),
    )
    provider({ volumes: [{ id: "v1", name: "dp-1-work-abcd", region: { slug: "nyc3" }, size_gigabytes: 20 }] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  /** A workspace outliving its box is the feature, not a leak. */
  test("a workspace whose box is gone is not an orphan", async () => {
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    await db.execute(
      from("workspaces").insert({ user_id: users[0].id, name: "work", volume_id: "v1", size_gb: 20, region: "nyc3" }),
    )
    provider({ volumes: [{ id: "v1", name: "dp-1-work-abcd", region: { slug: "nyc3" }, size_gigabytes: 20 }] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  test("a volume that is not ours is never considered", async () => {
    provider({ volumes: [{ id: "v9", name: "wessdev-volume", region: { slug: "nyc1" }, size_gigabytes: 60 }] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })
})

describe("dns", () => {
  /**
   * The one that would take the whole product down. Every box and every preview
   * is reached through the wildcard, and it points at the control plane rather
   * than at any droplet — so a liveness test alone calls it dead.
   */
  test("the wildcard, the apex and the hand-made records are never orphans", async () => {
    provider({
      droplets: [],
      records: [
        { id: 1, name: "*", data: "203.0.113.9" },
        { id: 2, name: "@", data: "203.0.113.9" },
        { id: 3, name: "www", data: "203.0.113.9" },
        { id: 4, name: "mail", data: "203.0.113.9" },
      ],
    })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  test("a record pointing at an address we no longer hold is found", async () => {
    provider({ droplets: [], records: [{ id: 9, name: "alfa-abcde", data: "198.51.100.7" }] })
    const found = await findOrphans(db, "tok")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: "record", id: "9", monthly: 0 })
    expect(found[0]?.name).toContain(`alfa-abcde.${DOMAIN}`)
  })

  test("a record for a live box is left alone", async () => {
    await boxRow(`alfa-abcde.${DOMAIN}`, "1")
    provider({
      droplets: [droplet(1, "alfa-abcde", ["devpipe-box"], "198.51.100.7")],
      records: [{ id: 9, name: "alfa-abcde", data: "198.51.100.7" }],
    })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })

  /** A sleeping box has no droplet, and its record is rewritten on wake. */
  test("a sleeping box's record is not an orphan", async () => {
    await boxRow(`alfa-abcde.${DOMAIN}`, null)
    provider({ droplets: [], records: [{ id: 9, name: "alfa-abcde", data: "198.51.100.7" }] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })
})

describe("rows naming things that are gone", () => {
  /**
   * The mirror image, and the one that costs nothing and breaks something. A
   * workspace is the promise that the box is the disposable half; a row whose
   * volume has been deleted is still offered when somebody makes a box, gets
   * chosen, and fails at mount time long after the choice was made.
   *
   * Five of these were found in production — volumes deleted in a cleanup
   * without the rows that named them.
   */
  test("a workspace whose volume was deleted is found", async () => {
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    await db.execute(
      from("workspaces").insert({ user_id: users[0].id, name: "keepsake", volume_id: "gone", size_gb: 10, region: "nyc3" }),
    )
    provider({ volumes: [] })
    const found = await findOrphans(db, "tok")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: "workspace", where: "database", name: "keepsake", monthly: 0 })
  })

  test("a workspace whose volume is still there is not", async () => {
    const users = (await db.execute(
      from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
    )) as any[]
    await db.execute(
      from("workspaces").insert({ user_id: users[0].id, name: "keepsake", volume_id: "v1", size_gb: 10, region: "nyc3" }),
    )
    provider({ volumes: [{ id: "v1", name: "dp-1-keepsake-abcd", region: { slug: "nyc3" }, size_gigabytes: 10 }] })
    expect(await findOrphans(db, "tok")).toHaveLength(0)
  })
})

test("the monthly total is the sum, to the cent", () => {
  expect(
    orphanSpend([
      { kind: "droplet", where: "provider", id: "1", name: "a", monthly: 6, why: "" },
      { kind: "volume", where: "provider", id: "v", name: "b", monthly: 2.5, why: "" },
      { kind: "record", where: "provider", id: "9", name: "c", monthly: 0, why: "" },
    ]),
  ).toBe(8.5)
})
