import { connect, type Connection } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { SQL } from "bun"

/**
 * One Postgres, one schema, shared by every test file.
 *
 * The suite used to run on a temp SQLite file per file, which was fast and
 * tested a database the server no longer uses. Testing a different engine than
 * you ship is how you find out about `datetime('now')` in production.
 *
 * Bring one up with:
 *   docker run -d --name devpipe-postgres -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_USER=postgres -p 55434:5432 postgres:17-alpine
 */
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:55434/postgres"
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:55434/devpipe_test"
const TEST_DB_NAME = TEST_URL.match(/\/([^/?]+)(?:\?|$)/)?.[1] ?? "devpipe_test"

const ensureDb = async () => {
  try {
    const probe = new SQL({ url: TEST_URL, max: 1 })
    await probe`SELECT 1`
    await probe.close()
    return
  } catch {
    const admin = new SQL({ url: ADMIN_URL, max: 1 })
    try {
      await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`, [])
    } finally {
      await admin.close()
    }
  }
}

await ensureDb()

export const db: Connection = connect({ driver: "postgres", url: TEST_URL })
await migrate.up(db, "./migrations")

// Order does not matter with CASCADE, but naming every table does: a table
// added later and forgotten here leaks rows between files, and the failure
// shows up as an unrelated test that only fails when run second.
const TABLES = [
  "agent_logins",
  "broadcast_recipients",
  "broadcasts",
  "claims",
  "rate_limits",
  "password_resets",
  "billing_events",
  "subscriptions",
  "invites",
  "audit",
  "credentials",
  "settings",
  "waitlist",
  "box_events",
  "boxes",
  "sessions",
  "users",
]

/**
 * Wipe between files. `RESTART IDENTITY` matters as much as the truncate — a
 * test that asserts on id 1 passes alone and fails in a suite otherwise.
 */
export const truncateAll = async () => {
  await db.execute({
    text: `TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    values: [],
  })
}
