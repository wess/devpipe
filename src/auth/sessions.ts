import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline } from "@atlas/server"
import { currentUser, requireAuth } from "./guard.ts"

/**
 * Signed-in devices, and the ability to end any of them.
 *
 * Which row is "this one" comes from `conn.assigns.session`, set by
 * `requireAuth` from whatever the request actually presented. It used to be
 * re-derived here from `Authorization`, which stopped being right the moment
 * the browser's session became a cookie: a browser sends no such header, so the
 * hash was of the empty string. That is not a small miss. It made the list
 * unable to say which device you were on — and it made "sign out everywhere
 * else" match nothing to exclude, so it signed you out of everywhere including
 * here, which reads as the page breaking rather than as the thing it did.
 */
const currentHash = (c: any): string => (c.assigns?.session?.hash as string) ?? ""

/** Signed-in devices, and the ability to end any of them. */
export const sessionRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))

  return [
    get(
      "/sessions",
      authed(async c => {
        const me = currentUser(c)
        const current = currentHash(c)
        const rows = (await db.all(
          from("sessions")
            .where(q => q("user_id").equals(me.id))
            .select("id", "token_hash", "user_agent", "agent_class", "ip", "last_seen_at", "created_at", "expires_at")
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
        const current = currentHash(c)
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
