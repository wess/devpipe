import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { forgetGpuSizes } from "../src/boxes/gpu.ts"
import { setupRoutes } from "../src/setup/index.ts"
import { CREDENTIAL, getCredential, getSetting, SETTING, setSetting } from "../src/settings/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * First launch.
 *
 * The wizard's job is not collecting settings — the admin screens already did
 * that. It is refusing to accept an answer that will fail hours later somewhere
 * that looks unrelated, and the domain check is the one that earns it: a domain
 * whose DNS is somewhere else builds boxes that come up perfectly, never
 * resolve, and never get a certificate.
 */

const realFetch = globalThis.fetch
let ours: string[] = []

const stub = () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (!url.startsWith("https://api.digitalocean.com/")) return realFetch(input, init)
    const path = url.slice("https://api.digitalocean.com/v2".length)
    const reply = (d: unknown, s = 200) =>
      new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } })

    const auth = String(init.headers?.authorization ?? "")
    if (!auth.includes("dop_v1_good")) return reply({ id: "unauthorized" }, 401)

    if (path.startsWith("/account/keys")) {
      return reply({ ssh_keys: [{ id: 7, name: "laptop" }, { id: 8, name: "desktop" }] })
    }
    if (path.startsWith("/account")) {
      return reply({ account: { email: "boss@example.com", droplet_limit: 25, status: "active" } })
    }
    if (path.startsWith("/domains/")) {
      const name = decodeURIComponent(path.slice("/domains/".length).split("?")[0] as string)
      return ours.includes(name) ? reply({ domain: { name } }) : reply({ id: "not_found" }, 404)
    }
    if (path.startsWith("/domains")) return reply({ domains: ours.map(name => ({ name })) })
    return reply({})
  }) as any
}

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

beforeAll(() => {
  app = router(...authRoutes(db), ...setupRoutes(db)) as any
})

