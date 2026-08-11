import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { passwordRoutes } from "../src/auth/password.ts"
import { sessionRoutes } from "../src/auth/sessions.ts"
import { createRecordingEmailer } from "../src/email/index.ts"
import { userRoutes } from "../src/users/index.ts"
import { db, truncateAll } from "./setup.ts"

const emailer = createRecordingEmailer()
let fetchApp: (req: Request) => Promise<Response>

const OLD_PASSWORD = "the-original-password"
const NEW_PASSWORD = "a-brand-new-password"

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetchApp(
    new Request(`http://test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, data: data as any }
}

/** The link the user would click, read back out of the email that was recorded. */
const lastResetToken = () => {
  const last = emailer.sent.at(-1)
  const match = /http:\/\/test\/reset\?token=([^\s"<]+)/.exec(last?.text ?? "")
  return match ? decodeURIComponent(match[1]) : ""
}

const forgot = (email: string) => call("POST", "/auth/forgot", { email })

beforeAll(async () => {
    await truncateAll()
  fetchApp = router(
    ...authRoutes(db),
    ...passwordRoutes(db, { emailer, appUrl: "http://test" }),
    ...sessionRoutes(db),
    ...userRoutes(db),
  ) as any

  await call("POST", "/auth/register", {
    email: "owner@devpipe.com",
    username: "bosslady",
    password: OLD_PASSWORD,
  })
})

// `/auth/forgot` allows three an hour per address *and* per address asked
// about, which one suite naming one mailbox would spend in the third test. The
// limits themselves are covered in tests/security.test.ts.
beforeEach(() => db.execute({ text: "DELETE FROM rate_limits", values: [] } as any))

describe("password reset", () => {
  test("the emailer records rather than sends", async () => {
    expect(emailer.enabled).toBe(false)
    const before = emailer.sent.length
    await forgot("owner@devpipe.com")
    expect(emailer.sent.length).toBe(before + 1)
    const mail = emailer.sent.at(-1)!
    expect(mail.to).toBe("owner@devpipe.com")
    expect(mail.subject).toBe("Reset your Devpipe password")
    expect(lastResetToken().length).toBeGreaterThan(20)
  })

  test("an unknown address answers exactly as a known one does", async () => {
    const before = emailer.sent.length
    const known = await forgot("owner@devpipe.com")
    const unknown = await forgot("ghost@example.com")
    expect(unknown.status).toBe(known.status)
    expect(unknown.data).toEqual(known.data)
    // One address exists, so exactly one email: the identical response is not
    // because nothing happened on the known path.
    expect(emailer.sent.length).toBe(before + 1)
  })

  test("a reset sets the password and ends every session", async () => {
    const signedIn = await call("POST", "/auth/login", {
      email: "owner@devpipe.com",
      password: OLD_PASSWORD,
    })
    expect(signedIn.status).toBe(200)
    const stale = signedIn.data.token
    expect((await call("GET", "/auth/me", undefined, stale)).status).toBe(200)

    await forgot("owner@devpipe.com")
    const reset = await call("POST", "/auth/reset", { token: lastResetToken(), password: NEW_PASSWORD })
    expect(reset.status).toBe(200)

    // Not "valid until it expires" — the session rows are gone.
    expect((await call("GET", "/auth/me", undefined, stale)).status).toBe(401)
    expect((await call("GET", "/sessions", undefined, stale)).status).toBe(401)

    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: OLD_PASSWORD })).status,
    ).toBe(401)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: NEW_PASSWORD })).status,
    ).toBe(200)
  })

  test("a token cannot be used twice", async () => {
    await forgot("owner@devpipe.com")
    const token = lastResetToken()
    expect((await call("POST", "/auth/reset", { token, password: "first-use-password" })).status).toBe(200)
    expect((await call("POST", "/auth/reset", { token, password: "second-use-password" })).status).toBe(400)
    // The second attempt did not quietly take effect either.
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "second-use-password" }))
        .status,
    ).toBe(401)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "first-use-password" }))
        .status,
    ).toBe(200)
  })

  test("an expired token is refused", async () => {
    await forgot("owner@devpipe.com")
    const token = lastResetToken()
    await db.execute(
      from("password_resets")
        .where(q => q("used_at").isNull())
        .update({ expires_at: "2020-01-01 00:00:00" }),
    )
    expect((await call("POST", "/auth/reset", { token, password: "too-late-password" })).status).toBe(400)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "too-late-password" }))
        .status,
    ).toBe(401)
  })

  test("expired rows are swept on the next request", async () => {
    const stale = (await db.all(
      from("password_resets").where(q => q("expires_at").equals("2020-01-01 00:00:00")),
    )) as any[]
    expect(stale.length).toBeGreaterThan(0)

    await forgot("ghost@example.com")
    const after = (await db.all(
      from("password_resets").where(q => q("expires_at").equals("2020-01-01 00:00:00")),
    )) as any[]
    expect(after.length).toBe(0)
  })

  test("a password that is not a string is refused", async () => {
    await forgot("owner@devpipe.com")
    const token = lastResetToken()
    // `(1).length` is undefined, and undefined < 12 is false — the minimum is
    // only a minimum if the type is checked first.
    expect((await call("POST", "/auth/reset", { token, password: 1 })).status).toBe(422)
    expect((await call("POST", "/auth/reset", { token, password: { a: 1 } })).status).toBe(422)
    expect((await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "1" })).status).toBe(401)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "[object Object]" })).status,
    ).toBe(401)
    // Neither attempt spent the token.
    expect((await call("POST", "/auth/reset", { token, password: "a-string-this-time" })).status).toBe(200)
  })

  test("using one link kills the others", async () => {
    await forgot("owner@devpipe.com")
    const first = lastResetToken()
    await forgot("owner@devpipe.com")
    const second = lastResetToken()
    expect(first).not.toBe(second)

    expect((await call("POST", "/auth/reset", { token: second, password: "the-owner-picked-this" })).status).toBe(
      200,
    )
    // The older link was live for another hour, which is long enough for
    // whoever asked for it to undo the reset that was meant to lock them out.
    expect((await call("POST", "/auth/reset", { token: first, password: "somebody-else-picked" })).status).toBe(400)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "somebody-else-picked" })).status,
    ).toBe(401)
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "the-owner-picked-this" })).status,
    ).toBe(200)
  })

  test("changing the password from the account page kills outstanding links", async () => {
    const signedIn = await call("POST", "/auth/login", {
      email: "owner@devpipe.com",
      password: "the-owner-picked-this",
    })
    expect(signedIn.status).toBe(200)

    await forgot("owner@devpipe.com")
    const inFlight = lastResetToken()

    expect(
      (
        await call(
          "POST",
          "/me/password",
          { current: "the-owner-picked-this", next: "changed-from-settings" },
          signedIn.data.token,
        )
      ).status,
    ).toBe(200)

    expect((await call("POST", "/auth/reset", { token: inFlight, password: "undone-by-the-link" })).status).toBe(
      400,
    )
    expect(
      (await call("POST", "/auth/login", { email: "owner@devpipe.com", password: "undone-by-the-link" })).status,
    ).toBe(401)
  })

  test("a short password is refused before the token is spent", async () => {
    await forgot("owner@devpipe.com")
    const token = lastResetToken()
    expect((await call("POST", "/auth/reset", { token, password: "short" })).status).toBe(422)
    // The token survives a rejected password, or a typo would cost an email.
    expect((await call("POST", "/auth/reset", { token, password: "a-long-enough-password" })).status).toBe(
      200,
    )
  })
})
