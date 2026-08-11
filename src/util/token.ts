import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** 32 bytes of entropy, url-safe. Long enough that guessing is not a strategy. */
export const randomToken = (): string => randomBytes(32).toString("base64url")

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex")

/**
 * Compares two hex digests without leaking where they diverge. Session lookups
 * happen on every request, so the timing is observable in a way a one-off
 * password check is not.
 */
export const digestsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
}

/**
 * A short, human-readable identifier — for box hostnames, which end up in a
 * subdomain someone has to be able to read out loud. No vowels, so it cannot
 * accidentally spell anything, and no 0/O or 1/l.
 */
export const shortId = (length = 8): string => {
  const alphabet = "bcdfghjkmnpqrstvwxz23456789"
  const bytes = randomBytes(length)
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("")
}
