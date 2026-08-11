import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { loginShell } from "../util/shell.ts"

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

/**
 * A box that answered, and refused.
 *
 * Distinct from a box that could not be reached, because the two need
 * different words: one is a network problem the user waits out, the other is
 * an answer they can act on.
 */
class BoxRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

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

  // Read as text first. The daemon reports its errors in plain text, and
  // `res.json()` on those threw a SyntaxError that the callers could only
  // report as "that box is not answering" — so a box that had said exactly
  // what was wrong ("No such file or directory (os error 2)", from a tool that
  // was installed but not on the daemon's PATH) was indistinguishable from a
  // box that was switched off. The diagnosis was in the response the whole
  // time, and this is the line that was throwing it away.
  const text = await res.text()
  if (!res.ok) {
    throw new BoxRefused(res.status, text.trim().slice(0, 300) || `The box returned ${res.status}.`)
  }
  return text ? JSON.parse(text) : null
}

/**
 * The one place a box's failure is ever named.
 *
 * The client is told the same sentence whatever went wrong, which is right —
 * "that box is not answering" is all it can act on. But the cause was being
 * discarded at the same moment, so a box that is merely slow, or one whose
 * certificate has not issued yet, left nothing behind to tell it apart from a
 * box that is genuinely down. The journal is where that difference belongs.
 */
const notAnswering = (c: Conn, box: { hostname: string }, path: string, err: unknown) => {
  console.error(`[devpipe] box ${box.hostname} failed ${path}:`, err)
  // What the box said, when it said anything. "That box is not answering" is
  // the right sentence for a box that is unreachable and the wrong one for a
  // box that answered with a reason — it sends someone to check the network
  // over a tool that is not installed.
  if (err instanceof BoxRefused) {
    return json(c, 502, { error: `The box could not do that: ${err.message}` })
  }
  return json(c, 502, { error: "That box is not answering." })
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
        } catch (err) {
          return notAnswering(c, box, "/v1/sessions", err)
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
              argv: loginShell(b.argv ?? [], box.shell),
              cols: Math.min(Math.max(b.cols ?? 100, 20), 500),
              rows: Math.min(Math.max(b.rows ?? 30, 5), 200),
            }),
          })
          return json(c, 201, created)
        } catch (err) {
          return notAnswering(c, box, "POST /v1/sessions", err)
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
        } catch (err) {
          return notAnswering(c, box, `DELETE /v1/sessions/${c.params.sid}`, err)
        }
      }),
    ),
  ]
}
