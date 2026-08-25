import type { Connection } from "@atlas/db"
import { get, json } from "@atlas/server"

export const healthRoutes = (db: Connection) => [
  get("/health", async c => json(c, 200, { ok: true })),
  get("/ready", async c => {
    try {
      await db.one({ text: "SELECT 1 AS ok", values: [] })
      return json(c, 200, { ok: true, database: "ready" })
    } catch (err) {
      console.error("[devpipe] readiness check failed:", err)
      return json(c, 503, { ok: false, database: "unavailable" })
    }
  }),
]
