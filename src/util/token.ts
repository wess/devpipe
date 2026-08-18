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
 *
 * Drawn without modulo bias. `byte % 27` looks harmless and is not uniform:
 * 256 is not a multiple of 27, so the first thirteen letters come up about 11%
 * more often than the rest. For a hostname that is a curiosity. This also
 * generates a preview's slug, where the hostname *is* the credential for a
 * shared link — and a generator whose output is not uniform has fewer bits
 * than its length suggests.
 */
export const shortId = (length = 8): string => {
  const alphabet = "bcdfghjkmnpqrstvwxz23456789"
  // The largest multiple of the alphabet that fits in a byte. Anything above it
  // is thrown away and redrawn, which is what makes the rest uniform.
  const ceiling = 256 - (256 % alphabet.length)
  const out: string[] = []
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= ceiling) continue
      out.push(alphabet[byte % alphabet.length] as string)
      if (out.length === length) break
    }
  }
  return out.join("")
}
