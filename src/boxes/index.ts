import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { attachSubscription, releaseSubscription, requireSubscriptionForBox } from "../billing/index.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { CREDENTIAL, getCredential, getSetting, SETTING } from "../settings/index.ts"
import { audit } from "../util/audit.ts"
import { isShell, SHELLS, type ShellName } from "../util/shell.ts"
import { randomToken, shortId } from "../util/token.ts"
import { CATALOG, defaults, fits, REGIONS, resolve, SIZES } from "./catalog.ts"
import { cloudInit } from "./cloudinit.ts"
import * as ocean from "./digitalocean.ts"

const publicBox = (row: any) => ({
  id: row.id,
  name: row.name,
  hostname: row.hostname,
  region: row.region,
  size: row.size,
  status: row.status,
  status_detail: row.status_detail,
  ip: row.ip,
  shell: row.shell ?? "bash",
  tools: safeTools(row.manifest),
  created_at: row.created_at,
  ready_at: row.ready_at,
})

const safeTools = (manifest: string): string[] => {
  try {
    return JSON.parse(manifest || "{}").tools ?? []
  } catch {
    return []
  }
}

export const boxRoutes = (db: Connection, appUrl: string) => {
  const authed = pipeline(requireAuth({ db }))

  // `requireAuth` first, or `signedInUser` has no user to read and every
  // customer shares whatever address bucket they land in.
  //
  // Five boxes per user per hour. The per-user limit on live boxes says
  // nothing about churn, and create-destroy-create is where the money leaks: a
  // droplet is billed from the moment it exists. The address number is far
  // above it on purpose — a carrier puts tens of thousands of subscribers
  // behind one address, and the iPad app is a first-class client here.
  const createBox = pipeline(
    requireAuth({ db }),
    parseJson,
    rateLimit({ db, key: "boxes.create", limit: 200, windowSeconds: 3600, subject: signedInUser, subjectLimit: 5 }),
  )
  // A box posts its setup output every few seconds while cloud-init runs, and
  // each box has its own address. 120 a minute is far more than a real setup
  // produces; the per-request line cap bounds one write, this bounds how many
  // a wedged or hostile box can make.
  const callback = pipeline(parseJson, rateLimit({ db, key: "boxes.callback", limit: 120, windowSeconds: 60 }))

  return [
    // What the wizard renders. Served rather than hardcoded in the client so
    // web and iOS cannot drift apart on what a box can be built with.
    get(
      "/boxes/catalog",
      authed(async c =>
        json(c, 200, {
          tools: CATALOG.map(({ install, ...rest }) => rest),
          sizes: SIZES,
          regions: REGIONS,
          defaults: defaults(),
        }),
      ),
    ),

    get(
      "/boxes",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("boxes")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull())
            .orderBy("created_at", "DESC"),
        )) as any[]
        return json(c, 200, rows.map(publicBox))
      }),
    ),

    get(
      "/boxes/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })
        return json(c, 200, publicBox(row))
      }),
    ),

    post(
      "/boxes",
      createBox(async c => {
        const me = currentUser(c)
        const b = c.body as { name?: string; region?: string; size?: string; tools?: string[]; shell?: string }

        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        if (!token) {
          return json(c, 503, {
            error: "No provider is configured yet. The instance owner needs to add one.",
          })
        }

        const limit = Number(await getSetting(db, SETTING.boxLimitPerUser))
        const mine = (await db.one(
          from("boxes")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("destroyed_at").isNull())
            .select("COUNT(*) AS n"),
        )) as any
        if (Number(mine?.n ?? 0) >= limit) {
          return json(c, 409, { error: `You already have ${limit} boxes.` })
        }

        const name = (b.name ?? "").trim().slice(0, 40) || "box"
        const region = REGIONS.find(r => r.slug === b.region)?.slug ?? (await getSetting(db, SETTING.defaultRegion))
        const size = SIZES.find(s => s.slug === b.size)?.slug ?? (await getSetting(db, SETTING.defaultSize))
        const shell = isShell(String(b.shell ?? "")) ? String(b.shell) : "bash"
        // The shell is a tool as far as the build is concerned. Choosing zsh
        // and not installing it leaves an account whose login shell does not
        // exist, so the selection carries its own package rather than trusting
        // the client to have ticked the right box.
        const wanted = [...(b.tools ?? defaults())]
        const shellTool = SHELLS[shell as ShellName].tool
        if (shellTool && !wanted.includes(shellTool)) wanted.push(shellTool)
        const tools = resolve(wanted).map(t => t.id)

        // Before the memory check, so somebody without a subscription is told
        // that rather than being told about memory first. 402 rather than 403:
        // it is payment that is missing, and the client needs to tell those
        // apart to know whether to offer a checkout link.
        const gate = await requireSubscriptionForBox(db, me.id, size)
        if (!gate.ok) return json(c, 402, { error: gate.reason })

        // Refuse a build that would be killed by the OOM killer later. The
        // failure it prevents looks like a random disconnect mid-task, which
        // is far harder to diagnose than being told no now.
        const room = fits(tools, size)
        if (!room.ok) {
          return json(c, 422, {
            error: `That selection needs about ${room.needed} MB and this size has ${room.available} MB. Pick a larger box or fewer tools.`,
          })
        }

        const domain = await getSetting(db, SETTING.domain)
        const host = `${me.username}-${shortId(5)}`
        const hostname = `${host}.${domain}`
        const agentToken = randomToken()

        const rows = (await db.execute(
          from("boxes")
            .insert({
              user_id: me.id,
              name,
              hostname,
              shell,
              region,
              size,
              status: "creating",
              agent_token: agentToken,
              manifest: JSON.stringify({ tools, size, region }),
            })
            .returning("id"),
        )) as any[]
        const boxId = rows[0].id

        // Claimed the moment the row exists. Two requests can pass the gate on
        // the same free subscription before either attaches, and the one that
        // loses must not end up with a box. Deleted rather than marked failed:
        // nothing has been provisioned, so there is nothing to look at after.
        if (gate.subscriptionId && !(await attachSubscription(db, gate.subscriptionId, boxId))) {
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(boxId))
              .del(),
          )
          return json(c, 402, { error: "That subscription is already covering another box." })
        }

        try {
          // Before the droplet, not after: the firewall is attached by tag, so
          // it has to exist by the time a droplet carrying that tag does.
          // Creating the box first would leave it briefly reachable on every
          // port while cloud-init runs as root — which is the window an
          // opportunistic scanner is actually looking for.
          //
          // Inside the try deliberately. If this fails the box is marked failed
          // and the subscription released; a box that could not be firewalled
          // is not a box we should be handing to anyone.
          await ocean.ensureBoxFirewall(token)

          const droplet = await ocean.createDroplet(token, {
            name: hostname,
            region,
            size,
            userData: cloudInit({
              hostname,
              agentToken,
              tools,
              daemonUrl: await getSetting(db, SETTING.daemonUrl),
              callbackUrl: `${appUrl}/api/boxes/callback`,
              logUrl: `${appUrl}/api/boxes/callback/log`,
              callbackSecret: agentToken,
              shell,
            }),
            // Without a key nobody can get onto a box that wedges during
            // setup — the first real provisioning run hung and there was no
            // way to look at it.
            sshKeyIds: (await getSetting(db, SETTING.sshKeyIds))
              .split(",")
              .map(s => Number(s.trim()))
              .filter(n => Number.isFinite(n) && n > 0),
            tags: ["devpipe", `user-${me.id}`],
          })

          await db.execute(
            from("boxes")
              .where(q => q("id").equals(boxId))
              .update({ provider_id: String(droplet.id), status: "installing" }),
          )
          await audit(db, me.id, "box.created", hostname)

          // DNS is what makes the certificate possible, so it happens as soon
          // as there is an address to point at — before the box has finished
          // installing, because Caddy will want it the moment it starts.
          void settleAddress(db, token, boxId, droplet.id, domain, host)

          return json(c, 201, { id: boxId, hostname, status: "installing" })
        } catch (err: any) {
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(boxId))
              .update({ status: "failed", status_detail: String(err?.message ?? err).slice(0, 200) }),
          )
          // A box that never came up must not hold a subscription hostage.
          await releaseSubscription(db, boxId)
          return json(c, 502, { error: String(err?.message ?? "Could not create that box.") })
        }
      }),
    ),

    del(
      "/boxes/:id",
      authed(async c => {
        const me = currentUser(c)
        const row = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!row) return json(c, 404, { error: "No such box." })

        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        if (token && row.provider_id) {
          try {
            await ocean.destroyDroplet(token, Number(row.provider_id))
          } catch (err) {
            console.error("destroy failed", err)
          }
          const domain = await getSetting(db, SETTING.domain)
          try {
            await ocean.deleteRecord(token, domain, row.hostname.replace(`.${domain}`, ""))
          } catch (err) {
            console.error("dns cleanup failed", err)
          }
        }

        await db.execute(
          from("boxes")
            .where(q => q("id").equals(row.id))
            .update({ status: "destroyed", destroyed_at: new Date() }),
        )
        // Frees the subscription for the next box. It does not cancel it —
        // that is the Stripe portal, and the two are deliberately separate.
        await releaseSubscription(db, row.id)
        await audit(db, me.id, "box.destroyed", row.hostname)
        return json(c, 200, { ok: true })
      }),
    ),

    // Setup output, newest last. `after` lets the client poll for only what it
    // has not seen, so a long build does not re-send its whole history every
    // few seconds.
    get(
      "/boxes/:id/events",
      authed(async c => {
        const me = currentUser(c)
        const box = (await db.one(
          from("boxes")
            .where(q => q("id").equals(Number(c.params.id)))
            .where(q => q("user_id").equals(me.id)),
        )) as any
        if (!box) return json(c, 404, { error: "No such box." })

        const after = Number(c.query.after ?? 0)
        const rows = (await db.all(
          from("box_events")
            .where(q => q("box_id").equals(box.id))
            .where(q => q("id").greaterThan(Number.isFinite(after) ? after : 0))
            .select("id", "phase", "line", "at")
            .orderBy("id", "ASC")
            .limit(500),
        )) as any[]
        return json(c, 200, { status: box.status, detail: box.status_detail, events: rows })
      }),
    ),

    // The box streams its setup output here while cloud-init runs.
    post(
      "/boxes/callback/log",
      callback(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const b = c.body as { hostname?: string; phase?: string; text?: string }
        if (!presented || !b.hostname) return json(c, 400, { error: "bad callback" })

        const box = (await db.one(from("boxes").where(q => q("hostname").equals(b.hostname!)))) as any
        if (!box || box.agent_token !== presented) return json(c, 403, { error: "no" })

        // Bounded per request and per line: this is the one endpoint a box can
        // post to freely, and an unbounded write is a way to fill the disk.
        const lines = String(b.text ?? "")
          .split("\n")
          .map(l => l.replace(/\s+$/, "").slice(0, 500))
          .filter(l => l.length > 0)
          .slice(0, 400)

        for (const line of lines) {
          await db.execute(
            from("box_events").insert({
              box_id: box.id,
              phase: String(b.phase ?? "").slice(0, 40),
              line,
            }),
          )
        }
        // Surfaces the current step in the box list without reading the log.
        if (b.phase) {
          await db.execute(
            from("boxes")
              .where(q => q("id").equals(box.id))
              .update({ status_detail: String(b.phase).slice(0, 60) }),
          )
        }
        return json(c, 200, { ok: true, stored: lines.length })
      }),
    ),

    // The box reports in when cloud-init finishes. Authenticated with the
    // box's own agent token, which only that box and this server know.
    post(
      "/boxes/callback",
      callback(async c => {
        const presented = (c.headers.get("authorization") ?? "").slice(7).trim()
        const b = c.body as { hostname?: string; failed?: string }
        if (!presented || !b.hostname) return json(c, 400, { error: "bad callback" })

        const row = (await db.one(from("boxes").where(q => q("hostname").equals(b.hostname!)))) as any
        if (!row || row.agent_token !== presented) return json(c, 403, { error: "no" })

        const failed = (b.failed ?? "")
          .replace(/FAILED:\s*/g, "")
          .split(",")
          .filter(Boolean)
        await db.execute(
          from("boxes")
            .where(q => q("id").equals(row.id))
            .update({
              status: "ready",
              ready_at: new Date(),
              status_detail: failed.length ? `Some tools did not install: ${failed.join(", ")}` : "",
            }),
        )
        await audit(db, row.user_id, "box.ready", row.hostname)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}

/**
 * Polls until the droplet has a public address, then points DNS at it.
 *
 * Runs detached from the request that created the box: a droplet takes tens of
 * seconds to get an address and nobody should watch a spinner for it.
 */
const settleAddress = async (
  db: Connection,
  token: string,
  boxId: number,
  dropletId: number,
  domain: string,
  host: string,
) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 5_000))

    // Bail if the box went away while we were waiting. Without this check a
    // box destroyed mid-provision has its DNS record written *after* the
    // destroy already removed it — leaving a name pointing at an address that
    // has gone back into the provider's pool, and will eventually belong to
    // somebody else's machine.
    const still = (await db.one(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .where(q => q("destroyed_at").isNull()),
    )) as any
    if (!still) return

    const droplet = await ocean.getDroplet(token, dropletId)
    if (!droplet?.ip) continue
    try {
      await ocean.upsertRecord(token, domain, host, droplet.ip)
      await db.execute(
        from("boxes")
          .where(q => q("id").equals(boxId))
          .update({ ip: droplet.ip }),
      )
    } catch (err) {
      console.error("dns for", host, err)
    }
    return
  }
  await db.execute(
    from("boxes")
      .where(q => q("id").equals(boxId))
      .update({ status: "failed", status_detail: "The provider never gave this box an address." }),
  )
}
