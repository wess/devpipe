import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Narrow, short-lived tokens for the one credential a browser has to hold.
 *
 * `/boxes/:id/connection` used to answer with `box.agent_token` — the box's
 * whole bearer. When that was written it opened a terminal, which is roughly
 * what the page was being trusted with anyway. It now also reads and writes
 * every file on the box over `/v1/fs`, proxies any listening port, forwards any
 * loopback socket, and spawns a shell. The credential grew and the thing it was
 * being handed to did not.
 *
 * A browser cannot set a header on a websocket, so whatever admits it ends up
 * in a URL — in the page, in `history`, in the box's access log. The fix is not
 * to hide that value, which cannot be done, but to make it worth almost
 * nothing: two minutes, and a pty at the end of it.
 *
 * **Keyed by the box token**, which is what makes this free to operate. Both
 * sides already hold it, so there is no key to distribute and nothing extra to
 * rotate — and rotating a box's token invalidates every scoped token minted
 * against it, which is the behaviour you would have had to build otherwise.
 *
 * The verifier is `daemon/src/scope.rs`. The two are pinned to each other by a
 * shared test vector in `tests/boxscope.test.ts` and `scope.rs`; change the
 * format in one and the other fails rather than silently refusing every
 * connection in production.
 */

/** Attach to any session on the box. What the owner's own client is given. */
export const ATTACH = "attach"

/**
 * Long enough to open a socket on a slow connection, short enough that a copy
 * out of a log or a screenshot is stale before anyone reads it. The websocket
 * outlives it: this admits the handshake, and once the socket is up nothing
 * re-checks it, which is why a reconnect fetches a fresh one.
 */
export const ATTACH_TTL = 120

export const signForBox = (boxToken: string, scope: string, ttlSeconds: number): string => {
  const body = `${scope}.${Math.floor(Date.now() / 1000) + ttlSeconds}`
  return `${body}.${createHmac("sha256", boxToken).update(body).digest("base64url")}`
}

/** Attach to one named session, and no other. What a share would carry. */
export const attachOne = (boxToken: string, sessionId: string, ttlSeconds = ATTACH_TTL): string =>
  signForBox(boxToken, `${ATTACH}:${sessionId}`, ttlSeconds)

export const attachAny = (boxToken: string, ttlSeconds = ATTACH_TTL): string => signForBox(boxToken, ATTACH, ttlSeconds)

/** The control-plane relay's half of the daemon's scoped-token verifier. */
export const verifyForBox = (boxToken: string, token: string): string | null => {
  const [scope, expiryText, signature, ...extra] = token.split(".")
  if (!scope || !expiryText || !signature || extra.length > 0) return null
  const expiry = Number(expiryText)
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return null
  const body = `${scope}.${expiryText}`
  const expected = createHmac("sha256", boxToken).update(body).digest()
  let presented: Buffer
  try {
    presented = Buffer.from(signature, "base64url")
  } catch {
    return null
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  return scope
}
