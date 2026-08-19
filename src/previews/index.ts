import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { consume } from "../security/ratelimit.ts"
import { getSetting, SETTING } from "../settings/index.ts"
import { audit } from "../util/audit.ts"
import { sign, unsign } from "../util/signed.ts"
import { shortId } from "../util/token.ts"

/**
 * A dev server on a box, looked at in a browser, without putting it on the
 * internet.
 *
 * This is the gap between "the agent finished" and "the agent was right".
 * Everything else about a run can be read — a diff, a test run, a log — but a
 * website has to be *used*, and the only ways to do that today are to bind the
 * server to 0.0.0.0 and open the firewall, or to run a tunnel from a laptop
 * that has to stay awake. The first publishes unfinished work under a name
 * that resolves, and leaves it there long after anybody is still looking; the
 * second gives up the one property this product sells, which is that the
 * machine keeps working when you do not.
 *
 * So the preview lives where the box does. Each gets a hostname of its own — a
 * single label under the box domain, so the wildcard record that already exists
 * covers it and Caddy issues its certificate on demand. Requests arrive here
 * and are forwarded to the box's daemon, which is the only thing that ever
 * touches the port.
 *
 * **The URL is not the security.** A private preview needs a cookie this
 * process signed, and it signs one only for a browser carrying a live session
 * belonging to the preview's owner. `link` previews are the deliberate
 * exception, for showing somebody who has no account — and those expire.
 */

/**
 * The capability the app trades a session for.
 *
 * Deliberately not the session. The app holds an `HttpOnly` cookie, so there is
 * nothing in JavaScript to send to another origin — and a value that means "let
 * this browser see preview 41 for the next minute" is a much smaller thing to
 * hand over than one that means "act as this account".
 */
const grantPayload = (previewId: number) => `grant:${previewId}`
const GRANT_TTL = 60

/** How long a granted browser stays admitted before being asked again. */
const COOKIE_TTL = 8 * 3600
const COOKIE = "dp_preview"

/**
 * Ports this will not forward.
 *
 * Only one so far, and it is the important one: the daemon's own. Previewing it
 * would put a box's control surface on a hostname with no bearer in front of
 * it, which is the opposite of everything else here.
 */
const isSensiblePort = (port: number) =>
  Number.isInteger(port) && port > 0 && port < 65536 && port !== 7788

export type PreviewRow = {
  id: number
  user_id: number
  box_id: number
  port: number
  slug: string
  label: string
  audience: string
  expires_at: Date | null
  revoked_at: Date | null
}

const live = (row: PreviewRow | null): row is PreviewRow => {
  if (!row) return false
  if (row.revoked_at) return false
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false
  return true
}

const bySlug = async (db: Connection, slug: string) =>
  (await db.one(from("previews").where(q => q("slug").equals(slug)))) as PreviewRow | null

/**
 * The hostname label for a preview.
 *
 * `p-` prefixed, which is what keeps it clear of the space box hostnames live
 * in: a box is `<username>-<short>`, and a username is at least three
 * characters, so nothing anybody can register produces a first segment of `p`.
 *
 * Twenty-two characters, not ten. For a `link` preview the hostname *is* the
 * credential — there is nothing else between a stranger and somebody's staging
 * site — so it is sized like one: about 104 bits, against the 47 that ten gave.
 * A private preview gets the same, because `audience` can be changed later and
 * a short slug would quietly become the secret at that moment.
 *
 * DNS allows 63 characters in a label, so this costs nothing but the width of a
 * URL nobody types by hand.
 */
const newSlug = () => `p-${shortId(22)}`

export const previewUrl = (slug: string, domain: string) => `https://${slug}.${domain}`

/**
 * The box domain, without a query per asset.
 *
 * A preview serves a page and then thirty requests for its files, and each one
 * would otherwise re-read a settings row that changes approximately never.
 */
let domainCache = { value: "", at: 0 }
const boxDomain = async (db: Connection): Promise<string> => {
  if (domainCache.value && Date.now() - domainCache.at < 60_000) return domainCache.value
  const value = await getSetting(db, SETTING.domain)
  domainCache = { value, at: Date.now() }
  return value
}

/** The label in `<label>.<domain>`, when the host is shaped like a preview. */
const labelOf = (host: string, domain: string): string | null => {
  const bare = host.split(":")[0]?.toLowerCase() ?? ""
  const suffix = `.${domain}`
  if (!domain || !bare.endsWith(suffix)) return null
  const label = bare.slice(0, -suffix.length)
  if (!label.startsWith("p-") || label.includes(".")) return null
  return label
}

