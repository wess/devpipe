import { randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth, requireOwner } from "../auth/guard.ts"
import * as ocean from "../boxes/digitalocean.ts"
import { forgetGpuSizes, forgetRegionNames } from "../boxes/gpu.ts"
import { activeProvider } from "../providers/index.ts"
import { verifyRunpodToken } from "../providers/runpod.ts"
import { rateLimit } from "../security/ratelimit.ts"
import {
  CREDENTIAL,
  credentialsSealed,
  getCredential,
  getSetting,
  SETTING,
  setCredential,
  setSetting,
} from "../settings/index.ts"
import { audit } from "../util/audit.ts"

/**
 * First launch.
 *
 * Everything here was already possible from the admin screens — this is the
 * same settings and the same credentials, put in the order somebody installing
 * this for the first time actually needs them, with each step checked against
 * the provider before it is accepted.
 *
 * The checking is the point rather than the ordering. Every one of these has a
 * failure mode that surfaces hours later as something that looks unrelated:
 *
 *  - a domain whose DNS is not on the provider account gives boxes that build
 *    perfectly, never resolve and never get a certificate
 *  - no SSH key means the first box that wedges during setup cannot be looked
 *    at, which is exactly when you need to
 *  - no `DEVPIPE_SECRET_KEY` means the provider token that can destroy every
 *    box on the account is sitting in the database as text, and nothing says so
 *  - no spend cap means the machine somebody forgot about is discovered on an
 *    invoice
 *
 * Each is a question with an answer, asked once, at the moment the person has
 * the provider's console open in another tab.
 */

export type StepId = "owner" | "secret" | "provider" | "domain" | "keys" | "cap" | "done"

type Step = {
  readonly id: StepId
  readonly title: string
  readonly done: boolean
  /** Whether the instance can run boxes at all without this. */
  readonly required: boolean
  readonly detail: string
}

/**
 * Where the instance is up to.
 *
 * Readable without signing in while nobody owns it — an unclaimed instance is
 * already announcing that through `/auth/state`, and the alternative is a
 * wizard nobody can open. The moment an owner exists it needs their session,
 * because from then on it names what the provider account can do.
 */
export const setupState = async (db: Connection) => {
  const people = (await db.one(from("users").select("COUNT(*) AS n"))) as any
  const claimed = Number(people?.n ?? 0) > 0

  const digitalOceanToken = await getCredential(db, CREDENTIAL.digitalOceanToken)
  const domain = (await getSetting(db, SETTING.domain)).trim()
  const keys = (await getSetting(db, SETTING.sshKeyIds))
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const cap = Number(await getSetting(db, SETTING.spendCapCents)) || 0
  const acknowledged = (await getSetting(db, SETTING.setupComplete)) === "1"
  const provider = activeProvider()

  // Asked of the provider rather than assumed from the setting, because the
  // setting is just a string somebody typed and the failure it causes is
  // invisible until a box is already built.
  let domainOnAccount = false
  let account: { email: string; dropletLimit: number } | null = null
  let providerError: string | null = null
  let providerConfigured = false
  if (provider.kind === "docker" || provider.kind === "runpod") {
    try {
      providerConfigured = await provider.configured(db)
      if (!providerConfigured) {
        providerError =
          provider.kind === "docker"
            ? "Docker is not running, or the devpipe-box:local image has not been built."
            : "Runpod needs a valid API key and DEVPIPE_RUNPOD_IMAGE pointing at a published Devpipe box image."
      } else {
        account = { email: provider.kind === "docker" ? "local Docker" : "Runpod", dropletLimit: 0 }
      }
      domainOnAccount = providerConfigured
    } catch (err: any) {
      providerError = String(err?.message ?? err)
    }
  } else if (digitalOceanToken) {
    try {
      const who = await ocean.verifyToken(digitalOceanToken)
      account = { email: who.email, dropletLimit: who.dropletLimit }
      providerConfigured = true
      if (domain) domainOnAccount = await ocean.hasDomain(digitalOceanToken, domain)
    } catch (err: any) {
      providerError = String(err?.message ?? err)
    }
  }

  const steps: Step[] = [
    {
      id: "owner",
      title: "Claim the instance",
      done: claimed,
      required: true,
      detail: "The first account registered becomes the owner, and there is only ever one.",
    },
    {
      id: "secret",
      title: "Encrypt the credentials",
      done: credentialsSealed(),
      required: false,
      detail:
        "Without DEVPIPE_SECRET_KEY the provider token is stored as plain text, and a copy of the database is a copy of it.",
    },
    {
      id: "provider",
      title:
        provider.kind === "docker"
          ? "Start local Docker"
          : provider.kind === "runpod"
            ? "Connect Runpod"
            : "Connect DigitalOcean",
      done: providerConfigured && !providerError,
      required: true,
      detail:
        provider.kind === "docker"
          ? "Docker is running and the local box image is available."
          : provider.kind === "runpod"
            ? "The API key and published box image are both checked before a Pod can be created."
            : "The token that creates and destroys boxes. It never leaves this instance.",
    },
    {
      id: "domain",
      title: "Point a domain at it",
      done: provider.kind !== "digitalocean" ? true : Boolean(domain) && domainOnAccount,
      required: provider.kind === "digitalocean",
      detail:
        provider.kind !== "digitalocean"
          ? "This provider supplies a direct daemon endpoint, so per-box DNS is not required."
          : "Boxes are reached at a name under this domain, and its DNS has to be on the same provider account.",
    },
    {
      id: "keys",
      title: "Add an SSH key",
      done: provider.kind !== "digitalocean" || keys.length > 0,
      required: false,
      detail: "The only way onto a box that wedges while it is being built.",
    },
    {
      id: "cap",
      title: "Set a spending cap",
      done: cap > 0,
      required: false,
      detail: "What this instance may spend at the provider in a month before it stops starting machines.",
    },
  ]

  const blocking = steps.filter(s => s.required && !s.done)
  return {
    claimed,
    complete: blocking.length === 0 && acknowledged,
    // Separate from `complete`: everything needed to make a box works, whether
    // or not anybody has read the last screen.
    usable: blocking.length === 0,
    acknowledged,
    steps,
    account,
    provider_error: providerError,
    domain,
    domain_on_account: domainOnAccount,
    ssh_key_count: keys.length,
    spend_cap_cents: cap,
    sealed: credentialsSealed(),
    provider: provider.kind,
  }
}

