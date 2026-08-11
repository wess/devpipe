import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post, putHeader, text } from "@atlas/server"
import { currentUser, requireAuth, requireOwner } from "../auth/guard.ts"
import { broadcastEmail, type Emailer } from "../email/index.ts"
import { audit } from "../util/audit.ts"

/**
 * Writing to everyone who claimed a name.
 *
 * Two things shape this. A send cannot be taken back, so a broadcast is a
 * stored draft that has to be sent deliberately and confirmed by subject —
 * a stray click should not reach every address you have. And a send that dies
 * halfway must not double-mail anyone on a retry, so recipients are recorded
 * in `broadcast_recipients` as they go and a resume skips them. That second
 * part was described here long before anything implemented it; the table and
 * the budget below are what make it true.
 */

export type Audience = "claims" | "waitlist" | "users" | "all"

/**
 * How long one send request will work for before reporting back.
 *
 * Well inside the server's two-minute idle timeout, because the alternative to
 * stopping deliberately is being cut off — and being cut off mid-list is how a
 * broadcast ends up half-sent with nothing recording where it got to.
 */
const SEND_BUDGET_MS = 45_000

const recipientsFor = async (db: Connection, audience: Audience): Promise<string[]> => {
  const out = new Set<string>()
  const add = (rows: any[]) => {
    for (const r of rows) if (r?.email) out.add(String(r.email).toLowerCase())
  }
  if (audience === "claims" || audience === "all") {
    add((await db.all(from("claims").select("email"))) as any[])
  }
  if (audience === "waitlist" || audience === "all") {
    add((await db.all(from("waitlist").select("email"))) as any[])
  }
  if (audience === "users" || audience === "all") {
    add((await db.all(from("users").select("email"))) as any[])
  }
  return [...out]
}