beforeEach(async () => {
  await truncateAll()
  await db.execute({ text: "DELETE FROM rate_limits", values: [] } as any)
  forgetGpuSizes()
  ours = ["devpipe.example"]
  stub()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const claim = async () => {
  ownerToken = (
    await call("POST", "/auth/register", {
      email: "boss@example.com",
      username: "boss",
      password: "a-very-long-password",
    })
  ).data.token
}

describe("before anybody owns it", () => {
  // Readable without a session, because the alternative is a wizard nobody can
  // open on a machine nobody has claimed.
  test("says it is unclaimed, and what is still to do", async () => {
    const { status, data } = await call("GET", "/setup/state")
    expect(status).toBe(200)
    expect(data.claimed).toBe(false)
    expect(data.usable).toBe(false)
    expect(data.steps.find((s: any) => s.id === "owner").done).toBe(false)
  })

  test("and stops answering the moment somebody does", async () => {
    await claim()
    expect((await call("GET", "/setup/state")).status).toBe(401)
    expect((await call("GET", "/setup/state", undefined, ownerToken)).status).toBe(200)
  })
})

describe("connecting a provider", () => {
  beforeEach(claim)

  test("a token that does not work is refused rather than stored", async () => {
    const { status, data } = await call("POST", "/setup/provider", { token: "dop_v1_bad" }, ownerToken)
    expect(status).toBe(422)
    expect(data.error).toContain("rejected")
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBeNull()
  })

  test("one that does is stored, and says whose account it is", async () => {
    const { status, data } = await call("POST", "/setup/provider", { token: "dop_v1_good" }, ownerToken)
    expect(status).toBe(200)
    expect(data.account.email).toBe("boss@example.com")
    expect(data.account.dropletLimit).toBe(25)
    // The domains it holds, so the next step is a choice rather than typing.
    expect(data.domains).toEqual(["devpipe.example"])
  })
})

describe("the domain", () => {
  beforeEach(async () => {
    await claim()
    await call("POST", "/setup/provider", { token: "dop_v1_good" }, ownerToken)
  })

  // The step the whole wizard is worth building for. Every symptom of getting
  // this wrong points somewhere else.
  test("one whose DNS is not on the account is refused, and says how to fix it", async () => {
    const { status, data } = await call("POST", "/setup/domain", { domain: "elsewhere.example" }, ownerToken)
    expect(status).toBe(422)
    expect(data.error).toContain("not on this DigitalOcean account")
    expect(data.error).toContain("nameservers")
    expect(await getSetting(db, SETTING.domain)).not.toBe("elsewhere.example")
  })

  test("one that is, is accepted", async () => {
    const { status } = await call("POST", "/setup/domain", { domain: "devpipe.example" }, ownerToken)
    expect(status).toBe(200)
    expect(await getSetting(db, SETTING.domain)).toBe("devpipe.example")
  })

  test("a pasted URL is understood as the domain inside it", async () => {
    const { status } = await call("POST", "/setup/domain", { domain: "https://devpipe.example/boxes" }, ownerToken)
    expect(status).toBe(200)
    expect(await getSetting(db, SETTING.domain)).toBe("devpipe.example")
  })

  test("something that is not a domain at all is refused before the provider is asked", async () => {
    expect((await call("POST", "/setup/domain", { domain: "not a domain" }, ownerToken)).status).toBe(422)
  })
})

describe("finishing", () => {
  beforeEach(claim)

  test("refuses while anything required is missing, and names it", async () => {
    const { status, data } = await call("POST", "/setup/finish", {}, ownerToken)
    expect(status).toBe(409)
    expect(data.error).toContain("Connect DigitalOcean")
  })

  test("and lets the optional steps stay undone", async () => {
    await call("POST", "/setup/provider", { token: "dop_v1_good" }, ownerToken)
    await call("POST", "/setup/domain", { domain: "devpipe.example" }, ownerToken)

    const before = await call("GET", "/setup/state", undefined, ownerToken)
    expect(before.data.usable).toBe(true)
    expect(before.data.complete).toBe(false)
    // No SSH key and no spend cap, and it still finishes — they are advice,
    // not preconditions.
    expect(before.data.steps.find((s: any) => s.id === "cap").done).toBe(false)

    expect((await call("POST", "/setup/finish", {}, ownerToken)).status).toBe(200)
    const after = await call("GET", "/setup/state", undefined, ownerToken)
    expect(after.data.complete).toBe(true)
  })

  test("the spending cap is taken in cents and read back as one", async () => {
    expect((await call("POST", "/setup/cap", { cents: 5000 }, ownerToken)).status).toBe(200)
    expect(await getSetting(db, SETTING.spendCapCents)).toBe("5000")
    const { data } = await call("GET", "/setup/state", undefined, ownerToken)
    expect(data.steps.find((s: any) => s.id === "cap").done).toBe(true)
  })

  test("SSH keys are offered from the provider account", async () => {
    await call("POST", "/setup/provider", { token: "dop_v1_good" }, ownerToken)
    const { data } = await call("GET", "/setup/ssh-keys", undefined, ownerToken)
    expect(data.keys.map((k: any) => k.name)).toEqual(["laptop", "desktop"])
    await call("POST", "/setup/ssh-keys", { ids: [7] }, ownerToken)
    expect(await getSetting(db, SETTING.sshKeyIds)).toBe("7")
  })
})

describe("who may run it", () => {
  test("nobody but the owner, once the instance is claimed", async () => {
    await claim()
    await setSetting(db, SETTING.signupsOpen, "1")
    memberToken = (
      await call("POST", "/auth/register", {
        email: "member@example.com",
        username: "member",
        password: "a-very-long-password",
      })
    ).data.token

    for (const [method, path] of [
      ["GET", "/setup/state"],
      ["GET", "/setup/secret"],
      ["POST", "/setup/provider"],
      ["POST", "/setup/domain"],
      ["POST", "/setup/cap"],
      ["POST", "/setup/finish"],
    ] as const) {
      const { status } = await call(method, path, method === "POST" ? {} : undefined, memberToken)
      expect(status).toBe(403)
    }
  })

  // Generated, shown once, and never written down here — it is what encrypts
  // the credentials table, so an instance holding a copy would be a lock with
  // the key left inside it.
  test("the secret key is 32 bytes of base64 and is not stored", async () => {
    await claim()
    const { data } = await call("GET", "/setup/secret", undefined, ownerToken)
    expect(Buffer.from(data.key, "base64")).toHaveLength(32)
    const again = await call("GET", "/setup/secret", undefined, ownerToken)
    expect(again.data.key).not.toBe(data.key)
  })
})
