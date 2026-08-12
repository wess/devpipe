/**
 * Encryption for things the database holds on someone's behalf.
 *
 * An agent's login is not our secret. It belongs to the person who signed in,
 * it reaches their account rather than this instance, and it can spend their
 * money — so it is the one class of value here that must not be readable from
 * a database backup, a managed-database snapshot, or a `psql` session by
 * whoever happens to have the connection string.
 *
 * AES-256-GCM: authenticated, so a row that has been tampered with fails to
 * decrypt rather than decrypting into something attacker-chosen. The nonce is
 * random per encryption and stored beside the ciphertext, which is what makes
 * it safe to encrypt the same login twice.
 *
 * The key lives in the environment, never in the database it protects —
 * otherwise it is not encryption, it is encoding.
 */

const ALGORITHM = "AES-GCM"
const NONCE_BYTES = 12
const VERSION = "v1"

let cached: CryptoKey | null = null
let cachedFrom = ""

/**
 * The key, from `DEVPIPE_SECRET_KEY`.
 *
 * 32 bytes, base64. Generate one with:
 *
 *     openssl rand -base64 32
 *
 * Absent, this throws rather than falling back to something weaker. A silent
 * fallback would mean an instance quietly storing agent logins in the clear
 * while every screen said they were encrypted.
 */
const key = async (): Promise<CryptoKey> => {
  const raw = process.env.DEVPIPE_SECRET_KEY ?? ""
  if (!raw) {
    throw new Error(
      "DEVPIPE_SECRET_KEY is not set, so agent logins cannot be stored. Generate one with: openssl rand -base64 32",
    )
  }
  if (cached && cachedFrom === raw) return cached

  const bytes = unb64(raw.trim())
  if (bytes.length !== 32) {
    throw new Error(`DEVPIPE_SECRET_KEY must be 32 bytes of base64; got ${bytes.length}.`)
  }
  cached = await crypto.subtle.importKey("raw", bytes, ALGORITHM, false, ["encrypt", "decrypt"])
  cachedFrom = raw
  return cached
}

export const secretsAvailable = (): boolean => Boolean(process.env.DEVPIPE_SECRET_KEY)

/**
 * Optional additional authenticated data: context the ciphertext is *bound* to.
 *
 * Encryption alone stops a value being read from a backup. It does not stop a
 * sealed value being **moved** — copy another user's row into your own vault
 * entry and the app decrypts it for you, because the bytes are still valid
 * under the same key. Binding the ciphertext to who and where it belongs is
 * what closes that, and it is only meaningful if the caller passes the same
 * context to `open`: a mismatch fails the authentication tag rather than
 * returning the wrong plaintext.
 *
 * Pass a stable, canonical string — `vault:<user>:<scope>:<scope_id>:<name>`
 * rather than anything ordering- or formatting-dependent, because a value
 * sealed under one spelling cannot be opened under another.
 */
export type Context = string | undefined

const aad = (context: Context): Uint8Array<ArrayBuffer> | undefined =>
  context === undefined ? undefined : (new TextEncoder().encode(context) as Uint8Array<ArrayBuffer>)

/** `v1.<nonce>.<ciphertext>`, both base64. */
export const seal = async (plaintext: string, context?: Context): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const data = new TextEncoder().encode(plaintext)
  const box = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: nonce, additionalData: aad(context) },
    await key(),
    data,
  )
  return `${VERSION}.${b64(nonce)}.${b64(new Uint8Array(box))}`
}

/**
 * Returns null rather than throwing when the value cannot be opened.
 *
 * A login encrypted under a key that has since been rotated is not an error to
 * propagate — it is a login that has to be done again, which is exactly what
 * happens if the caller treats null as "nothing stored".
 */
export const open = async (sealed: string, context?: Context): Promise<string | null> => {
  const [version, nonce, body] = sealed.split(".")
  if (version !== VERSION || !nonce || !body) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: unb64(nonce), additionalData: aad(context) },
      await key(),
      unb64(body),
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.charCodeAt(0))
