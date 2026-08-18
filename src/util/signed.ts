import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Short-lived tokens that carry their own meaning, so nothing has to be stored
 * to recognise them later.
 *
 * Used for the cookie that admits a browser to a private preview. A row per
 * grant would work, and would also mean a table that grows with every tab
 * anybody opens plus a sweep to empty it — for a value whose whole lifetime is
 * a few hours and whose revocation is already handled elsewhere. Revoking a
 * preview revokes the thing the token names, which is checked on every request
 * regardless, so the token itself never needs to be recalled.
 *
 * HMAC-SHA256 over `<payload>.<expiry>`, compared in constant time. This is not
 * encryption: the payload is readable by whoever holds the token. Nothing in it
 * is secret — a preview id and the user it belongs to — and the signature is
 * what makes it unforgeable.
 */

const KEY_ENV = "DEVPIPE_SECRET_KEY"

/**
 * Falls back to a key that lives as long as the process.
 *
 * `DEVPIPE_SECRET_KEY` is required for sealing agent logins, where a silent
 * fallback would be a lie. Here it is not: an instance without one still works,
 * and the only consequence is that a restart asks everyone looking at a private
 * preview to be admitted again. Refusing to sign at all would instead take
 * previews down on a development machine that has never needed the key.
 */
let ephemeral = ""
const key = (): string => {
  const configured = process.env[KEY_ENV]?.trim()
  if (configured) return configured
  if (!ephemeral) ephemeral = randomBytes(32).toString("base64")
  return ephemeral
}

const mac = (body: string): string => createHmac("sha256", key()).update(body).digest("base64url")

/** `payload` and an expiry, signed. Seconds, because that is what cookies use. */
export const sign = (payload: string, ttlSeconds: number): string => {
  const body = `${payload}.${Math.floor(Date.now() / 1000) + ttlSeconds}`
  return `${body}.${mac(body)}`
}

/**
 * The payload back, or null.
 *
 * Null covers every way this can fail — wrong shape, wrong signature, past its
 * expiry — because none of them is a distinction the caller can act on, and
 * telling them apart is exactly what an oracle is.
 */
export const unsign = (token: string): string | null => {
  const cut = token.lastIndexOf(".")
  if (cut < 1) return null
  const body = token.slice(0, cut)
  const presented = token.slice(cut + 1)
  const expected = mac(body)
  if (presented.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) return null

  const at = body.lastIndexOf(".")
  if (at < 1) return null
  const expires = Number(body.slice(at + 1))
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return null
  return body.slice(0, at)
}
