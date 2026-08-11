/**
 * What may be a username, in one place.
 *
 * A username becomes a hostname (`<username>-xxxxx.devpipe.com`), so the rules
 * are DNS's rather than ours. Registration and pre-launch claims both go
 * through here — two copies of this would drift, and the failure when they do
 * is somebody claiming a name they can never actually register.
 */

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

/** Names that would collide with infrastructure or read as official. */
const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "administrator",
  "owner",
  "app",
  "mail",
  "smtp",
  "ns1",
  "ns2",
  "ns3",
  "n8n",
  "status",
  "docs",
  "doc",
  "blog",
  "help",
  "support",
  "static",
  "assets",
  "cdn",
  "devpipe",
  "root",
  "system",
  "billing",
  "pay",
  "payments",
  "security",
  "abuse",
  "legal",
  "team",
  "about",
  "pricing",
  "terms",
  "privacy",
  "login",
  "signin",
  "signup",
  "register",
  "account",
  "settings",
  "dashboard",
  "console",
  "null",
  "undefined",
  "test",
  "staging",
  "dev",
  "prod",
  "production",
])

/**
 * Names held for a specific person, by address. Everyone else is refused, and
 * the holder gets it whenever they get round to signing up.
 *
 * More than one address per name, because the person holding it is not the same
 * thing as the mailbox they happen to sign up from — an instance address and a
 * personal one are both them, and holding the name for only one of them refuses
 * its owner with the same message it refuses a stranger.
 */
const HELD: Record<string, readonly string[]> = {
  wess: ["wess@devpipe.com", "me@wess.io"],
}

export type UsernameVerdict = { ok: true } | { ok: false; reason: string }

export const checkUsername = (raw: string, email?: string): UsernameVerdict => {
  const username = raw.trim().toLowerCase()
  const address = email?.trim().toLowerCase()

  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      reason: "Usernames are 3–32 characters: lowercase letters, numbers and dashes.",
    }
  }
  if (RESERVED.has(username)) {
    return { ok: false, reason: "That username is not available." }
  }
  const heldFor = HELD[username]
  if (heldFor && !(address && heldFor.includes(address))) {
    // Deliberately the same wording as a reserved name. Saying "held for
    // someone else" tells a stranger the name is real and worth watching.
    return { ok: false, reason: "That username is not available." }
  }
  return { ok: true }
}

export const normaliseUsername = (raw: string): string => raw.trim().toLowerCase()

export const isEmail = (s: string): boolean => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254