export const broadcastRoutes = (db: Connection, emailer: Emailer, appUrl: string) => {
  const owner = pipeline(requireAuth({ db }), requireOwner())
  const ownerJson = pipeline(requireAuth({ db }), requireOwner(), parseJson)

  return [
    get(
      "/admin/broadcasts",
      owner(async c => {
        const rows = (await db.all(
          from("broadcasts")
            .select("id", "subject", "audience", "sent_count", "failed_count", "sent_at", "created_at")
            .orderBy("created_at", "DESC")
            .limit(50),
        )) as any[]
        const counts = {
          claims: (await recipientsFor(db, "claims")).length,
          waitlist: (await recipientsFor(db, "waitlist")).length,
          users: (await recipientsFor(db, "users")).length,
          all: (await recipientsFor(db, "all")).length,
        }
        return json(c, 200, { broadcasts: rows, counts })
      }),
    ),

    post(
      "/admin/broadcasts",
      ownerJson(async c => {
        const me = currentUser(c)
        const b = c.body as { subject?: string; body?: string; audience?: Audience }
        const subject = String(b.subject ?? "")
          .trim()
          .slice(0, 160)
        const body = String(b.body ?? "").trim()
        const audience: Audience = (["claims", "waitlist", "users", "all"] as const).includes(b.audience as Audience)
          ? (b.audience as Audience)
          : "claims"

        if (!subject) return json(c, 422, { error: "Give it a subject." })
        if (body.length < 10) return json(c, 422, { error: "Write something to send." })

        const rows = (await db.execute(
          from("broadcasts").insert({ subject, body, audience, sent_by: me.id }).returning("id", "subject", "audience"),
        )) as any[]
        return json(c, 201, rows[0])
      }),
    ),

    // A preview goes only to the owner's own address, so what everyone else
    // will see has been seen by somebody first.
    post(
      "/admin/broadcasts/:id/preview",
      owner(async c => {
        const me = currentUser(c)
        const row = (await db.one(from("broadcasts").where(q => q("id").equals(Number(c.params.id))))) as any
        if (!row) return json(c, 404, { error: "No such broadcast." })
        const rendered = broadcastEmail({
          subject: row.subject,
          body: row.body,
          siteUrl: appUrl,
          preview: true,
        })
        await emailer.send({ to: me.email, ...rendered })
        return json(c, 200, { ok: true, to: me.email })
      }),
    ),

    post(
      "/admin/broadcasts/:id/send",
      ownerJson(async c => {
        const me = currentUser(c)
        const row = (await db.one(from("broadcasts").where(q => q("id").equals(Number(c.params.id))))) as any
        if (!row) return json(c, 404, { error: "No such broadcast." })
        if (row.sent_at) return json(c, 409, { error: "That broadcast has already been sent." })

        // Typing the subject back is the confirmation. A send reaches every
        // address at once and cannot be recalled; a button alone is too small
        // a gesture for that.
        const confirm = String((c.body as any)?.confirm ?? "").trim()
        if (confirm !== row.subject) {
          return json(c, 422, {
            error: "Type the subject exactly to confirm. Sending cannot be undone.",
          })
        }

        // Everyone this broadcast has already reached, successfully or not.
        // Read once rather than per address: the list is small enough to hold
        // and a query per recipient would double the time a send takes.
        const already = new Set(
          (
            (await db.all(
              from("broadcast_recipients")
                .where(q => q("broadcast_id").equals(row.id))
                .select("email"),
            )) as any[]
          ).map(r => String(r.email)),
        )

        const to = await recipientsFor(db, row.audience as Audience)
        const pending = to.filter(address => !already.has(address))

        let sent = 0
        let failed = 0
        const startedAt = Date.now()
        let ranOut = false

        for (const address of pending) {
          // Bounded, because sending is sequential and the server drops a
          // request that has moved no bytes for two minutes. A list long
          // enough to hit that used to produce a half-sent broadcast still
          // marked as a draft; now it produces a partial send that says so and
          // resumes exactly where it stopped.
          if (Date.now() - startedAt > SEND_BUDGET_MS) {
            ranOut = true
            break
          }

          let delivered = 1
          try {
            await emailer.send({
              to: address,
              ...broadcastEmail({ subject: row.subject, body: row.body, siteUrl: appUrl }),
            })
            sent++
          } catch {
            // One bad address must not stop the rest of the send. It is still
            // recorded, so a resume does not spend the whole budget retrying
            // the same dead mailbox.
            delivered = 0
            failed++
          }

          // Written per address, immediately. Batching this at the end would
          // reintroduce the exact failure the table exists to prevent.
          await db.execute(from("broadcast_recipients").insert({ broadcast_id: row.id, email: address, delivered }))
        }

        const remaining = pending.length - sent - failed
        const done = remaining === 0

        await db.execute(
          from("broadcasts")
            .where(q => q("id").equals(row.id))
            .update({
              // Counted across every attempt, not just this one.
              sent_count: Number(row.sent_count ?? 0) + sent,
              failed_count: Number(row.failed_count ?? 0) + failed,
              // Only once there is nobody left. A broadcast with addresses
              // still to reach has to stay resumable, and `sent_at` is what
              // the send route refuses on.
              sent_at: done ? new Date() : null,
            }),
        )
        await audit(
          db,
          me.id,
          done ? "broadcast.sent" : "broadcast.partial",
          `${row.subject} -> ${sent} sent, ${failed} failed, ${remaining} left`,
        )
        return json(c, 200, { sent, failed, remaining, done, skipped: already.size, out_of_time: ranOut })
      }),
    ),

    del(
      "/admin/broadcasts/:id",
      owner(async c => {
        const row = (await db.one(from("broadcasts").where(q => q("id").equals(Number(c.params.id))))) as any
        if (!row) return json(c, 404, { error: "No such broadcast." })
        if (row.sent_at) return json(c, 409, { error: "A sent broadcast is kept as a record." })
        await db.execute(
          from("broadcasts")
            .where(q => q("id").equals(row.id))
            .del(),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    get(
      "/admin/claims",
      owner(async c => {
        const rows = (await db.all(
          from("claims").select("id", "username", "email", "redeemed_at", "created_at").orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows)
      }),
    ),

    // The list, as a file. A launch usually means moving it somewhere else.
    get(
      "/admin/claims.csv",
      owner(async c => {
        const rows = (await db.all(
          from("claims").select("username", "email", "created_at").orderBy("created_at", "ASC"),
        )) as any[]
        const quote = (v: string) => `"${String(v).replace(/"/g, '""')}"`
        const csv = [
          "username,email,claimed_at",
          ...rows.map(r => [r.username, r.email, r.created_at].map(quote).join(",")),
        ].join("\n")
        return putHeader(
          putHeader(text(c, 200, csv), "content-type", "text/csv; charset=utf-8"),
          "content-disposition",
          'attachment; filename="devpipe-claims.csv"',
        )
      }),
    ),
  ]
}