/** Whether a hostname names a preview this instance would serve. */
const knows = async (db: Connection, host: string): Promise<boolean> => {
  const label = labelOf(host, await boxDomain(db))
  return label ? live(await bySlug(db, label)) : false
}

// ---- the browser's side ----------------------------------------------------

const cookieFrom = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

/**
 * Whether this browser has been let into *this* preview.
 *
 * The cookie names the preview it was issued for, which is what keeps one
 * admitted browser from being admitted to every other port on the account.
 */
const admitted = (req: Request, preview: PreviewRow): boolean => {
  const presented = cookieFrom(req.headers.get("cookie"), COOKIE)
  return presented ? unsign(presented) === `preview:${preview.id}` : false
}

/** Headers that belong to one connection rather than to the message. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/**
 * The address a request came from, for counting guesses against.
 *
 * The same rule `clientIp` uses and for the same reason: on a request that did
 * not come through Caddy the whole header is attacker-chosen, so only the last
 * hop is trusted and it is truncated before it reaches an index.
 */
const addressOf = (req: Request): string => {
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
  const last = hops[hops.length - 1]
  return last ? last.slice(0, 64) : "unknown"
}

/**
 * Guessing at preview hostnames, counted.
 *
 * Only misses. A preview serves a website, and a single page load is thirty
 * requests — metering those would break the feature to defend nothing, because
 * somebody with a working link already has the thing the limit protects. What
 * is worth counting is the request for a slug that does not exist, which is
 * what a search through the namespace looks like and what a person with a real
 * link almost never produces.
 *
 * This has to be here rather than in the pipeline: the preview host is answered
 * ahead of the router, deliberately — it must not inherit this instance's
 * headers — which means it is also ahead of every rate limiter attached to a
 * route.
 */
const MISS_LIMIT = 60
const MISS_WINDOW = 300

