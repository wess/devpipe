import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { currentUser, requireAdmin, requireAuth, requireOwner } from "../auth/guard.ts"
import { asRole, isRole, ROLES } from "../auth/roles.ts"
import * as ocean from "../boxes/digitalocean.ts"
import { activeProvider } from "../providers/index.ts"
import { verifyRunpodToken } from "../providers/runpod.ts"
import type { ProviderKind } from "../providers/types.ts"
import { suspendUser } from "../security/abuse.ts"
import {
  allSettings,
  CREDENTIAL,
  clearCredential,
  credentialHint,
  credentialsSealed,
  getCredential,
  setCredential,
  setSetting,
} from "../settings/index.ts"
import { capState } from "../spend/index.ts"
import { audit } from "../util/audit.ts"
import { shortId } from "../util/token.ts"

/**
 * Running the instance.
 *
 * Split two ways rather than one. `admin` is the day-to-day work — people,
 * boxes, invites, the audit log — and an admin is somebody trusted to deal
 * with an abuse complaint at two in the morning. `owner` is everything that
 * spends money or decides who else may: the provider token, the spending cap,
 * and handing the instance to somebody else.
 *
 * The line is drawn at credentials on purpose. Before there was a middle role,
 * letting anybody help run the instance meant giving them the token that can
 * destroy every box on the account.
 */
