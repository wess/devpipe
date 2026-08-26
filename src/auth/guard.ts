import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { PipeFn } from "@atlas/server"
import { assign, halt } from "@atlas/server"
import { sha256Hex } from "../util/token.ts"
import { cookieValue, originIsOurs, SESSION_COOKIE } from "./cookie.ts"
import { agentClass, sameClient } from "./fingerprint.ts"
import { asRole, atLeast, type Role } from "./roles.ts"

export type AuthUser = {
  id: number
  email: string
  username: string
  name: string
  role: Role
  /**
   * Derived from the role, not stored beside it.
   *
   * Every gate that reads this means "the person whose provider account and
   * card this instance runs on", which is what `owner` is. Keeping it as a
   * convenience rather than a column is what stops the two disagreeing.
   */
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
 * The header is tried first. It is what the CLI sends, it is explicit,
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

    // **The client a session was started from has to be the one still using
    // it.** A stolen token is otherwise good from anywhere for thirty days, and
    // nothing else in this function would notice.
    //
    // The stored class is filled in from the agent recorded when the row was
    // created, so sessions predating this column are bound to the client that
    // actually made them rather than to whoever presents them next — which is
    // the whole point, and would be exactly backwards if it bound on first use.
    const presentedClass = agentClass(conn.headers.get("user-agent"))
    const storedClass: string = session.agent_class || agentClass(session.user_agent)
    if (!sameClient(storedClass, presentedClass)) {
      // Ended, not merely refused. If this token is being presented by a client
      // it was not issued to, the token is out, and leaving it alive so the
      // holder can try again from a better-disguised agent helps nobody. The
      // owner signs in again; whoever else has it gets nothing.
      await opts.db.execute(
        from("sessions")
          .where(q => q("id").equals(session.id))
          .del(),
      )
      console.warn(
        `[devpipe] session ${session.id} was started by ${storedClass || "an unknown client"} and presented by ${presentedClass || "an unknown client"} — ended`,
      )
      return halt(conn, 401, { error: "That session was started somewhere else. Sign in again." })
    }
    if (!session.agent_class && storedClass) {
      // Recorded once, so the comparison above is against a stored value from
      // here on rather than re-derived from the agent string every request.
      void opts.db
        .execute(
          from("sessions")
            .where(q => q("id").equals(session.id))
            .update({ agent_class: storedClass }),
        )
        .catch(() => {})
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
        role: asRole(user.role),
        is_owner: asRole(user.role) === "owner",
      } satisfies AuthUser,
    })
  }

/**
 * Owner-only routes: credentials, what things cost, the spend cap, and who
 * else may administer the instance.
 *
 * The test is deliberately the narrowest one available — everything behind it
 * either spends the owner's money or decides who else can.
 */
export const requireOwner = (): PipeFn => async conn => {
  const user = (conn as any).assigns?.auth as AuthUser | undefined
  if (!user || user.role !== "owner") {
    return halt(conn, 403, { error: "That is only available to the instance owner." })
  }
  return conn
}

/**
 * Admin routes: people, boxes, invites, the audit log.
 *
 * The owner passes this too — they are an admin with more besides, and a rule
 * that made the owner ask an admin for help would be a rule nobody could use.
 */
export const requireAdmin = (): PipeFn => async conn => {
  const user = (conn as any).assigns?.auth as AuthUser | undefined
  if (!user || !atLeast(user.role, "admin")) {
    return halt(conn, 403, { error: "That is only available to admins." })
  }
  return conn
}
