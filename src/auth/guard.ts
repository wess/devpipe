import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { PipeFn } from "@atlas/server"
import { assign, halt } from "@atlas/server"
import { sha256Hex } from "../util/token.ts"
import { cookieValue, originIsOurs, SESSION_COOKIE } from "./cookie.ts"

export type AuthUser = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
}

export const currentUser = (c: any): AuthUser => c.assigns.auth as AuthUser

/**
 * Resolves a session — from the cookie a browser holds, or from
 * `Authorization: Bearer` — to a user, or stops the request.
 *
 * Sessions are looked up by hash, so the database never holds anything that
 * could be replayed if it leaked. Expiry is checked here rather than by a
 * sweep, because a sweep that has not run yet is not a reason to honour a
 * dead session.
 *
 * The header is tried first. It is what iOS and `dpctl` send, it is explicit,
 * and a client that sends one is saying which credential it means.
 *
 * **Cookie-authenticated requests are origin-checked and header ones are not.**
 * That asymmetry is the whole point: a page can make a browser *send* a cookie
 * without being able to read it, so a cookie needs a second signal that the
 * request came from us. A bearer cannot be forged that way — a page that has
 * the token to put in the header has already lost the game somewhere else.
 *
 * The pages that make this matter are not hypothetical. A preview serves
 * somebody's half-finished application from `*.devpipe.com`, which is the same
 * *site* as this one, so `SameSite` does not separate them. The origin does.
 */
export const requireAuth =
  (opts: { db: Connection }): PipeFn =>
  async conn => {
    const header = conn.headers.get("authorization")
    const fromHeader = header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
    const fromCookie = fromHeader ? null : cookieValue(conn.headers.get("cookie"), SESSION_COOKIE)
    const presented = fromHeader || fromCookie || ""
    if (!presented) return halt(conn, 401, { error: "Sign in to continue." })

    if (fromCookie && !originIsOurs(conn.method, conn.headers.get("origin"))) {
      // Said plainly rather than as a 401. A 401 sends the client to sign in
      // again, which is exactly the wrong instruction — the session is fine and
      // the request came from somewhere it should not have.
      return halt(conn, 403, { error: "That request did not come from this site." })
    }

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
      // What the request actually presented, so logging out can end *this*
      // session without going back to the header it may not have come from.
      session: { hash: sha256Hex(presented) },
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
