import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth, requireOwner } from "../auth/guard.ts"
import * as ocean from "../boxes/digitalocean.ts"
import { suspendUser } from "../security/abuse.ts"
import {
  allSettings,
  CREDENTIAL,
  clearCredential,
  credentialHint,
  getCredential,
  setCredential,
  setSetting,
} from "../settings/index.ts"
import { audit } from "../util/audit.ts"
import { shortId } from "../util/token.ts"

/** Everything only the instance owner can see or change. */
export const adminRoutes = (db: Connection) => {
  const owner = pipeline(requireAuth({ db }), requireOwner())
  const ownerJson = pipeline(requireAuth({ db }), requireOwner(), parseJson)

  return [
    get(
      "/admin/overview",
      owner(async c => {
        const one = async (sql: any) => Number(((await db.one(sql)) as any)?.n ?? 0)
        const users = await one(from("users").select("COUNT(*) AS n"))
        const boxes = await one(
          from("boxes")
            .where(q => q("destroyed_at").isNull())
            .select("COUNT(*) AS n"),
        )
        const waitlist = await one(from("waitlist").select("COUNT(*) AS n"))
        const suspended = await one(
          from("users")
            .where(q => q("suspended_at").isNotNull())
            .select("COUNT(*) AS n"),
        )

        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        let spend = 0
        let providerError: string | null = null
        if (token) {
          try {
            const droplets = await ocean.listDroplets(token)
            spend = droplets.reduce((sum, d) => sum + d.monthly, 0)
          } catch (err: any) {
            providerError = String(err?.message ?? err)
          }
        }

        return json(c, 200, {
          users,
          boxes,
          waitlist,
          suspended,
          monthly_spend: spend,
          provider_configured: Boolean(token),
          provider_error: providerError,
        })
      }),
    ),

    get(
      "/admin/users",
      owner(async c => {
        const rows = (await db.all(
          from("users")
            .select("id", "email", "username", "name", "is_owner", "suspended_at", "created_at")
            .orderBy("created_at", "DESC"),
        )) as any[]
        // Box counts in the same shape the list renders, so the admin screen
        // does not have to make N follow-up requests.
        const counts = (await db.all(
          from("boxes")
            .where(q => q("destroyed_at").isNull())
            .select("user_id", "COUNT(*) AS n")
            .groupBy("user_id"),
        )) as any[]
        const byUser = new Map(counts.map(r => [r.user_id, Number(r.n)]))
        return json(
          c,
          200,
          rows.map(r => ({ ...r, is_owner: Boolean(r.is_owner), boxes: byUser.get(r.id) ?? 0 })),
        )
      }),
    ),

    patch(
      "/admin/users/:id",
      ownerJson(async c => {
        const me = currentUser(c)
        const id = Number(c.params.id)
        const b = c.body as { suspended?: boolean; reason?: string }
        if (id === me.id) {
          return json(c, 422, { error: "You cannot suspend your own account." })
        }
        const row = (await db.one(from("users").where(q => q("id").equals(id)))) as any
        if (!row) return json(c, 404, { error: "No such user." })
        if (row.is_owner) return json(c, 422, { error: "The owner cannot be suspended." })

        // One suspension path, so the automatic abuse response and the owner
        // pressing the button cannot drift. It writes its own audit row and
        // condemns the account's boxes as well as ending its sessions.
        if (b.suspended) {
          const out = await suspendUser(db, id, String(b.reason ?? "Suspended by the instance owner."), me.id)
          if (!out.ok) return json(c, 422, { error: out.error })
          return json(c, 200, { ok: true, sessions: out.sessions, boxes: out.boxes })
        }

        // Restoring does not un-condemn boxes: by the time an account comes
        // back the machines may already be gone.
        await db.execute(
          from("users")
            .where(q => q("id").equals(id))
            .update({ suspended_at: null }),
        )
        await audit(db, me.id, "user.restored", row.email)
        return json(c, 200, { ok: true })
      }),
    ),

    get(
      "/admin/settings",
      owner(async c => {
        const settings = await allSettings(db)
        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        return json(c, 200, {
          settings,
          provider: { digitalocean: credentialHint(token) },
        })
      }),
    ),

    patch(
      "/admin/settings",
      ownerJson(async c => {
        const me = currentUser(c)
        const b = c.body as Record<string, string>
        for (const [key, value] of Object.entries(b)) {
          await setSetting(db, key, String(value))
        }
        await audit(db, me.id, "settings.changed", Object.keys(b).join(","))
        return json(c, 200, await allSettings(db))
      }),
    ),

    post(
      "/admin/provider/digitalocean",
      ownerJson(async c => {
        const me = currentUser(c)
        const token = String((c.body as any).token ?? "").trim()
        if (!token) return json(c, 422, { error: "Paste a token." })

        // Verified before it is stored. Saving a token that does not work and
        // finding out at the first provision is a worse failure than being
        // told now.
        try {
          const account = await ocean.verifyToken(token)
          await setCredential(db, CREDENTIAL.digitalOceanToken, token)
          await audit(db, me.id, "provider.connected", account.email)
          return json(c, 200, { ok: true, account })
        } catch (err: any) {
          return json(c, 422, { error: String(err?.message ?? "That token did not work.") })
        }
      }),
    ),

    del(
      "/admin/provider/digitalocean",
      owner(async c => {
        const me = currentUser(c)
        await clearCredential(db, CREDENTIAL.digitalOceanToken)
        await audit(db, me.id, "provider.disconnected")
        return json(c, 200, { ok: true })
      }),
    ),

    // Every box on the account, not just this instance's — a droplet Devpipe
    // does not know about is still on the bill.
    get(
      "/admin/droplets",
      owner(async c => {
        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        if (!token) return json(c, 200, { droplets: [], configured: false })
        try {
          const droplets = await ocean.listDroplets(token)
          const known = (await db.all(
            from("boxes")
              .where(q => q("destroyed_at").isNull())
              .select("provider_id"),
          )) as any[]
          const ours = new Set(known.map(r => String(r.provider_id)))
          return json(c, 200, {
            configured: true,
            droplets: droplets.map(d => ({ ...d, managed: ours.has(String(d.id)) })),
          })
        } catch (err: any) {
          return json(c, 502, { error: String(err?.message ?? err) })
        }
      }),
    ),

    get(
      "/admin/audit",
      owner(async c => {
        const rows = (await db.all(
          from("audit")
            .join("users", "audit.user_id", "users.id")
            .select(
              "audit.id AS id",
              "audit.action AS action",
              "audit.detail AS detail",
              "audit.created_at AS created_at",
              "users.email AS email",
            )
            .orderBy("audit.created_at", "DESC")
            .limit(200),
        )) as any[]
        return json(c, 200, rows)
      }),
    ),

    get(
      "/admin/invites",
      owner(async c => {
        const rows = (await db.all(
          from("invites")
            .select("id", "code", "note", "used_by", "used_at", "created_at")
            .orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows)
      }),
    ),

    post(
      "/admin/invites",
      ownerJson(async c => {
        const me = currentUser(c)
        const note = String((c.body as any)?.note ?? "").slice(0, 120)
        // `shortId`, not `Math.random`. Same readable alphabet, but backed by
        // the CSPRNG: an invite is the only way past a closed signup gate, and
        // registering leads straight to creating a box that costs the owner
        // money. V8's generator is seeded state, and a handful of observed
        // outputs is enough to predict the rest — one invite handed to the
        // wrong person should not be a key to the others.
        const code = shortId(10)
        await db.execute(from("invites").insert({ code, note, created_by: me.id }))
        await audit(db, me.id, "invite.created", note)
        return json(c, 201, { code, note })
      }),
    ),

    del(
      "/admin/invites/:id",
      owner(async c => {
        const id = Number(c.params.id)
        const row = (await db.one(from("invites").where(q => q("id").equals(id)))) as any
        if (!row) return json(c, 404, { error: "No such invite." })
        if (row.used_at) return json(c, 409, { error: "That invite has already been used." })
        await db.execute(
          from("invites")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    get(
      "/admin/waitlist",
      owner(async c => {
        const rows = (await db.all(
          from("waitlist").select("id", "email", "created_at").orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows)
      }),
    ),
  ]
}
