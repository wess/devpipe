import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { rateLimit } from "../security/ratelimit.ts"

const isEmail = (s: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254

/** The lander's early-access form. */
export const waitlistRoutes = (db: Connection) => {
  // No email dimension: the address is the thing being stored, so counting it
  // twice buys nothing. Twenty rather than five because the lander is the
  // busiest page on the instance and an office shares one address.
  const join = pipeline(parseJson, rateLimit({ db, key: "waitlist", limit: 20, windowSeconds: 3600 }))

  return [
    post(
      "/waitlist",
      join(async c => {
        const email = String((c.body as any)?.email ?? "")
          .trim()
          .toLowerCase()
        if (!isEmail(email)) {
          return json(c, 422, { error: "That address is missing something — check for a typo." })
        }

        const existing = (await db.one(from("waitlist").where(q => q("email").equals(email)))) as any
        if (!existing) {
          await db.execute(from("waitlist").insert({ email }))
        }
        // A repeat signup gets the same answer as a new one. Telling someone
        // they already registered leaks who is on the list to anyone who asks.
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
