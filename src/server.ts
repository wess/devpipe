import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { router } from "@atlas/server"
import { adminRoutes } from "./admin/index.ts"
import { authRoutes } from "./auth/index.ts"
import { passwordRoutes } from "./auth/password.ts"
import { sessionRoutes } from "./auth/sessions.ts"
import { billingRoutes } from "./billing/index.ts"
import { companionRoutes } from "./boxes/companion.ts"
import { boxRoutes, convergeFirewall } from "./boxes/index.ts"
import { expireDormant, reclaimIdle } from "./boxes/reclaim.ts"
import { broadcastRoutes } from "./broadcast/index.ts"
import { claimRoutes } from "./claims/index.ts"
import { createEmailer } from "./email/index.ts"
import { watchEgress } from "./security/egress.ts"
import { securityHeaders } from "./security/headers.ts"
import { sweepRateLimits } from "./security/ratelimit.ts"
import { terminalRoutes } from "./terminals/index.ts"
import { userRoutes } from "./users/index.ts"
import { waitlistRoutes } from "./waitlist/index.ts"
import { boxVaultRoutes } from "./vault/box.ts"
import { vaultRoutes } from "./vault/index.ts"
import { workspaceRoutes } from "./workspaces/index.ts"

/**
 * The Postgres the test suite already assumes, used when nothing else is
 * configured.
 *
 * There is no SQLite fallback any more, and this is what replaces it. The
 * schema is Postgres — `SERIAL`, `TIMESTAMPTZ`, `NOW()` — so pointing the
 * server at a file produced a `SQLiteError: near "(": syntax error` from three
 * frames inside a driver, on the very first `bun run dev`, with nothing in it
 * naming the cause. The suite moved to Postgres for exactly this reason: it
 * "used to run on a temp SQLite file, which was fast and tested a database the
 * server no longer uses".
 *
 * Bring one up with:
 *   docker run -d --name devpipe-postgres -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_USER=postgres -p 55434:5432 postgres:17-alpine
 */
const DEV_DATABASE_URL = "postgres://postgres:postgres@localhost:55434/devpipe"

const config = defineConfig({
  port: env("PORT", { parse: Number, default: "3000" }),
  // Bound to everything for development convenience and to loopback in the
  // systemd unit. It matters: `clientIp` can only read x-forwarded-for, so a
  // caller that reaches this port directly supplies the whole header itself,
  // gets a fresh bucket for every value it invents, and is not limited at all.
  host: env("HOST", { default: "0.0.0.0" }),
  databaseUrl: env("DATABASE_URL", { default: "" }),
  appUrl: env("APP_URL", { default: "http://localhost:3001" }),
  boxDomain: env("BOX_DOMAIN", { default: "devpipe.com" }),
  // Named for the header it sets rather than for one company: the API surface
  // is Resend's, and Outbox implements it, so this is the key for whichever of
  // them EMAIL_BASE_URL points at.
  resendApiKey: env("RESEND_API_KEY", { default: "" }),
  emailFrom: env("EMAIL_FROM", { default: "" }),
  /** A Resend-compatible host to send through. Empty means Resend itself. */
  emailBaseUrl: env("EMAIL_BASE_URL", { default: "" }),
})

/**
 * Creates the development database if the server is falling back to it.
 *
 * Only on the fallback path. A server told where its database is has no
 * business creating one — that is a deploy's job, and doing it here would turn
 * a typo in a production URL into a new empty database that migrates cleanly
 * and serves an instance with no users in it.
 */
