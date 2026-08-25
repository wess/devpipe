import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { ATTACH, ATTACH_TTL, attachAny, attachOne, signForBox, verifyForBox } from "../src/util/boxscope.ts"

/**
 * The browser's terminal credential. What matters here is not that these parse
 * — it is that the daemon agrees, and that the token is narrow and brief.
 */
describe("scoped attach tokens", () => {
  const KEY = "box-token-of-no-particular-length"

  /**
   * The twin of `the_format_matches_the_control_planes` in
   * `daemon/src/scope.rs`. Two implementations of one scheme, pinned to the
   * same bytes: change the body, the digest or the encoding on either side and
   * one of the two fails, rather than every terminal in production.
   */
  test("the format is the one the daemon verifies", () => {
    const body = `${ATTACH}.1800000000`
    const sig = createHmac("sha256", KEY).update(body).digest("base64url")
    expect(`${body}.${sig}`).toBe("attach.1800000000.arwHhRBqLMB0eloPxi83LaWr2JHvc-A1JwgxThDnm5s")
  })

  test("it carries its scope and an expiry, and nothing else", () => {
    const [scope, expiry, sig] = attachAny(KEY).split(".")
    expect(scope).toBe(ATTACH)
    // Seconds, and within a second of the intended lifetime.
    expect(Number(expiry) - Math.floor(Date.now() / 1000)).toBeCloseTo(ATTACH_TTL, -1)
    expect(sig).toBeTruthy()
  })

  test("a session-scoped token names its session", () => {
    expect(attachOne(KEY, "s7").startsWith("attach:s7.")).toBe(true)
  })

  /**
   * The whole point. If this ever fails, the page is holding the box's real
   * credential again and the file system, the port proxy and the shell come
   * with it.
   */
  test("it is not the box token", () => {
    expect(attachAny(KEY)).not.toContain(KEY)
  })

  test("a different box's token signs differently", () => {
    const body = "attach.1800000000"
    const a = signForBox("box-a", ATTACH, 0).split(".").pop()
    const b = signForBox("box-b", ATTACH, 0).split(".").pop()
    expect(a).not.toBe(b)
    expect(createHmac("sha256", "box-a").update(body).digest("base64url")).not.toBe(
      createHmac("sha256", "box-b").update(body).digest("base64url"),
    )
  })

  test("the control-plane relay accepts the same scoped token as the daemon", () => {
    const token = attachAny(KEY)
    expect(verifyForBox(KEY, token)).toBe(ATTACH)
    expect(verifyForBox("another box", token)).toBeNull()
  })

  test("two minutes is the lifetime, not two hours", () => {
    expect(ATTACH_TTL).toBeLessThanOrEqual(300)
  })
})
