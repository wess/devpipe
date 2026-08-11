import type { Connection } from "@atlas/db"
import type { Conn, PipeFn } from "@atlas/server"
import { json, putHeader } from "@atlas/server"
import { sha256Hex } from "../util/token.ts"

/**
 * Counters live in the database rather than in a Map.
 *
 * The API and the web tier are separate processes today and the API can be run
 * more than once behind Caddy tomorrow; an in-memory counter would give each
 * process its own idea of the limit, so N processes means N times the limit.
 * Every route this guards is either unauthenticated or spends money, which is
 * exactly where being off by a factor of N matters.
 */

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The counter is raw SQL — the query builder cannot express a conditional
 * upsert — so placeholders have to be rewritten per driver. Values repeat in
 * the array rather than a placeholder being referenced twice, which keeps one
 * statement text working on both.
 */
const sql = (db: Connection, text: string, values: unknown[]) => {
  if (db.dialect !== "postgres") return { text, values }
  let n = 0
  return { text: text.replace(/\?/g, () => `$${++n}`), values }
}

export type Hit = {
  ok: boolean
  count: number
  /** Seconds until the window resets. Zero when the hit was allowed. */
  retryAfter: number
}

/**
 * Counts one hit against a bucket and says whether it was over the limit.
 *
 * Exported because a limit is not always a route: anything that can be spent
 * (a provider call, an email) can be metered with the same counter.
 */
export const consume = async (db: Connection, bucket: string, limit: number, windowSeconds: number): Promise<Hit> => {
  const at = nowSeconds()
  const expired = at - windowSeconds

  // One statement, so two processes racing the same bucket cannot both read 9
  // and both write 10. A read-then-write inside a transaction would need
  // BEGIN IMMEDIATE on SQLite to be safe, which the driver does not issue.
  const rows = (await db.execute(
    sql(
      db,
      `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= ? THEN ? ELSE rate_limits.window_start END
       RETURNING count, window_start`,
      [bucket, at, expired, expired, at],
    ),
  )) as Array<{ count: number; window_start: number }>

  const count = Number(rows[0]?.count ?? 1)
  if (count <= limit) return { ok: true, count, retryAfter: 0 }

  const started = Number(rows[0]?.window_start ?? at)
  return { ok: false, count, retryAfter: Math.max(1, started + windowSeconds - nowSeconds()) }
}

/**
 * The client address, from the right-hand end of `x-forwarded-for`.
 *
 * Caddy *appends* the peer it saw to whatever the client already sent, so the
 * left-most entry is attacker-chosen and the right-most is not. Reading the
 * left one — the obvious choice, and what session records currently do — would
 * let anyone rotate a header value and get a fresh bucket every request.
 *
 * With no header at all every caller shares one bucket. A caller that reaches
 * the API without passing through Caddy can send the header itself, though,
 * and then every value it invents is a fresh bucket and there is no limit at
 * all — nothing in this process can tell that apart from a real proxy hop.
 *
 * What keeps that from happening is that the deployed API binds loopback
 * (`HOST=127.0.0.1`, set in site/deploy.sh); the default in this repo is
 * 0.0.0.0 for development. There is no firewall in deploy/, so the binding is
 * the whole of the control. See docs/WIRING-security.md.
 */
export const clientIp = (conn: Conn): string => {
  const hops = (conn.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  // Truncated because on a request that did not come through Caddy the whole
  // header is attacker-chosen, and this goes into a unique index.
  const last = hops[hops.length - 1]
  return last ? last.slice(0, 64) : "unknown"
}

/** A second thing to count against, alongside the address. */
export type Subject = (conn: Conn) => string | null

/**
 * The email in the request body — for sign-in and anything else that names an
 * account it is about.
 *
 * Only works downstream of `parseJson`: until that has run `conn.body` is the
 * Request itself, and reading it here would consume the stream the handler
 * needs. Unparsed bodies fall back to the address limit alone.
 */
export const submittedEmail: Subject = conn => {
  const body = conn.body
  if (!body || typeof body !== "object" || body instanceof Request) return null
  const email = (body as { email?: unknown }).email
  if (typeof email !== "string") return null
  const trimmed = email.trim().toLowerCase()
  return trimmed || null
}

/** The signed-in user — for authenticated routes that cost money. */
export const signedInUser: Subject = conn => {
  const auth = conn.assigns.auth as { id?: number } | undefined
  return auth?.id ? String(auth.id) : null
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`

const wait = (seconds: number) => (seconds < 60 ? plural(seconds, "second") : plural(Math.ceil(seconds / 60), "minute"))

const refuse = (conn: Conn, retryAfter: number) =>
  json(putHeader(conn, "retry-after", String(retryAfter)), 429, {
    error: `Too many requests. Try again in ${wait(retryAfter)}.`,
  })

export type RateLimitOptions = {
  db: Connection
  /** Route name. Two routes with the same name share a budget, so keep them distinct. */
  key: string
  limit: number
  windowSeconds: number
  /** Counted separately from the address, in the same window. */
  subject?: Subject
  /** Defaults to `limit`. Give the subject more room than the address — see below. */
  subjectLimit?: number
}

/**
 * Refuses a request once its bucket is spent.
 *
 * Two buckets, both keyed on the route so a busy endpoint cannot starve a
 * quiet one. The address bucket stops one machine hammering; the subject
 * bucket stops a spread-out attack on a single account.
 *
 * The subject bucket introduces its own hazard — anyone who knows an address
 * can burn its budget from a botnet and lock that account out — which is why
 * it should be set well above the address limit, and why nothing is counted
 * against it once the address bucket has already refused.
 */
export const rateLimit = (opts: RateLimitOptions): PipeFn => {
  const subjectLimit = opts.subjectLimit ?? opts.limit

  return async conn => {
    const address = await consume(opts.db, `${opts.key}|ip|${clientIp(conn)}`, opts.limit, opts.windowSeconds)
    if (!address.ok) return refuse(conn, address.retryAfter)

    // After the address check, never before: counting a blocked attacker's
    // attempts against their victim is the lockout this is meant to avoid.
    const who = opts.subject?.(conn)
    if (!who) return conn

    // Hashed. Nobody looking for personal data thinks to look in a table of
    // counters, and a bucket outlives the request that created it.
    const subject = await consume(opts.db, `${opts.key}|who|${sha256Hex(who)}`, subjectLimit, opts.windowSeconds)
    return subject.ok ? conn : refuse(conn, subject.retryAfter)
  }
}

/**
 * The longest window anything here uses. A row older than this cannot affect
 * any decision, so it is safe to delete.
 */
export const MAX_WINDOW_SECONDS = 3600

/**
 * Deletes spent buckets and returns how many went.
 *
 * Rows do not carry the window they were counted in, so the sweep works to the
 * longest window in use rather than per-row. Nothing depends on this running:
 * an expired row is already treated as empty by `consume`. It exists so the
 * table stays proportional to current traffic instead of to every address that
 * has ever arrived.
 */
export const sweepRateLimits = async (
  db: Connection,
  olderThanSeconds: number = MAX_WINDOW_SECONDS,
): Promise<number> => {
  const rows = (await db.execute(
    sql(db, "DELETE FROM rate_limits WHERE window_start <= ? RETURNING bucket", [nowSeconds() - olderThanSeconds]),
  )) as unknown[]
  return rows.length
}