const ensureDevDatabase = async () => {
  const { SQL } = await import("bun")
  const name = DEV_DATABASE_URL.slice(DEV_DATABASE_URL.lastIndexOf("/") + 1)
  const probe = new SQL({ url: DEV_DATABASE_URL, max: 1 })
  try {
    await probe`SELECT 1`
    return
  } catch {
    // Falls through to create it. Any other failure — no server, wrong
    // password — surfaces from the admin connection below with its own error.
  } finally {
    await probe.close().catch(() => {})
  }
  const admin = new SQL({ url: DEV_DATABASE_URL.replace(/\/[^/]*$/, "/postgres"), max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`, [])
    console.log(`[devpipe] created the development database ${name}`)
  } finally {
    await admin.close().catch(() => {})
  }
}

if (!config.databaseUrl) {
  console.warn(`[devpipe] DATABASE_URL is not set — using the development database at ${DEV_DATABASE_URL}`)
  await ensureDevDatabase().catch(err => console.error("[devpipe] could not reach the development database:", err))
}
const db = connect({ driver: "postgres", url: config.databaseUrl || DEV_DATABASE_URL })

// Reported rather than rethrown. What comes out of a driver on a refused
// connection or a half-applied migration says nothing about which of the two it
// was, and this is the first thing that runs — so it is the error someone sees
// before they have any reason to suspect the database at all.
try {
  await migrate.up(db, "./migrations")
} catch (err) {
  console.error("[devpipe] the database is not ready:", err)
  console.error(
    "[devpipe] set DATABASE_URL, or start the development database:\n" +
      "  docker run -d --name devpipe-postgres -e POSTGRES_PASSWORD=postgres \\\n" +
      "    -e POSTGRES_USER=postgres -p 55434:5432 postgres:17-alpine",
  )
  process.exit(1)
}

// Prints to stdout unless both a key and a from address are set, so a
// development instance cannot mail a real person by accident.
const emailer = createEmailer({
  apiKey: config.resendApiKey,
  from: config.emailFrom,
  baseUrl: config.emailBaseUrl || null,
})

const baseFetch = router(
  ...authRoutes(db),
  ...passwordRoutes(db, { emailer, appUrl: config.appUrl }),
  ...sessionRoutes(db),
  ...userRoutes(db),
  ...boxRoutes(db, config.appUrl),
  ...workspaceRoutes(db),
  ...vaultRoutes(db),
  ...boxVaultRoutes(db),
  ...billingRoutes(db, config.appUrl),
  ...terminalRoutes(db),
  ...companionRoutes(db),
  ...adminRoutes(db),
  ...claimRoutes(db),
  ...broadcastRoutes(db, emailer, config.appUrl),
  ...waitlistRoutes(db),
)

const headers = Object.entries(securityHeaders(config.boxDomain))

// The web tier proxies /api/* through to here, so strip the prefix once at the
// edge rather than repeating it in every route pattern.
const fetch = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  let res: Response
  if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice(4)
    res = await baseFetch(new Request(url, req))
  } else {
    res = await baseFetch(req)
  }
  for (const [key, value] of headers) res.headers.set(key, value)
  return res
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch,
  // Terminal websockets connect straight to a box, so nothing here is
  // long-lived; a request that has moved no bytes for two minutes is stuck.
  idleTimeout: 120,
})

// Expired buckets are already treated as empty, so this is housekeeping rather
// than correctness: without it the table keeps a row for every address that has
// ever arrived. Ten minutes is arbitrary; anything well inside the longest
// window beats unbounded growth.
const sweeper = setInterval(() => {
  void sweepRateLimits(db).catch(err => console.error("[devpipe] rate-limit sweep:", err))
}, 600_000)
sweeper.unref()

// The box firewall, put back the way it should be.
//
// It is attached by tag and converged when a box is provisioned, which covers
// new boxes and leaves every existing one on whatever rules it was created
// under. That is how closing outbound mail ended up being applied by hand to a
// running box. Hourly, and once at startup, so a deploy is enough to roll a
// rule change out to machines nobody is touching.
void convergeFirewall(db)
const firewall = setInterval(() => void convergeFirewall(db), 3_600_000)
firewall.unref()

// What is actually leaving each box.
//
// The apt pin and the closed mail ports raise the cost of the obvious thing and
// bound nothing. Volume bounds it, needs no opinion about what ran on the box,
// and the provider is already measuring it. This only records and warns —
// a busy build and a seedbox look alike for an hour, and locking a paying
// customer out on an hour of traffic is the worse mistake.
const egress = setInterval(() => {
  void watchEgress(db).catch(err => console.error("[devpipe] egress watch:", err))
}, 3_600_000)
egress.unref()

// Boxes nobody is using, given back.
//
// Every fifteen minutes rather than hourly: the saving is proportional to how
// promptly an idle box is noticed, and the check is one indexed query plus one
// request per candidate. Does nothing at all until somebody sets the idle hours,
// and never touches a box without a workspace.
const reclaim = setInterval(() => {
  void reclaimIdle(db).catch(err => console.error("[devpipe] idle reclaim:", err))
  // Trials nobody came back to, whose workspaces are still being charged for.
  // Off unless a number of days is set, because this deletes files.
  void expireDormant(db).catch(err => console.error("[devpipe] dormant expiry:", err))
}, 900_000)
reclaim.unref()

const shutdown = async (signal: string) => {
  try {
    clearInterval(sweeper)
    clearInterval(firewall)
    clearInterval(egress)
    clearInterval(reclaim)
    await server.stop(false)
    await db.close()
  } catch (err) {
    console.error("[devpipe] shutdown error:", err)
  }
  console.log(`[devpipe] stopped (${signal})`)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("unhandledRejection", reason => {
  console.error("[devpipe] unhandled rejection:", reason)
})

console.log(`[devpipe] api on :${config.port}`)