export const setupRoutes = (db: Connection) => {
  const owner = pipeline(requireAuth({ db }), requireOwner())
  const ownerJson = pipeline(requireAuth({ db }), requireOwner(), parseJson)
  // Each of these spends a call on the provider's quota and the unclaimed
  // branch takes no session at all, so it is the one route here anybody can
  // reach. A fresh instance is looked at a handful of times, not hundreds.
  const state = pipeline(rateLimit({ db, key: "setup.state", limit: 120, windowSeconds: 600 }))

  return [
    get(
      "/setup/state",
      state(async c => {
        const people = (await db.one(from("users").select("COUNT(*) AS n"))) as any
        if (Number(people?.n ?? 0) > 0) {
          // Claimed, so it is the owner's business and nobody else's. Handled
          // here rather than with a pipeline because the same URL has to answer
          // both before and after there is anybody to authenticate.
          const guarded = owner(async inner => json(inner, 200, await setupState(db)))
          return guarded(c)
        }
        return json(c, 200, await setupState(db))
      }),
    ),

    /**
     * A key for the operator to paste into the environment file.
     *
     * Generated here and deliberately not stored: the whole point of it is to
     * live somewhere the database does not, because it is what encrypts the
     * database's credentials. An instance that kept a copy would be encrypting
     * a lock with the key left inside it.
     */
    get(
      "/setup/secret",
      owner(async c =>
        json(c, 200, {
          // Standard base64, not base64url: this is read back by
          // `secretbox.ts`, which decodes 32 bytes of base64 and says so in
          // the error when it does not get them.
          key: randomBytes(32).toString("base64"),
          sealed: credentialsSealed(),
          path: "/etc/devpipe.env",
          restart_required: true,
        }),
      ),
    ),

    post(
      "/setup/provider",
      ownerJson(async c => {
        const me = currentUser(c)
        const token = String((c.body as any)?.token ?? "").trim()
        if (!token) return json(c, 422, { error: "Paste a token." })

        const provider = activeProvider()
        if (provider.kind === "runpod") {
          try {
            await verifyRunpodToken(token)
          } catch (err: any) {
            return json(c, 422, { error: String(err?.message ?? "That Runpod key did not work.") })
          }
          await setCredential(db, CREDENTIAL.runpodToken, token)
          await audit(db, me.id, "provider.connected", "Runpod")
          return json(c, 200, {
            ok: true,
            account: { email: "Runpod", dropletLimit: 0, status: "active" },
            domains: [],
          })
        }
        if (provider.kind === "docker") {
          return json(c, 409, { error: "Local Docker does not use an API token." })
        }

        let account: { email: string; dropletLimit: number; status: string }
        try {
          account = await ocean.verifyToken(token)
        } catch (err: any) {
          return json(c, 422, { error: String(err?.message ?? "That token did not work.") })
        }

        await setCredential(db, CREDENTIAL.digitalOceanToken, token)
        // The size and region catalogues are per-account, and the old ones
        // belong to whatever token was there before.
        forgetGpuSizes()
        forgetRegionNames()
        await audit(db, me.id, "provider.connected", account.email)

        let domains: string[] = []
        try {
          domains = await ocean.listDomains(token)
        } catch {
          // Not fatal. The next step asks for a domain and checks it properly;
          // this list only saves somebody typing.
        }
        return json(c, 200, { ok: true, account, domains })
      }),
    ),

    /**
     * The domain, checked against the provider before it is believed.
     *
     * This is the step that repays the whole wizard. A domain registered
     * somewhere else, or one whose nameservers were never pointed here, builds
     * boxes that come up fine and cannot be reached — and every symptom of it
     * points somewhere else: a certificate that never arrives, a daemon that
     * looks dead, a client that times out.
     */
    post(
      "/setup/domain",
      ownerJson(async c => {
        const me = currentUser(c)
        const domain = String((c.body as any)?.domain ?? "")
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
          return json(c, 422, { error: "That is not a domain name." })
        }

        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        if (!token) return json(c, 409, { error: "Connect a provider first." })

        let onAccount = false
        try {
          onAccount = await ocean.hasDomain(token, domain)
        } catch (err: any) {
          return json(c, 502, { error: String(err?.message ?? "Could not ask the provider about that domain.") })
        }
        if (!onAccount) {
          return json(c, 422, {
            error: `${domain} is not on this DigitalOcean account. Add it under Networking → Domains and point the registrar's nameservers at ns1.digitalocean.com, then try again — boxes are reached at names under it, and the records are written there.`,
          })
        }

        await setSetting(db, SETTING.domain, domain)
        await audit(db, me.id, "settings.changed", `domain ${domain}`)
        return json(c, 200, { ok: true, domain })
      }),
    ),

    get(
      "/setup/ssh-keys",
      owner(async c => {
        const token = await getCredential(db, CREDENTIAL.digitalOceanToken)
        if (!token) return json(c, 409, { error: "Connect a provider first." })
        try {
          const keys = await ocean.listSshKeys(token)
          const chosen = (await getSetting(db, SETTING.sshKeyIds))
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
          return json(c, 200, { keys, chosen })
        } catch (err: any) {
          return json(c, 502, { error: String(err?.message ?? "Could not read the account's keys.") })
        }
      }),
    ),

    post(
      "/setup/ssh-keys",
      ownerJson(async c => {
        const me = currentUser(c)
        const ids = (Array.isArray((c.body as any)?.ids) ? (c.body as any).ids : [])
          .map((n: unknown) => Number(n))
          .filter((n: number) => Number.isFinite(n) && n > 0)
        await setSetting(db, SETTING.sshKeyIds, ids.join(","))
        await audit(db, me.id, "settings.changed", `ssh keys ${ids.length}`)
        return json(c, 200, { ok: true, count: ids.length })
      }),
    ),

    post(
      "/setup/cap",
      ownerJson(async c => {
        const me = currentUser(c)
        const cents = Math.round(Number((c.body as any)?.cents ?? 0))
        if (!Number.isFinite(cents) || cents < 0) {
          return json(c, 422, { error: "A cap is a number of cents, or 0 for none." })
        }
        await setSetting(db, SETTING.spendCapCents, String(cents))
        await audit(db, me.id, "settings.changed", `spend cap ${cents}`)
        return json(c, 200, { ok: true, cents })
      }),
    ),

    /**
     * Marks the wizard as read.
     *
     * Refuses while anything required is still missing, so "finished" cannot
     * mean an instance that will fail at the first box. Everything optional is
     * genuinely optional — a smaller instance can decline a spend cap, and it
     * is told plainly what that means rather than being blocked over it.
     */
    post(
      "/setup/finish",
      ownerJson(async c => {
        const me = currentUser(c)
        const state = await setupState(db)
        if (!state.usable) {
          const missing = state.steps.filter(s => s.required && !s.done).map(s => s.title)
          return json(c, 409, { error: `Still to do: ${missing.join(", ")}.` })
        }
        await setSetting(db, SETTING.setupComplete, "1")
        await audit(db, me.id, "setup.finished", state.domain)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
