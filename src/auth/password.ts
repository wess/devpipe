import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { type Emailer, passwordResetEmail, sendDetached } from "../email/index.ts"
import { rateLimit, submittedEmail } from "../security/ratelimit.ts"
import { audit } from "../util/audit.ts"
import { randomToken, sha256Hex } from "../util/token.ts"

/** An hour is long enough to walk to another device and short enough to matter. */
const TOKEN_MINUTES = 60

const MIN_PASSWORD = 12

/**
 * Drops every reset link outstanding for a user.
 *
 * Call it from anywhere a password changes, not just from here. Someone who
 * reached the inbox first and asked for their own link holds it for an hour;
 * ending the sessions without ending the links lets them walk straight back in
 * after the owner has taken the account back.
 */
export const revokeResetTokens = async (db: Connection, userId: number): Promise<void> => {
  await db.execute(
    from("password_resets")
      .where(q => q("user_id").equals(userId))
      .where(q => q("used_at").isNull())
      .del(),
  )
}

export const passwordRoutes = (db: Connection, opts: { emailer: Emailer; appUrl: string }) => {
  // The one bucket in the app where the email limit is as tight as the address
  // limit. Three requests naming an address deny that person a reset for the
  // rest of the hour, which is a real cost — but a mail provider's reputation
  // takes far longer to get back than an account does, and a fourth copy of a
  // reset link has never helped anybody.
  const forgot = pipeline(
    parseJson,
    rateLimit({ db, key: "auth.forgot", limit: 3, windowSeconds: 3600, subject: submittedEmail, subjectLimit: 3 }),
  )
  // No email dimension — the body carries a token, so there is nothing to key
  // on. The token is 32 bytes, so guessing is not the threat; the limit is
  // there because the endpoint hashes and looks up whatever it is handed.
  const reset = pipeline(parseJson, rateLimit({ db, key: "auth.reset", limit: 10, windowSeconds: 3600 }))

  return [
    post(
      "/auth/forgot",
      forgot(async c => {
        const email = String((c.body as any)?.email ?? "")
          .trim()
          .toLowerCase()

        // Nothing schedules a sweep, so it happens here. Expired rows are
        // useless and a reset table that only ever grows is a liability.
        await db.execute(
          from("password_resets")
            .where(q => q("expires_at").lessThan(new Date()))
            .del(),
        )

        const user = (await db.one(from("users").where(q => q("email").equals(email)))) as any
        if (user && !user.suspended_at) {
          const token = randomToken()
          await db.execute(
            from("password_resets").insert({
              user_id: user.id,
              token_hash: sha256Hex(token),
              expires_at: new Date(Date.now() + TOKEN_MINUTES * 60_000),
            }),
          )
          const mail = passwordResetEmail({
            name: user.name,
            resetUrl: `${opts.appUrl}/reset?token=${encodeURIComponent(token)}`,
          })
          sendDetached(opts.emailer, { to: user.email, ...mail })
          await audit(db, user.id, "password.reset_requested", email)
        }

        // The same answer whether or not that address has an account. Anything
        // else — a different status, a different message, a slower reply — is
        // a way to ask this endpoint who has an account here.
        return json(c, 200, { ok: true })
      }),
    ),

    post(
      "/auth/reset",
      reset(async c => {
        const b = c.body as { token?: string; password?: string }
        const token = String(b.token ?? "").trim()

        if (!token) {
          return json(c, 422, { error: "That reset link is missing its token. Use the link from the email." })
        }
        // Typed before it is measured. JSON carries numbers and objects too,
        // and `.length` on either is undefined, which is not less than 12 —
        // so `{"password": 1}` would sail through and leave the account with a
        // one-character password. This is the one route that sets a password
        // without being shown the old one, so it does the check properly.
        if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD) {
          return json(c, 422, { error: "Use at least 12 characters." })
        }
        const password = b.password

        const row = (await db.one(from("password_resets").where(q => q("token_hash").equals(sha256Hex(token))))) as any

        // One message for unknown, spent, and expired. Whoever holds the token
        // learns nothing useful from the distinction, and the fix is the same.
        const dead = () =>
          json(c, 400, { error: "That reset link has expired or has already been used. Ask for a new one." })
        if (!row) return dead()
        if (row.used_at) return dead()
        // Written the awkward way round on purpose: an unparseable timestamp
        // gives NaN, and `NaN < now` is false, which would read as still live.
        if (!(new Date(row.expires_at).getTime() > Date.now())) return dead()

        // Spend the token before setting the password. If the write after this
        // one fails the user asks for another link, which they can do; the
        // other order would leave a live token nobody can revoke.
        await db.execute(
          from("password_resets")
            .where(q => q("id").equals(row.id))
            .update({ used_at: new Date() }),
        )
        await db.execute(
          from("users")
            .where(q => q("id").equals(row.user_id))
            .update({ password: await hash(password) }),
        )

        await revokeResetTokens(db, row.user_id)

        // A reset is usually the answer to losing control of the account, so
        // every session goes — the browser that asked for it included.
        await db.execute(
          from("sessions")
            .where(q => q("user_id").equals(row.user_id))
            .del(),
        )
        await audit(db, row.user_id, "password.reset")

        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