export const adminRoutes = (db: Connection) => {
  const owner = pipeline(requireAuth({ db }), requireOwner())
  const ownerJson = pipeline(requireAuth({ db }), requireOwner(), parseJson)
  const admin = pipeline(requireAuth({ db }), requireAdmin())
  const adminJson = pipeline(requireAuth({ db }), requireAdmin(), parseJson)

  const credentialKey = (kind: ProviderKind) => {
    if (kind === "digitalocean") return CREDENTIAL.digitalOceanToken
    if (kind === "runpod") return CREDENTIAL.runpodToken
    return null
  }

  return [
    get(
      "/admin/overview",
      admin(async c => {
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

        const provider = activeProvider()
        const configured = await provider.configured(db)
        let spend = 0
        let providerError: string | null = null
        if (configured) {
          try {
            const machines = await provider.compute.listManaged(db)
            spend = machines.reduce((sum, machine) => sum + machine.monthly, 0)
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
          provider: provider.label,
          provider_configured: configured,
          provider_error: providerError,
        })
      }),
    ),

    /**
     * What this instance is spending, and the ceiling on it.
     *
     * Visible to an admin as well as the owner. Somebody running the instance
     * day to day needs to know whether it is about to stop starting machines,
     * and a number that says what the provider will charge gives away nothing
     * a credential would.
     */
    get(
      "/admin/spend",
      admin(async c => {
        const cap = await capState(db)
        return json(c, 200, {
          cap_cents: cap.capCents,
          spent_cents: cap.spentCents,
          run_rate_cents_per_hour: cap.runRateCentsPerHour,
          used: cap.used,
          warn_at_pct: cap.warnAtPct,
          warning: cap.warning,
          over: cap.over,
          reached_at: cap.reachedAt,
          period_start: cap.periodStart,
        })
      }),
    ),

    get(
      "/admin/users",
      admin(async c => {
        const rows = (await db.all(
          from("users")
            .select("id", "email", "username", "name", "role", "suspended_at", "created_at")
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
          rows.map(r => ({
            ...r,
            role: asRole(r.role),
            is_owner: asRole(r.role) === "owner",
            boxes: byUser.get(r.id) ?? 0,
          })),
        )
      }),
    ),

    patch(
      "/admin/users/:id",
      adminJson(async c => {
        const me = currentUser(c)
        const id = Number(c.params.id)
        const b = c.body as { suspended?: boolean; reason?: string }
        if (id === me.id) {
          return json(c, 422, { error: "You cannot suspend your own account." })
        }
        const row = (await db.one(from("users").where(q => q("id").equals(id)))) as any
        if (!row) return json(c, 404, { error: "No such user." })
        if (row.role === "owner") return json(c, 422, { error: "The owner cannot be suspended." })
        // An admin cannot reach across the role at their own level. Two admins
        // who disagree should not be able to settle it by suspending each
        // other at three in the morning; that is what the owner is for.
        if (row.role === "admin" && me.role !== "owner") {
          return json(c, 403, { error: "Only the owner can suspend another admin." })
        }

        // One suspension path, so the automatic abuse response and the owner
        // pressing the button cannot drift. It writes its own audit row and
        // condemns the account's boxes as well as ending its sessions.
        if (b.suspended) {
          const out = await suspendUser(db, id, String(b.reason ?? "Suspended by an administrator."), me.id)
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

    /**
     * Changing what somebody may do.
     *
     * Owner-only, and it is the one place the owner role moves. Promoting
     * somebody to owner is a *transfer*: the database will not hold two, so
     * this demotes the current owner in the same breath and the caller stops
     * being able to reach this route. Said plainly in the response rather than
     * discovered on the next request.
     */
    patch(
      "/admin/users/:id/role",
      ownerJson(async c => {
        const me = currentUser(c)
        const id = Number(c.params.id)
        const role = String((c.body as any)?.role ?? "")
        if (!isRole(role)) {
          return json(c, 422, { error: `A role is one of: ${ROLES.join(", ")}.` })
        }

        const row = (await db.one(from("users").where(q => q("id").equals(id)))) as any
        if (!row) return json(c, 404, { error: "No such user." })
        if (id === me.id) {
          return json(c, 422, { error: "You cannot change your own role. Hand the instance to somebody else instead." })
        }
        if (row.suspended_at && role !== "user") {
          return json(c, 422, { error: "Restore that account before giving it a role." })
        }
        if (row.role === role) return json(c, 200, { ok: true, role, transferred: false })

        if (role === "owner") {
          // Both halves or neither. A crash between them leaves an instance
          // with no owner at all, which nobody can fix from inside the product
          // — the unique index means the demotion has to land first, and that
          // is exactly the window worth spending a transaction on.
          await db.transaction(async tx => {
            await tx.execute(
              from("users")
                .where(q => q("id").equals(me.id))
                .update({ role: "admin" }),
            )
            await tx.execute(
              from("users")
                .where(q => q("id").equals(id))
                .update({ role: "owner" }),
            )
          })
          await audit(db, me.id, "owner.transferred", `${row.email} — ${me.email} is now an admin`)
          return json(c, 200, { ok: true, role, transferred: true })
        }

        await db.execute(
          from("users")
            .where(q => q("id").equals(id))
            .update({ role }),
        )
        await audit(db, me.id, "user.role", `${row.email} → ${role}`)
        return json(c, 200, { ok: true, role, transferred: false })
      }),
    ),

    get(
      "/admin/settings",
      admin(async c => {
        const me = currentUser(c)
        const settings = await allSettings(db)
        // Read for the hint, and only the owner is shown it. An admin needs to
        // know whether a provider is connected — half the screens are useless
        // otherwise — and has no business knowing which token it is.
        const provider = activeProvider()
        const key = credentialKey(provider.kind)
        const token = key ? await getCredential(db, key) : null
        return json(c, 200, {
          settings,
          can_edit: me.role === "owner",
          provider: {
            kind: provider.kind,
            label: provider.label,
            credential: me.role === "owner" ? credentialHint(token) : token ? "connected" : null,
            configured: await provider.configured(db),
            // Kept for older web clients during the CLI/provider transition.
            digitalocean:
              provider.kind === "digitalocean"
                ? me.role === "owner"
                  ? credentialHint(token)
                  : token
                    ? "connected"
                    : null
                : null,
          },
          // Said rather than assumed. Without DEVPIPE_SECRET_KEY the provider
          // token is stored as typed, and a screen that showed no difference
          // would be implying a protection this instance does not have.
          secrets_sealed: credentialsSealed(),
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
      "/admin/provider",
      ownerJson(async c => {
        const me = currentUser(c)
        const provider = activeProvider()
        if (provider.kind === "docker") {
          return json(c, 409, { error: "Local Docker is configured on the host and does not use an API token." })
        }

        const token = String((c.body as any).token ?? "").trim()
        if (!token) return json(c, 422, { error: "Paste a token." })
        try {
          let account = provider.label
          if (provider.kind === "runpod") {
            await verifyRunpodToken(token)
            await setCredential(db, CREDENTIAL.runpodToken, token)
          } else {
            const verified = await ocean.verifyToken(token)
            account = verified.email
            await setCredential(db, CREDENTIAL.digitalOceanToken, token)
          }
          await audit(db, me.id, "provider.connected", `${provider.label}: ${account}`)
          return json(c, 200, { ok: true, account: { label: account } })
        } catch (err: any) {
          return json(c, 422, { error: String(err?.message ?? `That ${provider.label} credential did not work.`) })
        }
      }),
    ),

    del(
      "/admin/provider",
      owner(async c => {
        const me = currentUser(c)
        const provider = activeProvider()
        const key = credentialKey(provider.kind)
        if (!key) return json(c, 409, { error: "Local Docker does not have a stored provider credential." })

        const liveBoxes = (await db.one(
          from("boxes")
            .where(q => q("provider").equals(provider.kind))
            .where(q => q("provider_id").isNotNull())
            .where(q => q("destroyed_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        const liveWorkspaces = (await db.one(
          from("workspaces")
            .where(q => q("provider").equals(provider.kind))
            .where(q => q("deleted_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        const resources = Number(liveBoxes?.n ?? 0) + Number(liveWorkspaces?.n ?? 0)
        if (resources > 0) {
          return json(c, 409, {
            error: `${provider.label} still has ${resources} managed resource${resources === 1 ? "" : "s"}. Destroy them before disconnecting the credential needed to clean them up.`,
          })
        }
        await clearCredential(db, key)
        await audit(db, me.id, "provider.disconnected", provider.label)
        return json(c, 200, { ok: true })
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
        const liveBoxes = (await db.one(
          from("boxes")
            .where(q => q("provider").equals("digitalocean"))
            .where(q => q("provider_id").isNotNull())
            .where(q => q("destroyed_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        const liveWorkspaces = (await db.one(
          from("workspaces")
            .where(q => q("provider").equals("digitalocean"))
            .where(q => q("deleted_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        const resources = Number(liveBoxes?.n ?? 0) + Number(liveWorkspaces?.n ?? 0)
        if (resources > 0) {
          return json(c, 409, {
            error: `DigitalOcean still has ${resources} managed resource${resources === 1 ? "" : "s"}. Destroy them before disconnecting the credential needed to clean them up.`,
          })
        }
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
      admin(async c => {
        // Two plain lookups rather than a join, for the reason the session
        // path gives: the query builder quotes a dotted alias as one
        // identifier, so `audit.id AS id` reaches Postgres as `"audit.id"` and
        // the whole route answers 500. It did, from the day it was written
        // until an admin was first allowed to open it.
        const rows = (await db.all(
          from("audit")
            .select("id", "user_id", "action", "detail", "created_at")
            .orderBy("created_at", "DESC")
            .limit(200),
        )) as any[]

        const ids = [...new Set(rows.map(r => r.user_id).filter((id: unknown) => id !== null))]
        const people = ids.length
          ? ((await db.all(
              from("users")
                .where(q => q("id").inList(ids))
                .select("id", "email"),
            )) as any[])
          : []
        const emailOf = new Map(people.map(p => [p.id, p.email]))

        return json(
          c,
          200,
          rows.map(r => ({
            id: r.id,
            action: r.action,
            detail: r.detail,
            created_at: r.created_at,
            // Null where the actor was the instance itself — an automatic
            // response to a provider complaint has nobody to name.
            email: emailOf.get(r.user_id) ?? null,
          })),
        )
      }),
    ),

    get(
      "/admin/invites",
      admin(async c => {
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
      adminJson(async c => {
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
      admin(async c => {
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
      admin(async c => {
        const rows = (await db.all(
          from("waitlist").select("id", "email", "created_at").orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows)
      }),
    ),
  ]
}
