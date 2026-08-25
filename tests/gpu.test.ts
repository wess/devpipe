import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { adminRoutes } from "../src/admin/index.ts"
import { authRoutes } from "../src/auth/index.ts"
import { boxRoutes } from "../src/boxes/index.ts"
import { forgetGpuSizes, forgetRegionNames, gpuImageFor, gpuSizes, isGpuSize, regionNames } from "../src/boxes/gpu.ts"
import { CREDENTIAL, SETTING, setCredential, setSetting } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The GPU catalogue.
 *
 * It is read from the provider rather than written down here, so what these
 * cover is the filtering: which of the things DigitalOcean will sell belong on
 * a menu, and what a size has to carry before somebody can be charged for it.
 */

const realFetch = globalThis.fetch
let calls = 0

const size = (over: Record<string, unknown>) => ({
  slug: "gpu-x",
  description: "Some Card - 1X",
  memory: 32768,
  vcpus: 8,
  disk: 500,
  price_hourly: 1,
  price_monthly: 744,
  regions: ["tor1"],
  available: true,
  gpu_info: { count: 1, model: "nvidia_rtx4000_ada", vram: { amount: 20, unit: "gib" } },
  ...over,
})

const SIZES = [
  size({ slug: "s-1vcpu-1gb", description: "Basic", gpu_info: undefined, price_hourly: 0.00893 }),
  size({ slug: "gpu-4000adax1-20gb", description: "RTX 4000 Ada GPU Droplet - 1X", price_hourly: 0.76 }),
  size({
    slug: "gpu-h100x1-80gb",
    description: "H100 GPU - 1X",
    price_hourly: 4.41,
    regions: ["nyc2", "tor1"],
    gpu_info: { count: 1, model: "nvidia_h100", vram: { amount: 80, unit: "gib" } },
  }),
  size({
    slug: "gpu-h100x8-640gb",
    description: "H100 GPU - 8X",
    price_hourly: 35.28,
    gpu_info: { count: 8, model: "nvidia_h100", vram: { amount: 640, unit: "gib" } },
  }),
  size({
    slug: "gpu-mi300x1-192gb",
    description: "AMD MI300X - 1X",
    price_hourly: 2.59,
    gpu_info: { count: 1, model: "amd_mi300x", vram: { amount: 192, unit: "gib" } },
  }),
  // Reclaimed by the provider with a few minutes' notice.
  size({ slug: "gpu-mi355x1-288gb-spot", description: "AMD MI355X - 1X Spot", regions: ["mem1"] }),
  // On the price list, not for sale to this account anywhere.
  size({ slug: "gpu-b300x1-288gb", description: "NVIDIA B300 - 1X", regions: [] }),
  size({ slug: "gpu-retired-1", description: "Old Card - 1X", available: false }),
]

const stub = () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
    const reply = (d: unknown) =>
      new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } })
    if (url.includes("/sizes")) {
      calls++
      return reply({ sizes: SIZES, links: {} })
    }
    if (url.includes("/regions")) {
      return reply({
        regions: [
          { slug: "tor1", name: "Toronto 1", available: true, features: ["storage"] },
          { slug: "nyc2", name: "New York 2", available: true, features: ["storage"] },
        ],
      })
    }
    return reply({})
  }) as any
}

beforeEach(async () => {
  await truncateAll()
  forgetGpuSizes()
  forgetRegionNames()
  calls = 0
  stub()
  await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_test")
  await setSetting(db, SETTING.gpuEnabled, "1")
})

afterAll(() => {
  globalThis.fetch = realFetch
})

test("a slug says whether it is one", () => {
  expect(isGpuSize("gpu-h100x1-80gb")).toBe(true)
  expect(isGpuSize("s-1vcpu-1gb")).toBe(false)
})

describe("what is offered", () => {
  test("only the GPU sizes that can actually be created", async () => {
    const slugs = (await gpuSizes(db)).map(s => s.slug)
    expect(slugs).toEqual([
      "gpu-4000adax1-20gb",
      "gpu-mi300x1-192gb",
      "gpu-h100x1-80gb",
      "gpu-h100x8-640gb",
    ])
    // A CPU size is not a GPU one; a retired card cannot be bought; a spot
    // machine is reclaimed out from under the box; and an empty region list is
    // "nowhere", not "everywhere".
    expect(slugs).not.toContain("s-1vcpu-1gb")
    expect(slugs).not.toContain("gpu-retired-1")
    expect(slugs).not.toContain("gpu-mi355x1-288gb-spot")
    expect(slugs).not.toContain("gpu-b300x1-288gb")
  })

  test("nothing at all when the instance has GPU switched off", async () => {
    await setSetting(db, SETTING.gpuEnabled, "0")
    expect(await gpuSizes(db)).toHaveLength(0)
  })

  test("nothing at all when there is no provider to ask", async () => {
    await truncateAll()
    await setSetting(db, SETTING.gpuEnabled, "1")
    expect(await gpuSizes(db)).toHaveLength(0)
  })

  // A stale price is one somebody gets charged, so there is no fallback table
  // to go stale — an unreachable provider simply offers nothing.
  test("nothing at all when the provider cannot be reached", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any
    expect(await gpuSizes(db)).toHaveLength(0)
  })

  test("the provider is asked once an hour, not once a wizard", async () => {
    await gpuSizes(db)
    await gpuSizes(db)
    await gpuSizes(db)
    expect(calls).toBe(1)
  })

  // The same cache feeds the spend meter, which must see the provider's own
  // number — there is no other price here, and nobody to mark it up for.
  test("the cache holds the provider's own answer", async () => {
    const card = (await gpuSizes(db)).find(s => s.slug === "gpu-4000adax1-20gb")
    expect(card?.centsPerHour).toBe(76)
    expect(calls).toBe(1)
  })
})

