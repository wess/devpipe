import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { audit } from "../util/audit.ts"
import { randomToken, sha256Hex } from "../util/token.ts"

/**
 * A terminal on your box, watched by somebody who does not have your box.
 *
 * The case is pair programming, or showing a colleague what an agent is stuck
 * on, or handing the keyboard to whoever actually knows the subsystem. Today
 * the only ways to do that are a screen share — which is a video of a terminal,
 * unselectable and unreadable at any distance — or giving somebody an account
 * and a box of their own, which is not the same session.
 *
 * **The guest never holds the box's token.** Their socket terminates here, and
 * this process holds one socket to the box and copies frames between the two.
 * That hop is the only place read-only can be enforced: the daemon has exactly
 * one credential and it is all-powerful, so a share that handed it over would
 * be a share of the whole machine with a polite request not to type.
 *
 * The owner's own terminal still connects straight to the box, as it always
 * has. A watcher can afford a hop; the person working cannot.
 */

/** What a guest may do. */
export type Mode = "watch" | "control"

export type ShareRow = {
  id: number
  user_id: number
  box_id: number
  session_id: string
  mode: string
  label: string
  expires_at: Date | null
  revoked_at: Date | null
  visits: number
}

const live = (row: ShareRow | null): row is ShareRow => {
  if (!row) return false
  if (row.revoked_at) return false
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false
  return true
}

const byToken = async (db: Connection, token: string) =>
  (await db.one(
    from("shares").where(q => q("token_hash").equals(sha256Hex(token))),
  )) as ShareRow | null

/**
 * The share this request is for, and where its socket should go.
 *
 * Returns null for anything that is not a share socket, so the server can fall
 * through to its ordinary routing.
 */
export const shareSocket = (db: Connection) => async (req: Request) => {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return null
  const url = new URL(req.url)
  // `/api/…` when it arrives through the web tier, `/…` when Caddy sends it
  // straight here. Matched on the tail rather than the whole path so both work.
  const match = /\/shares\/([A-Za-z0-9_-]+)\/socket$/.exec(url.pathname)
  if (!match?.[1]) return null

  const share = await byToken(db, match[1])
  if (!live(share)) return null

  const box = (await db.one(
    from("boxes")
      .where(q => q("id").equals(share.box_id))
      .where(q => q("destroyed_at").isNull()),
  )) as any
  if (!box || box.status !== "ready") return null

  void db
    .execute(
      from("shares")
        .where(q => q("id").equals(share.id))
        .update({ last_seen_at: new Date(), visits: Number(share.visits ?? 0) + 1 }),
    )
    .catch(() => {})
  // Somebody is looking at this box, which is the box being used — a session
  // an owner is showing to a colleague should not be reclaimed underneath
  // them for being idle.
  void db
    .execute(
      from("boxes")
        .where(q => q("id").equals(box.id))
        .update({ last_active_at: new Date() }),
    )
    .catch(() => {})

  return {
    url: `wss://${box.hostname}/v1/sessions/${encodeURIComponent(share.session_id)}/attach?token=${encodeURIComponent(box.agent_token)}`,
    protocol: null as string | null,
    /** Everything travelling towards the box is dropped, including resizes. */
    readOnly: share.mode !== "control",
  }
}

export const shareRoutes = (db: Connection, appUrl: string) => {
  const authed = pipeline(requireAuth({ db }))
  const authedJson = pipeline(requireAuth({ db }), parseJson)

  const shown = (row: ShareRow, token?: string) => ({
    id: row.id,
    box_id: row.box_id,
    session_id: row.session_id,
    mode: row.mode as Mode,
    label: row.label,
    expires_at: row.expires_at,
    visits: row.visits,
    // Only ever on the response that created it. The column holds a hash, so
    // there is nothing to show later even if this wanted to — which is the
    // point: a link nobody can re-read is a link that cannot leak from here.
    url: token ? `${appUrl.replace(/\/$/, "")}/watch/${token}` : null,
  })

  return [
    /**
     * What a guest is about to open, before they open it.
     *
     * Unauthenticated, because the token *is* the authentication — but it
     * deliberately says almost nothing: whose box it is, what is running in it
     * and where it lives are all things a watcher learns by watching, not
     * things a URL should hand to anyone who guesses at one.
     */
    get("/shares/:token", async (c: Conn) => {
      const share = await byToken(db, String(c.params.token))
      if (!live(share)) {
        return json(c, 404, { error: "That link is closed. Ask for a new one." })
      }
      return json(c, 200, {
        mode: share.mode as Mode,
        label: share.label,
        expires_at: share.expires_at,
      })
    }),

    get(
      "/boxes/:id/shares",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("shares")
            .where(q => q("box_id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("revoked_at").isNull()),
        )) as ShareRow[]
        return json(
          c,
          200,
          rows.filter(live).map(row => shown(row)),
        )
      }),
    ),

    post(
      "/boxes/:id/shares",
      authedJson(async c => {
        const me = currentUser(c)
        const b = c.body as { session_id?: string; mode?: string; label?: string; hours?: number }
        const sessionId = String(b.session_id ?? "").trim()
        if (!sessionId) return json(c, 400, { error: "Which terminal?" })

        const box = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull()),
        )) as any
        if (!box) return json(c, 404, { error: "No such box." })

        // Watching is the default, and typing is the thing you have to ask for.
        // A guest who can type has a shell on the machine — that is what a
        // terminal is — so it is never the setting somebody arrives at by not
        // reading the dialog.
        const mode: Mode = b.mode === "control" ? "control" : "watch"
        const hours = Number(b.hours)
        const expires = new Date(
          Date.now() + (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : 8) * 3600_000,
        )
        const token = randomToken()

        const rows = (await db.execute(
          from("shares")
            .insert({
              user_id: me.id,
              box_id: box.id,
              session_id: sessionId,
              token_hash: sha256Hex(token),
              mode,
              label: String(b.label ?? "").slice(0, 80),
              expires_at: expires,
            })
            .returning("id"),
        )) as any[]
        await audit(db, me.id, "share.created", `${box.hostname} ${sessionId} (${mode})`)
        return json(
          c,
          201,
          shown(
            {
              id: Number(rows[0]?.id ?? 0),
              user_id: me.id,
              box_id: box.id,
              session_id: sessionId,
              mode,
              label: String(b.label ?? "").slice(0, 80),
              expires_at: expires,
              revoked_at: null,
              visits: 0,
            },
            token,
          ),
        )
      }),
    ),

    del(
      "/shares/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("shares")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as ShareRow | null
        if (!row) return json(c, 404, { error: "No such share." })
        await db.execute(
          from("shares")
            .where(q => q("id").equals(row.id))
            .update({ revoked_at: new Date() }),
        )
        await audit(db, me.id, "share.revoked", `${row.session_id} on box ${row.box_id}`)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
