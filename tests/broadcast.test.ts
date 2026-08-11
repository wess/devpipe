import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { broadcastRoutes } from "../src/broadcast/index.ts"
import { claimRoutes } from "../src/claims/index.ts"
import { createRecordingEmailer } from "../src/email/index.ts"
import { db, truncateAll } from "./setup.ts"

const emailer = createRecordingEmailer()
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
  const raw = await res.text()
  let data: any = null
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { status: res.status, data }
}

beforeAll(async () => {
    await truncateAll()
  app = router(
    ...claimRoutes(db),
    ...authRoutes(db),
    ...broadcastRoutes(db, emailer, "https://devpipe.com"),
  ) as any

  const owner = await call("POST", "/auth/register", {
    email: "owner@devpipe.com",
    username: "owner-acct",
    password: "a-very-long-password",
  })
  ownerToken = owner.data.token
  // Signups are invite-only after the first account, so open them for the
  // second registration rather than minting an invite by hand.
  await db.execute(from("settings").insert({ key: "signups_open", value: "1" }))
  const member = await call("POST", "/auth/register", {
    email: "member@example.com",
    username: "member-acct",
    password: "a-very-long-password",
  })
  memberToken = member.data.token

  for (const [username, email] of [
    ["ada", "ada@example.com"],
    ["grace", "grace@example.com"],
  ]) {
    await call("POST", "/claims", { username, email })
  }
})

