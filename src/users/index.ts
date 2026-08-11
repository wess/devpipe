import { hash, verify } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, patch, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { revokeResetTokens } from "../auth/password.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { audit } from "../util/audit.ts"
import { sha256Hex } from "../util/token.ts"

/** The signed-in user's own profile and password. */
export const userRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }), parseJson)

  // Verifying a password makes this a credential oracle for anyone holding a
  // stolen session token. Behind `requireAuth` the user bucket is the control;
  // the address number is high because a tight one is a CGNAT trap.
  const changePassword = pipeline(
    requireAuth({ db }),
    parseJson,
    rateLimit({ db, key: "me.password", limit: 200, windowSeconds: 3600, subject: signedInUser, subjectLimit: 5 }),
  )

  return [
    patch(
      "/me",
      authed(async c => {
        const me = currentUser(c)
        const b = c.body as { name?: string }
        const name = b.name?.trim().slice(0, 80)
        if (!name) return json(c, 422, { error: "Give a name." })
        await db.execute(
          from("users")
            .where(q => q("id").equals(me.id))
            .update({ name }),
        )
        return json(c, 200, { ...me, name })
      }),
    ),

    post(
      "/me/password",
      changePassword(async c => {
        const me = currentUser(c)
        const b = c.body as { current?: string; next?: string }
        if ((b.next ?? "").length < 12) return json(c, 422, { error: "Use at least 12 characters." })

        const row = (await db.one(from("users").where(q => q("id").equals(me.id)))) as any
        if (!(await verify(b.current ?? "", row.password))) {
          return json(c, 403, { error: "That current password is wrong." })
        }

        await db.execute(
          from("users")
            .where(q => q("id").equals(me.id))
            .update({ password: await hash(b.next!) }),
        )

        // Any reset link already in flight goes too — otherwise whoever asked
        // for one can undo this change for the next hour.
        await revokeResetTokens(db, me.id)

        // Changing a password is usually a response to losing control of it,
        // so every other device is signed out. The one making the change is
        // kept, because signing the user out of the screen they are on reads
        // as a failure.
        const current = sha256Hex((c.headers.get("authorization") ?? "").slice(7).trim())
        await db.execute(
          from("sessions")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("token_hash").notEquals(current))
            .del(),
        )
        await audit(db, me.id, "user.password_changed")
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
