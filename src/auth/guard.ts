import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { PipeFn } from "@atlas/server"
import { assign, halt } from "@atlas/server"
import { sha256Hex } from "../util/token.ts"

export type AuthUser = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
}

export const currentUser = (c: any): AuthUser => c.assigns.auth as AuthUser

/**
 * Resolves `Authorization: Bearer <token>` to a user, or stops the request.
 *
 * Sessions are looked up by hash, so the database never holds anything that
 * could be replayed if it leaked. Expiry is checked here rather than by a
 * sweep, because a sweep that has not run yet is not a reason to honour a
 * dead session.
 */
export const requireAuth =
  (opts: { db: Connection }): PipeFn =>
  async conn => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return halt(conn, 401, { error: "Sign in to continue." })
    }
    const presented = header.slice(7).trim()
    if (!presented) return halt(conn, 401, { error: "Sign in to continue." })

    // Two plain lookups rather than a join. The query builder quotes a dotted
    // alias as a single identifier, and the join this replaced is not worth
    // hand-writing SQL for on a path that runs on every request.
    const session = (await opts.db.one(
      from("sessions").where(q => q("token_hash").equals(sha256Hex(presented))),
    )) as any
    if (!session) return halt(conn, 401, { error: "That session is no longer valid." })

    // Expiry is checked here rather than left to a sweep: a sweep that has not
    // run yet is not a reason to honour a dead session.
    //
    // The driver hands back a Date for a timestamptz. This used to reassemble a
    // string — replace the space, append a Z — which against a real timestamp
    // parses to NaN, and `NaN < Date.now()` is false, so every expired session
    // would have been honoured forever.
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return halt(conn, 401, { error: "That session has expired. Sign in again." })
    }

    const user = (await opts.db.one(from("users").where(q => q("id").equals(session.user_id)))) as any
    if (!user) return halt(conn, 401, { error: "That session is no longer valid." })
    if (user.suspended_at) {
      return halt(conn, 403, {
        error: "This account has been suspended. Contact the instance owner.",
      })
    }

    // Cheap enough to do inline, and it is what makes the session list in
    // settings show anything useful.
    await opts.db.execute(
      from("sessions")
        .where(q => q("id").equals(session.id))
        .update({ last_seen_at: new Date() }),
    )

    return assign(conn, {
      auth: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: Boolean(user.is_owner),
      } satisfies AuthUser,
    })
  }

/** Owner-only routes: user management, credentials, instance settings. */
export const requireOwner = (): PipeFn => async conn => {
  const user = (conn as any).assigns?.auth as AuthUser | undefined
  if (!user?.is_owner) {
    return halt(conn, 403, { error: "That is only available to the instance owner." })
  }
  return conn
}
