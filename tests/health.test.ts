import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { healthRoutes } from "../src/health/index.ts"
import { db, truncateAll } from "./setup.ts"

const app = router(...healthRoutes(db), ...authRoutes(db)) as (req: Request) => Promise<Response>
const previousSetupToken = process.env.DEVPIPE_SETUP_TOKEN

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app(
    new Request(`http://test${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { response, data: (await response.json()) as any }
}

beforeEach(async () => {
  await truncateAll()
  process.env.DEVPIPE_SETUP_TOKEN = "claim-this-instance"
})

afterAll(() => {
  if (previousSetupToken === undefined) delete process.env.DEVPIPE_SETUP_TOKEN
  else process.env.DEVPIPE_SETUP_TOKEN = previousSetupToken
})

describe("production probes", () => {
  test("liveness does not depend on the database and readiness checks it", async () => {
    expect((await call("GET", "/health")).data).toEqual({ ok: true })
    expect((await call("GET", "/ready")).data).toEqual({ ok: true, database: "ready" })
  })
})

describe("initial owner claim", () => {
  test("advertises and enforces the setup token", async () => {
    const state = await call("GET", "/auth/state")
    expect(state.data.setup_token_required).toBe(true)

    const refused = await call("POST", "/auth/register", {
      email: "owner@example.com",
      username: "captain",
      password: "a-very-long-password",
      setup_token: "wrong",
    })
    expect(refused.response.status).toBe(403)

    const claimed = await call("POST", "/auth/register", {
      email: "owner@example.com",
      username: "captain",
      password: "a-very-long-password",
      setup_token: "claim-this-instance",
    })
    expect(claimed.response.status).toBe(201)
    expect(claimed.data.user.is_owner).toBe(true)
  })
})
