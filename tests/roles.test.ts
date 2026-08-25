import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { adminRoutes } from "../src/admin/index.ts"
import { authRoutes } from "../src/auth/index.ts"
import { atLeast, asRole } from "../src/auth/roles.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * One owner, admins under them, everybody else a member.
 *
 * The line worth testing is not who can read what — it is that an admin cannot
 * become the owner, cannot reach a credential, and cannot remove another
 * admin. Before there was a middle role, letting somebody help run the
 * instance meant handing them the token that destroys every box on the
 * account, and every test here is about that gap staying closed.
 */

let app: (req: Request) => Promise<Response>

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

let ownerToken = ""
let adminToken = ""
let memberToken = ""
let adminId = 0
let memberId = 0

const register = async (email: string, username: string) =>
  (await call("POST", "/auth/register", { email, username, password: "a-very-long-password" })).data

beforeAll(() => {
  app = router(...authRoutes(db), ...adminRoutes(db)) as any
})

beforeEach(async () => {
  await truncateAll()
  await db.execute({ text: "DELETE FROM rate_limits", values: [] } as any)

  ownerToken = (await register("boss@example.com", "boss")).token
  await call("PATCH", "/admin/settings", { signups_open: "1" }, ownerToken)

  const a = await register("admin@example.com", "adminly")
  adminToken = a.token
  adminId = a.user.id
  const m = await register("member@example.com", "member")
  memberToken = m.token
  memberId = m.user.id

  await call("PATCH", `/admin/users/${adminId}/role`, { role: "admin" }, ownerToken)
})

describe("the shape of it", () => {
  test("the first account in is the owner and everybody after is a member", async () => {
    const rows = (await db.all(from("users").select("username", "role"))) as any[]
    const by = new Map(rows.map(r => [r.username, r.role]))
    expect(by.get("boss")).toBe("owner")
    expect(by.get("member")).toBe("user")
  })

  test("an unknown role reads as the one that can do the least", () => {
    expect(asRole("wizard")).toBe("user")
    expect(asRole(undefined)).toBe("user")
    expect(asRole("admin")).toBe("admin")
  })

  test("the owner is an admin as well, or nobody could use the instance they own", () => {
    expect(atLeast("owner", "admin")).toBe(true)
    expect(atLeast("admin", "owner")).toBe(false)
    expect(atLeast("user", "admin")).toBe(false)
  })

  // Enforced by a partial unique index rather than by agreement, because
  // "exactly one" survives in application code right up until two requests
  // arrive at once.
  test("the database will not hold a second owner", async () => {
    const write = db.execute(
      from("users")
        .where(q => q("id").equals(memberId))
        .update({ role: "owner" }),
    )
    expect(write).rejects.toThrow()
  })
})

describe("what an admin may do", () => {
  test("see the instance and the people on it", async () => {
    expect((await call("GET", "/admin/overview", undefined, adminToken)).status).toBe(200)
    expect((await call("GET", "/admin/users", undefined, adminToken)).status).toBe(200)
    const audit = await call("GET", "/admin/audit", undefined, adminToken)
    expect(audit.status).toBe(200)
    // The role change in the setup above is in there, named.
    expect(audit.data.some((r: any) => r.action === "user.role")).toBe(true)
  })

  test("invite somebody", async () => {
    const { status, data } = await call("POST", "/admin/invites", { note: "a friend" }, adminToken)
    expect(status).toBe(201)
    expect(data.code).toHaveLength(10)
  })

  test("suspend a member", async () => {
    const { status } = await call("PATCH", `/admin/users/${memberId}`, { suspended: true }, adminToken)
    expect(status).toBe(200)
  })
})

describe("what an admin may not do", () => {
  // The whole reason the middle role exists. An admin deals with an abuse
  // complaint; an admin does not get the token that can destroy every box on
  // the account.
  test("see a credential", async () => {
    const { status, data } = await call("GET", "/admin/settings", undefined, adminToken)
    expect(status).toBe(200)
    expect(data.can_edit).toBe(false)
    // Enough to know a provider is connected, and nothing that identifies it.
    expect(String(data.provider.digitalocean ?? "")).not.toContain("…")
  })

  test("change what anything costs", async () => {
    const { status } = await call("PATCH", "/admin/settings", { billing_margin_pct: "0" }, adminToken)
    expect(status).toBe(403)
  })

  test("replace the provider token", async () => {
    const { status } = await call("POST", "/admin/provider/digitalocean", { token: "dop_v1_x" }, adminToken)
    expect(status).toBe(403)
  })

  test("promote anybody, themselves included", async () => {
    const { status } = await call("PATCH", `/admin/users/${memberId}/role`, { role: "admin" }, adminToken)
    expect(status).toBe(403)
    const mine = await call("PATCH", `/admin/users/${adminId}/role`, { role: "owner" }, adminToken)
    expect(mine.status).toBe(403)
  })

  // Two admins who disagree must not be able to settle it by suspending each
  // other at three in the morning.
  test("suspend another admin", async () => {
    // Its own budget: four registrations from one address in a test file is
    // more than the hourly allowance, and the limiter has its own suite.
    await db.execute({ text: "DELETE FROM rate_limits", values: [] } as any)
    const second = await register("second@example.com", "seconds")
    await call("PATCH", `/admin/users/${second.user.id}/role`, { role: "admin" }, ownerToken)
    const { status, data } = await call("PATCH", `/admin/users/${second.user.id}`, { suspended: true }, adminToken)
    expect(status).toBe(403)
    expect(data.error).toContain("Only the owner")
  })
})

describe("what a member may not do", () => {
  test("anything administrative at all", async () => {
    for (const path of ["/admin/overview", "/admin/users", "/admin/audit", "/admin/invites"]) {
      expect((await call("GET", path, undefined, memberToken)).status).toBe(403)
    }
  })
})

describe("handing the instance over", () => {
  test("promoting somebody to owner demotes the one doing it", async () => {
    const { status, data } = await call("PATCH", `/admin/users/${adminId}/role`, { role: "owner" }, ownerToken)
    expect(status).toBe(200)
    expect(data.transferred).toBe(true)

    const rows = (await db.all(from("users").select("username", "role"))) as any[]
    const by = new Map(rows.map(r => [r.username, r.role]))
    expect(by.get("adminly")).toBe("owner")
    expect(by.get("boss")).toBe("admin")
    // And the handover is real: the old owner can no longer reach what only an
    // owner may.
    expect((await call("POST", "/admin/provider/digitalocean", { token: "dop_v1_x" }, ownerToken)).status).toBe(403)
  })

  test("the owner cannot demote themselves and leave nobody in charge", async () => {
    const me = (await db.one(from("users").where(q => q("username").equals("boss")))) as any
    const { status, data } = await call("PATCH", `/admin/users/${me.id}/role`, { role: "user" }, ownerToken)
    expect(status).toBe(422)
    expect(data.error).toContain("Hand the instance")
  })

  test("a suspended account cannot be handed a role", async () => {
    await call("PATCH", `/admin/users/${memberId}`, { suspended: true }, ownerToken)
    const { status, data } = await call("PATCH", `/admin/users/${memberId}/role`, { role: "admin" }, ownerToken)
    expect(status).toBe(422)
    expect(data.error).toContain("Restore")
  })

  test("a role nobody has heard of is refused", async () => {
    const { status } = await call("PATCH", `/admin/users/${memberId}/role`, { role: "superuser" }, ownerToken)
    expect(status).toBe(422)
  })
})
