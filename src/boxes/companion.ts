import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { boxEndpoint } from "../providers/endpoint.ts"

/**
 * Asylum's companion API, reached through the control plane.
 *
 * The box already answers on `https://<hostname>` with a real certificate and
 * its own bearer, and the terminal routes have proxied through it since the
 * beginning. This is the same arrangement for the thing the product is
 * actually about: a project's tasks, and the runs working on them.
 *
 * Everything is forwarded verbatim — path, query, body, status. Nothing here
 * knows what a run is, and it should not: the companion's shapes belong to
 * Asylum and transcribing them here would give them a second home to drift
 * from. The one thing this layer adds is who is asking, which is the whole
 * reason it exists — the browser and the phone hold an account session, and
 * the box's credential never leaves this process.
 *
 * The box side of this is `handle_path /companion/*` to the companion's port,
 * which no box carries yet. Until it does, these routes answer 502 with the
 * sentence the terminal routes use for the same condition.
 */

/**
 * The caller's box, or nothing.
 *
 * Deliberately *not* the `boxFor` the terminal routes use, and the difference
 * is the missing `last_active_at` touch. Reading the run log is not using the
 * box: the clients poll this every second while an agent is working and every
 * thirty while nobody is even looking at the screen, so touching the idle
 * timestamp here would mean a phone left open in a pocket keeps a droplet
 * alive — and being billed — indefinitely. Sending a follow-up is a person
 * doing something, and that one does touch it.
 */
const boxFor = async (db: Connection, userId: number, id: number) =>
  (await db.one(
    from("boxes")
      .where(q => q("id").equals(id))
      .where(q => q("user_id").equals(userId))
      .where(q => q("destroyed_at").isNull()),
  )) as any

const touch = (db: Connection, id: number) => {
  void db
    .execute(
      from("boxes")
        .where(q => q("id").equals(id))
        .update({ last_active_at: new Date() }),
    )
    .catch(() => {})
}

/**
 * Everything after `/companion`, which is what the box is asked for.
 *
 * Taken from the path rather than from a route parameter because the pattern
 * is a wildcard: the router matches the prefix and hands over no tail, and the
 * alternative — a route per companion endpoint — would put this file in the
 * business of tracking Asylum's surface.
 */
const tailOf = (path: string, search: string) => {
  const at = path.indexOf("/companion/")
  const tail = at === -1 ? "" : path.slice(at + "/companion".length)
  return `${tail}${search}`
}

const forward = async (c: any, box: any, method: string, body?: BodyInit) => {
  const target = `${boxEndpoint(box)}/companion${tailOf(c.path, new URL(c.request.url).search)}`
  let res: Response
  try {
    res = await fetch(target, {
      method,
      headers: {
        authorization: `Bearer ${box.agent_token}`,
        // The companion refuses state-changing requests without this. It is a
        // CSRF guard on its own port, and it costs nothing to send always.
        "x-asylum-companion": "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
      signal: AbortSignal.timeout(12_000),
    })
  } catch (err) {
    console.error(`[devpipe] box ${box.hostname} failed ${method} ${target}:`, err)
    return json(c, 502, { error: "That box is not answering." })
  }

  if (res.status === 204) return json(c, 204, null)

  // Read as text first, exactly as the terminal proxy does and for the same
  // reason: a companion that is down behind a proxy answers in HTML, and
  // `res.json()` on that throws a SyntaxError the caller can only report as
  // "not answering" — discarding the one response that said what was wrong.
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    return json(c, 502, {
      error: res.ok
        ? "The box answered with something that is not the companion."
        : `The box could not do that: ${text.trim().slice(0, 300)}`,
    })
  }
  return json(c, res.status, parsed)
}

export const companionRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))

  const resolve = async (c: any) => {
    const me = currentUser(c)
    const box = await boxFor(db, me.id, Number(c.params.id))
    if (!box) return { error: json(c, 404, { error: "No such box." }) }
    if (box.status !== "ready") {
      // Distinct from "not answering". A box that is still building has a
      // known end, and the client says so rather than reporting a fault.
      return { error: json(c, 409, { error: "That box is still being set up." }) }
    }
    return { box }
  }

  return [
    get(
      "/boxes/:id/companion/*",
      authed(async c => {
        const { box, error } = await resolve(c)
        return error ?? (await forward(c, box, "GET"))
      }),
    ),

    // Not `parseJson`: the body is Asylum's, not ours, and re-encoding it here
    // would mean this file has an opinion about shapes it deliberately does
    // not know. It is read once and passed through as bytes.
    post(
      "/boxes/:id/companion/*",
      authed(async c => {
        const { box, error } = await resolve(c)
        if (error) return error
        const body = await c.request.text()
        // A person said something to a run, which is the box being used.
        touch(db, box.id)
        return await forward(c, box, "POST", body)
      }),
    ),
  ]
}
