import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline } from "@atlas/server"
import { sha256Hex } from "../util/token.ts"
import { currentUser, requireAuth } from "./guard.ts"

/** Signed-in devices, and the ability to end any of them. */
export const sessionRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))

  return [
    get(
      "/sessions",
      authed(async c => {
        const me = currentUser(c)
        const current = sha256Hex((c.headers.get("authorization") ?? "").slice(7).trim())
        const rows = (await db.all(
          from("sessions")
            .where(q => q("user_id").equals(me.id))
            .select("id", "token_hash", "user_agent", "ip", "last_seen_at", "created_at", "expires_at")
            .orderBy("last_seen_at", "DESC"),
        )) as any[]
        // The hash never leaves the server; the client only needs to know
        // which row is the device it is holding, so it can label it and avoid
        // signing itself out by accident.
        return json(
          c,
          200,
          rows.map(({ token_hash, ...rest }) => ({ ...rest, current: token_hash === current })),
        )
      }),
    ),

    del(
      "/sessions/:id",
      authed(async c => {
        const me = currentUser(c)
        const id = Number(c.params.id)
        const row = (await db.one(
          from("sessions")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!row) return json(c, 404, { error: "No such session." })
        await db.execute(
          from("sessions")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    // Sign out everywhere else — the useful shape after losing a device.
    del(
      "/sessions",
      authed(async c => {
        const me = currentUser(c)
        const current = sha256Hex((c.headers.get("authorization") ?? "").slice(7).trim())
        await db.execute(
          from("sessions")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("token_hash").notEquals(current))
            .del(),
        )
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
