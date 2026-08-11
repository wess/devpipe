import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { rateLimit } from "../security/ratelimit.ts"
import { checkUsername, isEmail, normaliseUsername } from "../util/username.ts"

/**
 * Claiming a username before launch.
 *
 * A claim is not an account — there is no password and nothing to sign into.
 * It holds a name and an address so the person who wanted it gets it when
 * accounts open. It is a better ask than "join the waitlist" because it costs
 * the visitor a decision rather than a keystroke, and a name someone chose is
 * a name they come back for.
 */
export const claimRoutes = (db: Connection) => {
  const open = pipeline(
    parseJson,
    // Names are finite and first-come. Without a limit one script takes every
    // short name on the site in a minute.
    rateLimit({ db, key: "claims.create", limit: 5, windowSeconds: 3600 }),
  )
  const check = pipeline(rateLimit({ db, key: "claims.check", limit: 60, windowSeconds: 60 }))

  return [
    // Live availability as someone types. Deliberately says nothing about why
    // a name is unavailable: taken, reserved, and held all read the same, so
    // the endpoint cannot be used to map which names are interesting.
    get(
      "/claims/check",
      check(async c => {
        const username = normaliseUsername(String(c.query.username ?? ""))
        if (!username) return json(c, 200, { available: false, status: "unavailable", reason: "" })

        const verdict = checkUsername(username)
        if (!verdict.ok) {
          return json(c, 200, { available: false, status: "unavailable", reason: verdict.reason })
        }

        const claimed = (await db.one(from("claims").where(q => q("username").equals(username)))) as any
        const registered = (await db.one(from("users").where(q => q("username").equals(username)))) as any

        // `status` says nothing the reason strings did not already say — it is
        // there so a caller can branch without matching on English. Taken and
        // unavailable stay apart; reserved and held stay indistinguishable.
        const held = Boolean(claimed || registered)
        return json(c, 200, {
          available: !held,
          status: held ? "taken" : "free",
          reason: held ? "That username is taken." : "",
        })
      }),
    ),

    post(
      "/claims",
      open(async c => {
        const b = c.body as { username?: string; email?: string }
        const username = normaliseUsername(String(b.username ?? ""))
        const email = String(b.email ?? "")
          .trim()
          .toLowerCase()

        if (!isEmail(email)) {
          return json(c, 422, { error: "That address is missing something — check for a typo." })
        }
        const verdict = checkUsername(username, email)
        if (!verdict.ok) return json(c, 422, { error: verdict.reason })

        const takenName =
          (await db.one(from("claims").where(q => q("username").equals(username)))) ||
          (await db.one(from("users").where(q => q("username").equals(username))))
        if (takenName) return json(c, 409, { error: "That username is taken." })

        const existing = (await db.one(from("claims").where(q => q("email").equals(email)))) as any
        if (existing) {
          // One name per address. Saying which name they already hold is fine:
          // they gave us the address, so they can already find out by trying.
          return json(c, 409, {
            error: `That address already claimed @${existing.username}.`,
          })
        }

        await db.execute(from("claims").insert({ username, email }))
        return json(c, 201, { username })
      }),
    ),
  ]
}
