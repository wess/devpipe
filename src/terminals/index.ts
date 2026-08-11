import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"

/**
 * Terminal sessions on a user's box.
 *
 * Listing and creating go through the control plane so the browser never needs
 * the box's credentials for ordinary work. The websocket does *not* — it
 * connects straight to the box, because proxying every keystroke and every
 * byte of output through devpipe.com would put a shared bottleneck on the one
 * interaction that has to feel instant, and would make the control plane a
 * single point of failure for sessions that are supposed to outlive it.
 */

const boxFor = async (db: Connection, userId: number, id: number) =>
  (await db.one(
    from("boxes")
      .where(q => q("id").equals(id))
      .where(q => q("user_id").equals(userId))
      .where(q => q("destroyed_at").isNull()),
  )) as any

const callBox = async (box: any, path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://${box.hostname}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${box.agent_token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 204) return null
  return res.json()
}

export const terminalRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))
  const authedJson = pipeline(requireAuth({ db }), parseJson)

  return [
    // What the client needs to open a socket to the box itself.
    get(
      "/boxes/:id/connection",
      authed(async c => {
        const me = currentUser(c)
        const box = await boxFor(db, me.id, Number(c.params.id))
        if (!box) return json(c, 404, { error: "No such box." })
        if (box.status !== "ready") {
          return json(c, 409, { error: "That box is still being set up." })
        }
        return json(c, 200, {
          url: `wss://${box.hostname}`,
          // The box's own bearer. It reaches one box, which belongs to the
          // person asking, and it is useless anywhere else — but it is
          // long-lived, so the client must keep it in memory and never in
          // localStorage where any injected script could read it.
          token: box.agent_token,
        })
      }),
    ),

    get(
      "/boxes/:id/sessions",
      authed(async c => {
        const me = currentUser(c)
        const box = await boxFor(db, me.id, Number(c.params.id))
        if (!box) return json(c, 404, { error: "No such box." })
        if (box.status !== "ready") return json(c, 200, [])
        try {
          return json(c, 200, (await callBox(box, "/v1/sessions")) ?? [])
        } catch {
          return json(c, 502, { error: "That box is not answering." })
        }
      }),
    ),

    post(
      "/boxes/:id/sessions",
      authedJson(async c => {
        const me = currentUser(c)
        const box = await boxFor(db, me.id, Number(c.params.id))
        if (!box) return json(c, 404, { error: "No such box." })
        if (box.status !== "ready") {
          return json(c, 409, { error: "That box is still being set up." })
        }
        const b = c.body as { argv?: string[]; cols?: number; rows?: number }
        try {
          const created = await callBox(box, "/v1/sessions", {
            method: "POST",
            body: JSON.stringify({
              argv: b.argv ?? [],
              cols: Math.min(Math.max(b.cols ?? 100, 20), 500),
              rows: Math.min(Math.max(b.rows ?? 30, 5), 200),
            }),
          })
          return json(c, 201, created)
        } catch {
          return json(c, 502, { error: "That box is not answering." })
        }
      }),
    ),

    del(
      "/boxes/:id/sessions/:sid",
      authed(async c => {
        const me = currentUser(c)
        const box = await boxFor(db, me.id, Number(c.params.id))
        if (!box) return json(c, 404, { error: "No such box." })
        try {
          await callBox(box, `/v1/sessions/${encodeURIComponent(String(c.params.sid))}`, {
            method: "DELETE",
          })
          return json(c, 200, { ok: true })
        } catch {
          return json(c, 502, { error: "That box is not answering." })
        }
      }),
    ),
  ]
}
