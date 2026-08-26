/**
 * The kind of client a session was started from, coarsely.
 *
 * A stolen session token works from anywhere. Nothing about a request says who
 * is holding it, so a cookie lifted off a laptop, a token read out of a backup,
 * or a CLI credential copied off a shared machine all look exactly like the
 * person they were taken from — for thirty days.
 *
 * Binding is the cheap half of the answer. The address is the obvious thing to
 * bind to and the wrong one: a phone changes address walking between two rooms,
 * so a rule that refuses on a changed IP is a rule that signs people out for
 * moving. The **client** is the useful signal. A real session is held by one
 * program for its whole life; a replayed token is almost always presented by a
 * different one — a script, a proxy, somebody else's browser.
 *
 * So this reduces a user agent to a shape that survives the things that
 * legitimately change and not the things that do not. Versions are dropped,
 * because a browser that updates itself every three weeks would otherwise sign
 * its user out every three weeks. What is left is the program and the kind of
 * machine, which for one real session does not change at all.
 *
 * Deliberately not a fingerprint in the tracking sense. It is two words, it is
 * derived from a header the client already sends on every request, and it is
 * stored against a session that already records the full agent string.
 */

/** Longest first: Edge and Chrome both say "Chrome", Chrome says "Safari". */
const PROGRAMS: readonly (readonly [string, string])[] = [
  ["devpipe/", "Devpipe"],
  ["Devpipe", "Devpipe"],
  // The old binary name remains an alias so an upgraded CLI does not invalidate
  // the session it is using to make the first request after the upgrade.
  ["dpctl", "Devpipe"],
  ["Edg/", "Edge"],
  ["OPR/", "Opera"],
  ["Firefox", "Firefox"],
  ["Chrome", "Chrome"],
  ["CriOS", "Chrome"],
  ["Safari", "Safari"],
  ["curl", "curl"],
  ["Wget", "Wget"],
  ["python", "python"],
  ["Go-http", "Go"],
  ["node", "node"],
  ["bun", "bun"],
]

const MACHINES: readonly (readonly [string, string])[] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Macintosh", "Mac"],
  ["Mac OS X", "Mac"],
  ["Darwin", "Mac"],
  ["Windows", "Windows"],
  ["CrOS", "ChromeOS"],
  ["Linux", "Linux"],
]

const first = (ua: string, table: readonly (readonly [string, string])[]): string => {
  for (const [needle, name] of table) {
    if (ua.includes(needle)) return name
  }
  return ""
}

/**
 * `Chrome/Mac`, `Devpipe/iPhone`, `curl/`. Empty when the agent says nothing
 * recognisable, which is treated as "unbound" rather than as its own class —
 * every unrecognised agent hashing to the same value would bind them all
 * together, which is worse than binding none of them.
 */
export const agentClass = (userAgent: string | null | undefined): string => {
  const ua = (userAgent ?? "").trim()
  if (!ua) return ""
  const program = first(ua, PROGRAMS)
  const machine = first(ua, MACHINES)
  return program || machine ? `${program}/${machine}` : ""
}

/**
 * Whether a request may continue on a session started by `stored`.
 *
 * An empty stored class is unbound and always passes: sessions predating this,
 * and clients that send no agent at all, must not be signed out by a rule they
 * were never given a chance to satisfy.
 */
export const sameClient = (stored: string, presented: string): boolean => {
  const renamed = (value: string) => value.replace(/^dpctl\//, "Devpipe/")
  return stored === "" || renamed(stored) === renamed(presented)
}