/** Something to look at when the answer is not a dev server's. */
const page = (title: string, body: string, status: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0f1114;color:#c9ccd1;` +
      `display:grid;place-content:center;min-height:100vh;margin:0;text-align:center;padding:2rem}` +
      `h1{font-size:1.05rem;font-weight:600;color:#fff;margin:0 0 .4rem}p{margin:0;color:#8b9099}</style>` +
      `<div><h1>${title}</h1><p>${body}</p></div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  )

/**
 * Everything a preview hostname answers, or null when the Host is not one.
 *
 * Deliberately ahead of the router rather than inside it. A preview is not part
 * of the API — it is a separate origin serving somebody else's application, and
 * it must not inherit this instance's security headers. The app's
 * `Content-Security-Policy` alone would break most dev servers, which inline
 * their client scripts.
 */
export const previewHost = (db: Connection, appUrl: string) => {
  /**
   * A one-minute capability from the app, turned into a cookie for this origin.
   *
   * Cross-origin because it has to be: the app holds the session and this
   * hostname holds the cookie. Same *site* though — both sit under the box
   * domain — so the cookie it sets is sent on the navigation that follows
   * without needing `SameSite=None`.
   *
   * It takes a code rather than the session itself, and that is not a detail.
   * The app's session is an `HttpOnly` cookie now, so there is no token in
   * JavaScript to put in a header — and there should not be. What the app can
   * hand over is a signed value that means one thing, for one preview, for
   * sixty seconds, and is worthless anywhere else.
   */
  const grant = async (req: Request, preview: PreviewRow): Promise<Response> => {
    const origin = appUrl.replace(/\/$/, "")
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "origin",
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    if (req.method !== "POST") return new Response("Not found", { status: 404 })
    if ((req.headers.get("origin") ?? "") !== origin) {
      return Response.json({ error: "Not from there." }, { status: 403, headers: cors })
    }

    const body = (await req.json().catch(() => null)) as { code?: string } | null
    const code = String(body?.code ?? "")
    if (!code || unsign(code) !== grantPayload(preview.id)) {
      return Response.json({ error: "That did not work. Open the preview again." }, {
        status: 403,
        headers: cors,
      })
    }

    return Response.json(
      { ok: true },
      {
        headers: {
          ...cors,
          // Host-only: no Domain attribute, so it is never sent to the app, to
          // a box, or to another preview. HttpOnly, because the thing on the
          // other side of this proxy is somebody's half-written application and
          // it has no business reading what admits a browser to it.
          "set-cookie": `${COOKIE}=${sign(`preview:${preview.id}`, COOKIE_TTL)}; Path=/; Max-Age=${COOKIE_TTL}; HttpOnly; Secure; SameSite=Lax`,
        },
      },
    )
  }

  /** The request, as the dev server on the box will see it. */
  const forward = async (req: Request, preview: PreviewRow, url: URL): Promise<Response> => {
    const box = (await db.one(
      from("boxes")
        .where(q => q("id").equals(preview.box_id))
        .where(q => q("destroyed_at").isNull()),
    )) as any
    if (!box) return page("That box is gone", "The machine this preview pointed at no longer exists.", 404)
    if (box.status === "asleep") {
      return page(
        "That box is asleep",
        "It stood down while nobody was using it. Wake it from the app, then reload this page.",
        503,
      )
    }
    if (box.status !== "ready") {
      return page("That box is not up yet", "It is still being set up. Try again in a minute.", 503)
    }

    const headers = new Headers()
    for (const [name, value] of req.headers) {
      const key = name.toLowerCase()
      if (HOP.has(key) || key === "host" || key === "cookie") continue
      headers.set(name, value)
    }
    // Ours, and only ever meaningful here. Everything the previewed
    // application set for itself goes back to it untouched.
    const cookies = (req.headers.get("cookie") ?? "")
      .split(";")
      .map(part => part.trim())
      .filter(part => part && !part.startsWith(`${COOKIE}=`))
    if (cookies.length) headers.set("cookie", cookies.join("; "))
    headers.set("authorization", `Bearer ${box.agent_token}`)
    // What the browser actually called this origin. The daemon rewrites Host to
    // loopback on the way in — dev servers refuse names they do not recognise —
    // so this is the only record of the real name left for anything generating
    // absolute URLs.
    headers.set("x-forwarded-host", (req.headers.get("host") ?? "").split(":")[0] ?? "")
    headers.set("x-forwarded-proto", "https")

    const target = `https://${box.hostname}/v1/proxy/${preview.port}${url.pathname}${url.search}`
    let res: Response
    try {
      res = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        // Bun wants telling that the body is being read as it is sent.
        ...(req.body ? { duplex: "half" } : {}),
        // A redirect belongs to the browser, not to this hop: following it here
        // would fetch the target from the *box's* view of the URL and hand back
        // a 200 for a page the browser thinks it is still on.
        redirect: "manual",
        // Longer than the API's own 12 seconds. A dev server's first request
        // compiles the application, and half a minute of that is ordinary on a
        // 512MB box — answering 502 through it would report the wrong fault.
        signal: AbortSignal.timeout(60_000),
      } as RequestInit)
    } catch (err) {
      console.error(`[devpipe] preview ${preview.slug} -> ${box.hostname}:${preview.port}:`, err)
      return page("That box is not answering", "It may be restarting. Try again in a moment.", 502)
    }

    void db
      .execute(
        from("previews")
          .where(q => q("id").equals(preview.id))
          .update({ last_seen_at: new Date() }),
      )
      .catch(() => {})

    // A box whose daemon predates `/v1/proxy` answers 404 to every request
    // here, which looks exactly like the dev server having no such route — and
    // sends somebody to debug their own application. Boxes download the daemon
    // at boot, so the fix is to wake it, and this is where to say so.
    if (res.status === 404 && !res.headers.get("x-devpipe-proxy")) {
      return page(
        "That box cannot serve previews yet",
        "It is running a daemon from before previews existed. Put the box to sleep and wake it — it downloads the current one on the way up.",
        502,
      )
    }

    const out = new Headers()
    for (const [name, value] of res.headers) {
      if (!HOP.has(name.toLowerCase()) && name.toLowerCase() !== "x-devpipe-proxy") {
        out.append(name, value)
      }
    }
    // A link preview is unlisted, not secret-by-obscurity, and the difference
    // is whether a crawler that finds the URL anywhere puts somebody's
    // half-finished site in a search index.
    out.set("x-robots-tag", "noindex, nofollow")
    return new Response(res.body, { status: res.status, headers: out })
  }

  /**
   * The preview this request is for, and whether the browser may have it.
   *
   * Shared by both halves below: a websocket upgrade has to answer exactly the
   * same questions as a page request, and answering them twice in two places
   * is how a live-reload socket ends up being the one door with no lock on it.
   */
  const resolve = async (
    req: Request,
  ): Promise<{ preview: PreviewRow } | { refused: Response } | null> => {
    const label = labelOf(req.headers.get("host") ?? "", await boxDomain(db))
    if (!label) return null
    const preview = await bySlug(db, label)
    if (!live(preview)) {
      return {
        refused: page(
          "This preview is closed",
          "The link was revoked or has expired. Ask whoever sent it for a new one.",
          404,
        ),
      }
    }
    if (preview.audience !== "link" && !admitted(req, preview)) {
      const url = new URL(req.url)
      const to = encodeURIComponent(url.pathname + url.search)
      return {
        refused: Response.redirect(`${appUrl.replace(/\/$/, "")}/preview/${preview.slug}?to=${to}`, 302),
      }
    }
    return { preview }
  }

  /**
   * Where a preview's websocket goes on the box.
   *
   * Null for anything that is not one, so the caller can fall through to the
   * ordinary path. The upgrade itself belongs to the server — this only decides
   * whether it may happen and what to dial.
   */
  const socket = async (req: Request): Promise<{ url: string; protocol: string | null } | null> => {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return null
    const found = await resolve(req)
    if (!found || "refused" in found) return null
    const preview = found.preview
    const box = (await db.one(
      from("boxes")
        .where(q => q("id").equals(preview.box_id))
        .where(q => q("destroyed_at").isNull()),
    )) as any
    if (!box || box.status !== "ready") return null
    const url = new URL(req.url)
    const query = url.search ? `${url.search}&` : "?"
    return {
      // The daemon takes its bearer from the query on an upgrade, because a
      // websocket client cannot set a header — and strips it back out before
      // the dev server sees the request.
      url: `wss://${box.hostname}/v1/proxy/${preview.port}${url.pathname}${query}token=${encodeURIComponent(box.agent_token)}`,
      protocol: req.headers.get("sec-websocket-protocol"),
    }
  }

  const handle = async (req: Request): Promise<Response | null> => {
    const label = labelOf(req.headers.get("host") ?? "", await boxDomain(db))
    if (!label) return null

    const preview = await bySlug(db, label)
    if (!live(preview)) {
      const hit = await consume(db, `preview.miss|ip|${addressOf(req)}`, MISS_LIMIT, MISS_WINDOW).catch(
        () => ({ ok: true, count: 0, retryAfter: 0 }),
      )
      if (!hit.ok) {
        return new Response("Too many requests\n", {
          status: 429,
          headers: { "retry-after": String(hit.retryAfter), "content-type": "text/plain" },
        })
      }
      return page(
        "This preview is closed",
        "The link was revoked or has expired. Ask whoever sent it for a new one.",
        404,
      )
    }

    const url = new URL(req.url)
    // The one path this origin keeps for itself, namespaced out of the way of
    // whatever is really running here.
    if (url.pathname === "/__dp/grant") return await grant(req, preview)

    if (preview.audience !== "link" && !admitted(req, preview)) {
      // Not a 401. The person is almost always the owner with a live session in
      // another tab, and the app can turn that into a cookie for this origin
      // without asking them anything at all.
      const to = encodeURIComponent(url.pathname + url.search)
      return Response.redirect(`${appUrl.replace(/\/$/, "")}/preview/${preview.slug}?to=${to}`, 302)
    }

    return await forward(req, preview, url)
  }

  return { handle, socket }
}