describe("what a size carries", () => {
  test("what DigitalOcean charges, in cents, and nothing on top", async () => {
    const sizes = await gpuSizes(db)
    expect(sizes.find(s => s.slug === "gpu-4000adax1-20gb")?.centsPerHour).toBe(76)
    expect(sizes.find(s => s.slug === "gpu-h100x1-80gb")?.centsPerHour).toBe(441)
  })

  test("a name a person can read", async () => {
    const sizes = await gpuSizes(db)
    expect(sizes.find(s => s.slug === "gpu-4000adax1-20gb")?.label).toBe("RTX 4000 Ada ×1")
    expect(sizes.find(s => s.slug === "gpu-h100x8-640gb")?.label).toBe("H100 ×8")
    expect(sizes.find(s => s.slug === "gpu-mi300x1-192gb")?.label).toBe("AMD MI300X ×1")
  })

  test("the regions it exists in, which is not all of them", async () => {
    const h100 = (await gpuSizes(db)).find(s => s.slug === "gpu-h100x1-80gb")
    expect(h100?.regions).toEqual(["nyc2", "tor1"])
  })
})

// A card the driver cannot see is hardware somebody is paying four dollars an
// hour for and cannot use.
describe("the image it boots", () => {
  test("NVIDIA, AMD and NVLink each get their own", async () => {
    const sizes = await gpuSizes(db)
    const by = (slug: string) => sizes.find(s => s.slug === slug)!
    expect(gpuImageFor(by("gpu-4000adax1-20gb"))).toBe("gpu-h100x1-base")
    expect(gpuImageFor(by("gpu-mi300x1-192gb"))).toBe("gpu-amd-base")
    expect(gpuImageFor(by("gpu-h100x8-640gb"))).toBe("gpu-h100x8-base")
  })
})

test("region names come from the provider, because the cards are in places the catalogue never mentions", async () => {
  expect((await regionNames(db)).nyc2).toBe("New York 2")
})

/**
 * The routes, end to end.
 *
 * The gate is the whole feature. A GPU box that gets created before anybody
 * has paid for it is seventy-six cents an hour of the instance owner's money,
 * and the create path is the only place that can still say no for free.
 */
describe("creating one", () => {
  let app: (req: Request) => Promise<Response>
  let ownerToken = ""
  let memberToken = ""

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

  beforeEach(async () => {
    app = router(...authRoutes(db), ...boxRoutes(db, "http://test"), ...adminRoutes(db)) as any
    await db.execute({ text: "DELETE FROM rate_limits", values: [] } as any)
    ownerToken = (
      await call("POST", "/auth/register", {
        email: "boss@example.com",
        username: "boss",
        password: "a-very-long-password",
      })
    ).data.token
    await call("PATCH", "/admin/settings", { signups_open: "1" }, ownerToken)
    memberToken = (
      await call("POST", "/auth/register", {
        email: "member@example.com",
        username: "member",
        password: "a-very-long-password",
      })
    ).data.token
    // The settings write above went through `setSetting`, which the catalogue
    // reads on every call — but the sizes it caches were fetched before it.
    forgetGpuSizes()
    await setSetting(db, SETTING.gpuEnabled, "1")
    await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_test")
  })

  test("the wizard is told what is on offer, and where", async () => {
    const { data } = await call("GET", "/boxes/catalog", undefined, memberToken)
    expect(data.gpu_sizes.map((g: any) => g.slug)).toContain("gpu-h100x1-80gb")
    // Named from the provider, because the static list has never heard of it.
    expect(data.regions.find((r: any) => r.slug === "nyc2")?.label).toBe("New York 2")
  })

  test("and nothing at all when the instance keeps them off", async () => {
    await setSetting(db, SETTING.gpuEnabled, "0")
    forgetGpuSizes()
    const { data } = await call("GET", "/boxes/catalog", undefined, memberToken)
    expect(data.gpu_sizes).toHaveLength(0)
  })

  // Nobody is charged for a box here — the bill lands on whoever installed
  // this — so the only question is who is trusted to spend four dollars an
  // hour of it. Refused before a droplet exists, which is the last moment
  // saying no is free.
  test("a member cannot start one", async () => {
    const { status, data } = await call("POST", "/boxes", { name: "trainer", size: "gpu-h100x1-80gb" }, memberToken)
    expect(status).toBe(403)
    expect(data.error).toContain("admins")
    expect((await db.all(from("boxes").where(q => q("name").equals("trainer")))).length).toBe(0)
  })

  // Somebody asking for an H100 must not quietly be handed a 512 MB box
  // because a slug was mistyped or a card was retired this morning.
  test("a GPU slug that is not on offer is refused rather than defaulted", async () => {
    const { status, data } = await call("POST", "/boxes", { name: "ghost", size: "gpu-nonesuch-1x" }, memberToken)
    expect(status).toBe(422)
    expect(data.error).toContain("not available")
  })
})
