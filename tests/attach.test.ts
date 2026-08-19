import { beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { terminalRoutes } from "../src/terminals/index.ts"
import { ATTACH, ATTACH_TTL } from "../src/util/boxscope.ts"
import { sha256Hex } from "../src/util/token.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * What the browser is handed to open a terminal.
 *
 * This endpoint answered with `box.agent_token` — the box's whole bearer. That
 * was defensible when the daemon served terminals and nothing else. It now also
 * reads and writes every file on the box over `/v1/fs`, proxies any listening
 * port, forwards any loopback socket, and spawns a shell. The credential grew;
 * what it was being handed to did not.
 *
 * The daemon's half of this is `daemon/tests/scope.rs`, which is where "the
 * scoped token reaches nothing but a pty" is actually proven. This file is the
 * other half: that the box's real credential never leaves the control plane.
 */

const BOX_TOKEN = "box-secret-bearer"

let fetchApp: (req: Request) => Promise<Response>
let boxId: number
let token: string

const call = async (path: string, bearer?: string) => {
  const res = await fetchApp(
    new Request(`http://test${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  )
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

beforeEach(async () => {
  await truncateAll()
  const users = (await db.execute(
    from("users").insert({ email: "a@b.co", username: "alfa", password: "x" }).returning("id"),
  )) as any[]
  const raw = `tok-${Math.random().toString(36).slice(2)}`
  await db.execute(
    from("sessions").insert({
      user_id: users[0].id,
      token_hash: sha256Hex(raw),
      expires_at: new Date(Date.now() + 3_600_000),
    }),
  )
  token = raw

  const boxes = (await db.execute(
    from("boxes")
      .insert({
        user_id: users[0].id,
        name: "one",
        hostname: "box.devpipe.test",
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: "ready",
        agent_token: BOX_TOKEN,
        manifest: "{}",
      })
      .returning("id"),
  )) as any[]
  boxId = boxes[0].id

  fetchApp = router(...terminalRoutes(db)) as any
})

describe("the credential a terminal is opened with", () => {
  /**
   * The regression this whole change exists to prevent. A page that holds the
   * box bearer can read `~/.ssh`, write to `~/.bashrc` and start a shell — all
   * over the same daemon the terminal is on.
   */
  test("is never the box's own bearer", async () => {
    const { status, data } = await call(`/boxes/${boxId}/connection`, token)
    expect(status).toBe(200)
    expect(JSON.stringify(data)).not.toContain(BOX_TOKEN)
  })

  test("is scoped to attaching, and expires", async () => {
    const { data } = await call(`/boxes/${boxId}/connection`, token)
    const [scope, expiry] = String(data.token).split(".")
    expect(scope).toBe(ATTACH)
    expect(Number(expiry)).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(data.expiresIn).toBe(ATTACH_TTL)
  })

  /**
   * Each call mints a fresh one rather than returning a stored value. This is
   * what makes a two-minute lifetime workable: the client asks again on every
   * reconnect, and a token copied out of a log is stale before it is read.
   */
  test("is minted per request", async () => {
    const first = await call(`/boxes/${boxId}/connection`, token)
    await Bun.sleep(1100)
    const second = await call(`/boxes/${boxId}/connection`, token)
    expect(second.data.token).not.toBe(first.data.token)
  })

  test("still points at the box itself, not through the control plane", async () => {
    const { data } = await call(`/boxes/${boxId}/connection`, token)
    expect(data.url).toBe("wss://box.devpipe.test")
  })

  test("is refused without a session", async () => {
    expect((await call(`/boxes/${boxId}/connection`)).status).toBe(401)
  })

  test("is refused for somebody else's box", async () => {
    const others = (await db.execute(
      from("users").insert({ email: "c@d.co", username: "bravo", password: "x" }).returning("id"),
    )) as any[]
    const raw = `tok-${Math.random().toString(36).slice(2)}`
    await db.execute(
      from("sessions").insert({
        user_id: others[0].id,
        token_hash: sha256Hex(raw),
        expires_at: new Date(Date.now() + 3_600_000),
      }),
    )
    expect((await call(`/boxes/${boxId}/connection`, raw)).status).toBe(404)
  })
})