// ---- the owner's side ------------------------------------------------------

export const previewRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))
  const authedJson = pipeline(requireAuth({ db }), parseJson)

  const shown = (row: PreviewRow, domain: string) => ({
    id: row.id,
    box_id: row.box_id,
    port: row.port,
    label: row.label,
    audience: row.audience,
    url: previewUrl(row.slug, domain),
    expires_at: row.expires_at,
  })

  return [
    /**
     * Caddy's on-demand TLS check, and the reason previews need no wildcard
     * certificate.
     *
     * Unauthenticated on purpose — Caddy has no credential to offer, and this
     * discloses nothing a request to the hostname would not. Without it,
     * on-demand issuance would let anyone point a name at this address and have
     * a certificate fetched on their behalf, which is how an instance ends up
     * rate-limited by Let's Encrypt over names it has never heard of.
     */
    get("/previews/allow", async (c: Conn) => {
      const ok = await knows(db, String(c.query.domain ?? ""))
      return json(c, ok ? 200 : 404, ok ? { ok: true } : { error: "no such preview" })
    }),

    /**
     * Where a preview actually lives, asked by the app before it admits a
     * browser to it.
     *
     * The redirect that sends somebody here carries only the slug, and the app
     * must not turn a slug in a URL into a hostname it then navigates to —
     * that is an open redirect with extra steps. So it asks, and this answers
     * only for previews belonging to whoever is asking.
     */
    get(
      "/previews/:slug/origin",
      authed(async c => {
        const me = currentUser(c)
        const row = await bySlug(db, String(c.params.slug))
        if (!live(row) || row.user_id !== me.id) {
          return json(c, 404, { error: "No such preview." })
        }
        // Where to go, and the thing that gets you in, in one answer. The code
        // is signed, names one preview, and dies in a minute — long enough for
        // the redirect that follows and short enough that leaving it in a
        // console log costs nothing.
        return json(c, 200, {
          url: previewUrl(row.slug, await boxDomain(db)),
          code: sign(grantPayload(row.id), GRANT_TTL),
        })
      }),
    ),

    get(
      "/boxes/:id/previews",
      authed(async c => {
        const me = currentUser(c)
        const domain = await boxDomain(db)
        const rows = (await db.all(
          from("previews")
            .where(q => q("box_id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("revoked_at").isNull()),
        )) as PreviewRow[]
        return json(
          c,
          200,
          rows.filter(live).map(row => shown(row, domain)),
        )
      }),
    ),

    post(
      "/boxes/:id/previews",
      authedJson(async c => {
        const me = currentUser(c)
        const b = c.body as { port?: number; label?: string; audience?: string; hours?: number }
        const port = Number(b.port)
        if (!isSensiblePort(port)) {
          return json(c, 400, { error: "That is not a port this can forward." })
        }
        const box = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull()),
        )) as any
        if (!box) return json(c, 404, { error: "No such box." })

        const audience = b.audience === "link" ? "link" : "private"
        // A link is a credential somebody can forward, so it gets an end by
        // default. A private preview needs none: it is already bounded by the
        // session that opens it.
        // A week at the outside. A link preview is a public URL serving
        // whatever is on somebody's box from a devpipe.com name, so the ceiling
        // is not about convenience — it is the difference between showing a
        // client a staging site and hosting one. Showing somebody something
        // takes an afternoon; a month is squatting.
        const hours = Number(b.hours)
        const expires =
          audience === "link"
            ? new Date(
                Date.now() +
                  (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : 24) * 3600_000,
              )
            : null
        const label = String(b.label ?? "").slice(0, 80)
        const domain = await boxDomain(db)

        // One preview per port, rather than a pile of forgotten hostnames all
        // pointing at the same dev server. Asking again returns the one that
        // exists, with whatever was asked for this time applied to it.
        const existing = (await db.one(
          from("previews")
            .where(q => q("box_id").equals(box.id))
            .where(q => q("port").equals(port))
            .where(q => q("revoked_at").isNull()),
        )) as PreviewRow | null
        if (live(existing)) {
          await db.execute(
            from("previews")
              .where(q => q("id").equals(existing.id))
              .update({ audience, expires_at: expires, label: label || existing.label }),
          )
          return json(
            c,
            200,
            shown({ ...existing, audience, expires_at: expires, label: label || existing.label }, domain),
          )
        }

        const slug = newSlug()
        const rows = (await db.execute(
          from("previews")
            .insert({
              user_id: me.id,
              box_id: box.id,
              port,
              slug,
              label,
              audience,
              expires_at: expires,
            })
            .returning("id"),
        )) as any[]
        await audit(db, me.id, "preview.created", `${box.hostname}:${port} as ${slug} (${audience})`)
        return json(
          c,
          201,
          shown(
            {
              id: Number(rows[0]?.id ?? 0),
              user_id: me.id,
              box_id: box.id,
              port,
              slug,
              label,
              audience,
              expires_at: expires,
              revoked_at: null,
            },
            domain,
          ),
        )
      }),
    ),

    del(
      "/previews/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("previews")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as PreviewRow | null
        if (!row) return json(c, 404, { error: "No such preview." })
        await db.execute(
          from("previews")
            .where(q => q("id").equals(row.id))
            .update({ revoked_at: new Date() }),
        )
        await audit(db, me.id, "preview.revoked", row.slug)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
