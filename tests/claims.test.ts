import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { claimRoutes } from "../src/claims/index.ts"
import { checkUsername } from "../src/util/username.ts"
import { db, truncateAll } from "./setup.ts"

let app: (req: Request) => Promise<Response>

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app(
    new Request(`http://test${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
    await truncateAll()
  app = router(...claimRoutes(db), ...authRoutes(db)) as any
})

describe("claiming a username", () => {
  test("a name is claimed once and then taken", async () => {
    expect((await call("POST", "/claims", { username: "ada", email: "ada@example.com" })).status).toBe(201)
    const again = await call("POST", "/claims", { username: "ada", email: "someone@else.com" })
    expect(again.status).toBe(409)
  })

  test("one name per address", async () => {
    const second = await call("POST", "/claims", { username: "adalovelace", email: "ada@example.com" })
    expect(second.status).toBe(409)
    expect(second.data.error).toContain("@ada")
  })

  test("availability reflects claims without saying why", async () => {
    expect((await call("GET", "/claims/check?username=ada")).data.available).toBe(false)
    expect((await call("GET", "/claims/check?username=grace")).data.available).toBe(true)
    // Reserved and held names read exactly like each other — otherwise this
    // endpoint maps which names somebody thought worth holding back.
    const reserved = await call("GET", "/claims/check?username=admin")
    const held = await call("GET", "/claims/check?username=wess")
    expect(reserved.data.available).toBe(false)
    expect(held.data.available).toBe(false)
    expect(held.data.reason).toBe(reserved.data.reason)
    expect(held.data.status).toBe(reserved.data.status)
  })

  test("status separates taken from unavailable, and matches the reason", async () => {
    // The signup form offers "if you claimed it, use the same email" only for
    // taken names. A reserved name never had a claim to honour, so telling
    // someone to try again with another address would be a dead end.
    const cases = [
      ["ada", "taken", false],
      ["grace", "free", true],
      ["admin", "unavailable", false],
      ["wess", "unavailable", false],
      ["ab", "unavailable", false],
      ["", "unavailable", false],
    ] as const
    for (const [username, status, available] of cases) {
      const res = await call("GET", `/claims/check?username=${username}`)
      expect(res.data.status, `${username || "(empty)"} status`).toBe(status)
      expect(res.data.available, `${username || "(empty)"} available`).toBe(available)
    }
  })

  test("names have to survive being a hostname", async () => {
    for (const bad of ["ab", "-nope", "nope-", "Has Caps", "under_score", "a".repeat(40)]) {
      expect(checkUsername(bad).ok, `${bad} should be refused`).toBe(false)
    }
    for (const good of ["ada", "grace-h", "x99"]) {
      expect(checkUsername(good).ok, `${good} should be allowed`).toBe(true)
    }
  })

  test("wess is held for one address and refused to everyone else", () => {
    expect(checkUsername("wess", "wess@devpipe.com").ok).toBe(true)
    expect(checkUsername("wess", "someone@else.com").ok).toBe(false)
    expect(checkUsername("wess").ok).toBe(false)
  })

  test("a claim reserves the name against registration by anyone else", async () => {
    // First account would otherwise be the owner and skip the invite gate, so
    // this is the sharpest version of the test: even the first registration
    // cannot take a name somebody claimed.
    const stolen = await call("POST", "/auth/register", {
      email: "thief@example.com",
      username: "ada",
      password: "a-very-long-password",
    })
    expect(stolen.status).toBe(409)

    const rightful = await call("POST", "/auth/register", {
      email: "ada@example.com",
      username: "ada",
      password: "a-very-long-password",
    })
    expect(rightful.status).toBe(201)
  })
})
