import { hash, verify } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, pipeline, post, putHeader } from "@atlas/server"
import { isDisposableEmail } from "../security/abuse.ts"
import { clientIp, rateLimit, submittedEmail } from "../security/ratelimit.ts"
import { getSetting, SETTING } from "../settings/index.ts"
import { audit } from "../util/audit.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { checkUsername, isEmail, normaliseUsername } from "../util/username.ts"
import { clearedCookie, sessionCookie } from "./cookie.ts"
import { agentClass } from "./fingerprint.ts"
import { requireAuth } from "./guard.ts"
import { asRole } from "./roles.ts"

const SESSION_DAYS = 30

const expiry = () => new Date(Date.now() + SESSION_DAYS * 86_400_000)

export const startSession = async (db: Connection, userId: number, conn: any) => {
  const token = randomToken()
  await db.execute(
    from("sessions").insert({
      user_id: userId,
      token_hash: sha256Hex(token),
      user_agent: (conn.headers.get("user-agent") ?? "").slice(0, 255),
      // The program and the kind of machine, without versions. Checked on every
      // request afterwards: a session is held by one client for its whole life,
      // and a replayed token is almost always presented by a different one.
      agent_class: agentClass(conn.headers.get("user-agent")),
      // The right-hand end of x-forwarded-for, not the left: Caddy appends the
      // peer it saw, so the left-most entry is whatever the client felt like
      // sending — and this address is what an abuse report gets worked back
      // from.
      ip: clientIp(conn),
      expires_at: expiry(),
    }),
  )
  return token
}

/**
 * The session, handed over both ways at once.
 *
 * The cookie is what a browser will use, and it cannot read it. The token in the
 * body is what the CLI keeps in the system keychain, where no web page can
 * reach it. The web client simply ignores the string and uses the cookie.
 */
const withSession = (c: any, status: number, token: string, user: unknown) =>
  json(putHeader(c, "set-cookie", sessionCookie(token)), status, { token, user })

const publicUser = (row: any) => ({
  id: row.id,
  email: row.email,
  username: row.username,
  name: row.name,
  role: asRole(row.role),
  // Kept alongside the role because every client already branches on it, and
  // because it is the question most of them are actually asking.
  is_owner: asRole(row.role) === "owner",
})