describe("broadcasts", () => {
  let id = 0

  test("only the owner can reach any of it", async () => {
    for (const [method, path] of [
      ["GET", "/admin/broadcasts"],
      ["GET", "/admin/claims"],
      ["GET", "/admin/claims.csv"],
    ] as const) {
      expect((await call(method, path, undefined, memberToken)).status).toBe(403)
      expect((await call(method, path)).status).toBe(401)
    }
  })

  test("a draft is saved, not sent", async () => {
    const res = await call(
      "POST",
      "/admin/broadcasts",
      { subject: "Devpipe is open", body: "Your box is ready.\n\nSign in and claim it.", audience: "claims" },
      ownerToken,
    )
    expect(res.status).toBe(201)
    id = res.data.id
    expect(emailer.sent.length).toBe(0)
  })

  test("an empty subject or body is refused", async () => {
    expect(
      (await call("POST", "/admin/broadcasts", { subject: "", body: "long enough here" }, ownerToken)).status,
    ).toBe(422)
    expect(
      (await call("POST", "/admin/broadcasts", { subject: "Hi", body: "short" }, ownerToken)).status,
    ).toBe(422)
  })

  test("a preview goes to the owner alone", async () => {
    const res = await call("POST", `/admin/broadcasts/${id}/preview`, undefined, ownerToken)
    expect(res.status).toBe(200)
    expect(emailer.sent.length).toBe(1)
    expect(emailer.sent[0].to).toBe("owner@devpipe.com")
    expect(emailer.sent[0].subject).toStartWith("[preview] ")
  })

  test("sending without typing the subject back does nothing", async () => {
    const before = emailer.sent.length
    const res = await call("POST", `/admin/broadcasts/${id}/send`, { confirm: "wrong" }, ownerToken)
    expect(res.status).toBe(422)
    expect(emailer.sent.length).toBe(before)
  })

  test("a confirmed send reaches every claimed address once", async () => {
    const before = emailer.sent.length
    const res = await call(
      "POST",
      `/admin/broadcasts/${id}/send`,
      { confirm: "Devpipe is open" },
      ownerToken,
    )
    expect(res.status).toBe(200)
    expect(res.data.sent).toBe(2)
    const to = emailer.sent.slice(before).map(m => m.to).sort()
    expect(to).toEqual(["ada@example.com", "grace@example.com"])
  })

  test("a sent broadcast cannot be sent twice or deleted", async () => {
    const before = emailer.sent.length
    expect(
      (await call("POST", `/admin/broadcasts/${id}/send`, { confirm: "Devpipe is open" }, ownerToken))
        .status,
    ).toBe(409)
    expect((await call("DELETE", `/admin/broadcasts/${id}`, undefined, ownerToken)).status).toBe(409)
    expect(emailer.sent.length).toBe(before)
  })

  /**
   * The failure these guard against: a send dies partway — the request outlives
   * the idle timeout, the process restarts — and `sent_at` is still null, so the
   * broadcast looks like an unsent draft. Pressing send again used to mail
   * everybody who had already received it, with no record of who that was.
   */
  describe("resuming a send that did not finish", () => {
    const draft = async (subject: string) =>
      (
        await call(
          "POST",
          "/admin/broadcasts",
          { subject, body: "Long enough to pass the length check.", audience: "claims" },
          ownerToken,
        )
      ).data.id as number

    test("an address already reached is skipped, not mailed twice", async () => {
      const second = await draft("Second wave")
      // Stands in for a send that delivered to Ada and then died.
      await db.execute(from("broadcast_recipients").insert({ broadcast_id: second, email: "ada@example.com" }))

      const before = emailer.sent.length
      const res = await call("POST", `/admin/broadcasts/${second}/send`, { confirm: "Second wave" }, ownerToken)

      expect(res.status).toBe(200)
      expect(res.data.skipped).toBe(1)
      expect(res.data.sent).toBe(1)
      expect(res.data.done).toBe(true)
      expect(emailer.sent.slice(before).map(m => m.to)).toEqual(["grace@example.com"])
    })

    test("every delivery is recorded as it happens", async () => {
      const third = await draft("Third wave")
      await call("POST", `/admin/broadcasts/${third}/send`, { confirm: "Third wave" }, ownerToken)

      const rows = (await db.all(
        from("broadcast_recipients")
          .where(q => q("broadcast_id").equals(third))
          .select("email"),
      )) as any[]
      expect(rows.map(r => r.email).sort()).toEqual(["ada@example.com", "grace@example.com"])
    })

    test("an address that refuses is recorded too, so a resume does not retry it forever", async () => {
      // A provider that rejects one mailbox and accepts the other. Without the
      // refusal being written down, every resume would spend its budget on the
      // dead address and the send would never reach `done`.
      const sent: string[] = []
      const flaky = {
        enabled: false,
        send: async (msg: any) => {
          if (msg.to === "ada@example.com") throw new Error("mailbox refused")
          sent.push(msg.to)
          return { ok: true as const, logged: true }
        },
      }
      const flakyApp = router(...broadcastRoutes(db, flaky as any, "https://devpipe.com")) as any
      const fourth = await draft("Fourth wave")

      const res = await flakyApp(
        new Request(`http://test/admin/broadcasts/${fourth}/send`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify({ confirm: "Fourth wave" }),
        }),
      )
      const data = await res.json()

      expect(data.sent).toBe(1)
      expect(data.failed).toBe(1)
      expect(data.done).toBe(true)
      expect(sent).toEqual(["grace@example.com"])

      const rows = (await db.all(
        from("broadcast_recipients")
          .where(q => q("broadcast_id").equals(fourth))
          .select("email", "delivered"),
      )) as any[]
      expect(rows.length).toBe(2)
      expect(rows.find(r => r.email === "ada@example.com")?.delivered).toBe(0)
    })

    test("a finished send is closed and cannot be run again", async () => {
      const fifth = await draft("Fifth wave")
      expect((await call("POST", `/admin/broadcasts/${fifth}/send`, { confirm: "Fifth wave" }, ownerToken)).data.done)
        .toBe(true)
      expect((await call("POST", `/admin/broadcasts/${fifth}/send`, { confirm: "Fifth wave" }, ownerToken)).status)
        .toBe(409)
    })
  })

  test("the CSV is the claim list, quoted", async () => {
    const res = await call("GET", "/admin/claims.csv", undefined, ownerToken)
    expect(res.status).toBe(200)
    expect(res.data).toContain('"ada","ada@example.com"')
    expect(res.data.split("\n")[0]).toBe("username,email,claimed_at")
  })
})