export const authRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))

  // Both limiters sit after `parseJson`, or `submittedEmail` has nothing to
  // read and the whole thing degrades to counting the address alone.
  //
  // Ten sign-ins per address per five minutes leaves room for a shared office
  // address; the per-email bucket is deliberately looser, because anyone who
  // knows an address can spend its budget and lock that person out.
  const login = pipeline(
    parseJson,
    rateLimit({ db, key: "auth.login", limit: 10, windowSeconds: 300, subject: submittedEmail, subjectLimit: 30 }),
  )
  // No email dimension: the address on a registration is new every time, so
  // the bucket would count nothing and cost a write. Three an hour is enough
  // for somebody fixing a rejected form twice, and registration is the door to
  // creating a box.
  const register = pipeline(parseJson, rateLimit({ db, key: "auth.register", limit: 3, windowSeconds: 3600 }))

  return [
    // Tells the sign-in page whether to offer "create the owner account" or an
    // ordinary sign-in, without exposing anything about who exists.
    get("/auth/state", async c => {
      const row = (await db.one(from("users").select("COUNT(*) AS n"))) as any
      const needsOwner = Number(row?.n ?? 0) === 0
      return json(c, 200, {
        needs_owner: needsOwner,
        setup_token_required: needsOwner && Boolean(process.env.DEVPIPE_SETUP_TOKEN),
        // Lets the sign-in page ask for a code up front, instead of letting
        // someone fill in a whole form only to be refused at the end.
        invite_required: !needsOwner && (await getSetting(db, SETTING.signupsOpen)) !== "1",
      })
    }),

    post(
      "/auth/register",
      register(async c => {
        const b = c.body as {
          email?: string
          username?: string
          name?: string
          password?: string
          invite?: string
          setup_token?: string
        }
        const email = b.email?.trim().toLowerCase() ?? ""
        const username = normaliseUsername(b.username ?? "")
        const password = b.password ?? ""

        if (!isEmail(email)) return json(c, 422, { error: "That email address looks wrong." })
        // The first account too. Claiming a whole instance — the one account
        // nobody else can recover — with an address that expires in ten
        // minutes is a mistake worth refusing.
        if (isDisposableEmail(email)) {
          return json(c, 422, {
            error: "Use an address you can receive mail at. Throwaway addresses are not accepted.",
          })
        }
        const verdict = checkUsername(username, email)
        if (!verdict.ok) return json(c, 422, { error: verdict.reason })
        if (password.length < 12) return json(c, 422, { error: "Use at least 12 characters." })

        // The gate. Registering leads straight to creating a box, and a box
        // costs the instance owner money the moment it exists — so an open
        // instance is an open tab. The first account is exempt: somebody has
        // to be able to claim a fresh instance.
        const existing = (await db.one(from("users").select("COUNT(*) AS n"))) as any
        const isFirst = Number(existing?.n ?? 0) === 0
        const setupToken = process.env.DEVPIPE_SETUP_TOKEN ?? ""
        if (isFirst && setupToken && String(b.setup_token ?? "") !== setupToken) {
          return json(c, 403, { error: "That setup token is not valid." })
        }
        let invite: any = null
        if (!isFirst) {
          const open = (await getSetting(db, SETTING.signupsOpen)) === "1"
          const code = String((b as any).invite ?? "").trim()
          if (!open) {
            if (!code) {
              return json(c, 403, { error: "Signups are invite-only right now." })
            }
            invite = (await db.one(from("invites").where(q => q("code").equals(code)))) as any
            if (!invite || invite.used_at) {
              return json(c, 403, { error: "That invite code is not valid." })
            }
          }
        }

        // A pre-launch claim holds the name for the address that claimed it.
        // Handing it to whoever registers first would make claiming worthless.
        const claim = (await db.one(from("claims").where(q => q("username").equals(username)))) as any
        if (claim && claim.email !== email) {
          return json(c, 409, { error: "That username is taken." })
        }

        const taken = (await db.one(from("users").where(q => q("email").equals(email)))) as any
        const takenName = (await db.one(from("users").where(q => q("username").equals(username)))) as any
        if (taken) return json(c, 409, { error: "That email is already registered." })
        if (takenName) return json(c, 409, { error: "That username is taken." })

        // First account in is the owner. There is no other way to become one
        // except a deliberate transfer from the owner themselves, which is what
        // makes a fresh instance claimable exactly once.
        const isOwner = isFirst

        const rows = (await db.execute(
          from("users")
            .insert({
              email,
              username,
              name: b.name?.trim().slice(0, 80) || username,
              password: await hash(password),
              role: isOwner ? "owner" : "user",
            })
            .returning("id", "email", "username", "name", "role"),
        )) as any[]

        const user = rows[0]
        // Burn the invite only once the account exists, so a failed insert
        // does not consume it.
        if (invite) {
          await db.execute(
            from("invites")
              .where(q => q("id").equals(invite.id))
              .update({ used_by: user.id, used_at: new Date() }),
          )
        }
        if (claim) {
          await db.execute(
            from("claims")
              .where(q => q("id").equals(claim.id))
              .update({ redeemed_at: new Date() }),
          )
        }
        const token = await startSession(db, user.id, c)
        await audit(db, user.id, isOwner ? "owner.claimed" : "user.registered", email)
        return withSession(c, 201, token, publicUser(user))
      }),
    ),

    post(
      "/auth/login",
      login(async c => {
        const b = c.body as { email?: string; password?: string }
        const email = b.email?.trim().toLowerCase() ?? ""
        const row = (await db.one(from("users").where(q => q("email").equals(email)))) as any

        // One message whether the address is unknown or the password is wrong,
        // so this cannot be used to enumerate who has an account.
        const bad = () => json(c, 401, { error: "That email and password do not match." })
        if (!row) {
          // Still spend the time a real verification costs.
          await verify("not-a-real-password", await hash(randomToken()))
          return bad()
        }
        if (!(await verify(b.password ?? "", row.password))) return bad()
        if (row.suspended_at) {
          return json(c, 403, { error: "This account has been suspended." })
        }

        const token = await startSession(db, row.id, c)
        return withSession(c, 200, token, publicUser(row))
      }),
    ),

    post(
      "/auth/logout",
      authed(async c => {
        // Whatever the request presented, header or cookie. Reading the header
        // back would end nothing at all for a browser, which no longer sends
        // one — and "signed out" that leaves the session alive is the worst
        // possible answer to that button.
        const hash = ((c as any).assigns.session as { hash: string } | undefined)?.hash
        if (hash) {
          await db.execute(
            from("sessions")
              .where(q => q("token_hash").equals(hash))
              .del(),
          )
        }
        return json(putHeader(c, "set-cookie", clearedCookie()), 200, { ok: true })
      }),
    ),

    get(
      "/auth/me",
      authed(async c => json(c, 200, { user: (c as any).assigns.auth })),
    ),
  ]
}
