import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { open, seal, secretsAvailable } from "../util/secretbox.ts"

/**
 * Instance settings and provider credentials.
 *
 * They live in separate tables on purpose: a careless `SELECT *` on settings
 * is a bug, and the same query on credentials is an incident. Keeping them
 * apart means the read that renders an admin screen cannot reach the token
 * that can destroy every box on the account.
 */

export const SETTING = {
  signupsOpen: "signups_open",
  domain: "boxes_domain",
  defaultRegion: "boxes_default_region",
  defaultSize: "boxes_default_size",
  boxLimitPerUser: "boxes_limit_per_user",
  daemonUrl: "daemon_url",
  /** The `devpipe` CLI and MCP server a box downloads alongside the daemon. */
  cliUrl: "cli_url",
  sshKeyIds: "boxes_ssh_key_ids",
  /**
   * Addresses allowed to reach port 22 on a box, comma separated, as CIDR.
   *
   * The control plane's own address is always allowed and does not need listing.
   * This is for the second place an operator wants to reach a wedged box from —
   * a home or office address — and it is worth nothing to a customer, because
   * the keys on a box are the ones in `boxes_ssh_key_ids` and those are the
   * instance's, not theirs.
   *
   * Empty is the normal state. Getting it wrong locks nobody out permanently:
   * the control plane is still allowed, and this converges hourly.
   */
  sshSources: "boxes_ssh_sources",
  /** Gigabytes a box may send in an hour before it is worth a look. */
  egressLimitGb: "boxes_egress_limit_gb",
  /**
   * Gigabytes a box may send in a day before it is worth a look.
   *
   * The hourly limit catches a burst and is blind to patience. A box relaying
   * at a fortieth of that rate never trips it and still moves a terabyte a day,
   * which is the shape of a proxy rather than a seedbox.
   */
  egressDailyGb: "boxes_egress_daily_gb",
  /**
   * Provider image new boxes are built from. Empty means the plain base image
   * and a full install on first boot, which is the correct fallback: a missing
   * or deleted snapshot must produce a slow box, never a broken one.
   */
  boxImage: "boxes_image",
  /** Tool ids baked into that image, so cloud-init knows what to skip. */
  boxImageTools: "boxes_image_tools",
  /**
   * Hours a box may sit unused before it is reclaimed. 0 disables it.
   *
   * Only ever applies to boxes carrying a workspace — see `reclaim.ts`.
   */
  idleHours: "boxes_idle_hours",
  /**
   * Idle hours for a box belonging to anybody but the owner. Falls back to
   * `idleHours`.
   *
   * Separate because the right answer can differ. The person running the
   * instance usually wants their own machine where they left it; somebody
   * else's experiment costs them money for every hour it lingers.
   */
  freeIdleHours: "boxes_free_idle_hours",
  /**
   * Gigabytes of workspace given to a box that asked for none. 0 disables.
   *
   * Not generosity — reclaim only ever touches boxes carrying a workspace,
   * because a box without one holds the only copy of what is on it. A box with
   * no workspace can therefore never be reclaimed, which is exactly backwards:
   * the machines nobody is watching are the ones that most need to sleep.
   */
  freeWorkspaceGb: "boxes_free_workspace_gb",
  /**
   * Days a free box may stay asleep before it and its workspace are deleted.
   * 0 disables, which is the default: this throws away somebody's files.
   */
  dormantDays: "boxes_dormant_days",
  /**
   * Whether GPU sizes appear in the wizard at all. Off by default.
   *
   * The cheapest GPU box is a hundred times the hourly cost of the cheapest
   * CPU one, so this is not a switch that should default to on because the
   * code supporting it shipped. Even switched on, a GPU box is an admin's to
   * create — the bill lands on whoever installed this.
   */
  gpuEnabled: "boxes_gpu_enabled",
  /**
   * Hours a GPU box may sit unused before it is slept. Minimum one.
   *
   * Unlike `idleHours` this cannot be turned off. An idle CPU box is four
   * dollars a month of somebody's patience; an idle H100 is four dollars an
   * hour, and the machine that ran a job on Friday and was forgotten is the
   * normal case rather than the unlucky one.
   */
  gpuIdleHours: "boxes_gpu_idle_hours",
  /**
   * The most this instance may spend at the provider in a calendar month, in
   * cents. 0 is no cap, which is the default.
   *
   * The provider's own prices, with no margin — this answers "what will
   * DigitalOcean charge me", which is the question somebody self-hosting is
   * actually asking. Past it, nothing new starts and what is running is put to
   * sleep.
   */
  spendCapCents: "billing_spend_cap_cents",
  /** How far into the cap before the instance starts saying so, as a percentage. */
  spendWarnPct: "billing_spend_warn_pct",
  /**
   * Whether the owner has been through the setup wizard.
   *
   * Only ever a record that somebody read the last screen. What decides
   * whether the instance can actually make a box is the preconditions
   * themselves, checked against the provider — this flag never gates anything
   * except whether the wizard opens by itself.
   */
  setupComplete: "setup_complete",
} as const

const DEFAULTS: Record<string, string> = {
  [SETTING.signupsOpen]: "0",
  [SETTING.domain]: "devpipe.com",
  [SETTING.defaultRegion]: "nyc3",
  [SETTING.defaultSize]: "s-1vcpu-512mb-10gb",
  [SETTING.boxLimitPerUser]: "3",
  // Roughly a gigabit link held for an hour. Nothing a developer does by
  // accident, and well under what a seedbox does deliberately.
  [SETTING.egressLimitGb]: "200",
  // Not the hourly figure times 24, which would be 4.8TB and catch nothing.
  // The worst honest day on a box — a large dataset pulled a few times, a day
  // of pushing container images — is under 200GB, so this sits a few times
  // above real work and an order of magnitude below a machine that is relaying
  // for somebody.
  [SETTING.egressDailyGb]: "500",
  [SETTING.boxImage]: "",
  [SETTING.boxImageTools]: "",
  // Off until somebody turns it on. Reclaiming a box is the right economics and
  // the wrong surprise, so it is never the default on an instance that has not
  // been told how long "idle" means.
  [SETTING.idleHours]: "0",
  // Falls back to idleHours when 0, so an instance that sets one number gets
  // one behaviour rather than a silent second policy.
  [SETTING.freeIdleHours]: "0",
  // One gigabyte, which is the smallest a volume can be and about ten cents a
  // month — enough that a trial keeps its work, cheap enough to be given away.
  [SETTING.freeWorkspaceGb]: "1",
  // Off. Deleting a workspace destroys files somebody may still want, and that
  // is not a thing to start doing because a default said so.
  [SETTING.dormantDays]: "0",
  // Off. The owner turns GPU on deliberately, having decided what a customer
  // may spend per hour on their provider account.
  [SETTING.gpuEnabled]: "0",
  // An hour. Long enough that a coffee break does not cost a rebuild, short
  // enough that a forgotten H100 is four dollars rather than seventy.
  [SETTING.gpuIdleHours]: "1",
  // Off. A cap that arrived by default would sleep somebody's boxes over a
  // number they never chose, and the instance this ships from has a business
  // reason to spend. The setup wizard asks for one, which is where a
  // self-hoster meets it.
  [SETTING.spendCapCents]: "0",
  [SETTING.spendWarnPct]: "80",
  [SETTING.setupComplete]: "0",
  [SETTING.daemonUrl]: "https://devpipe.com/dist/devpiped",
  [SETTING.cliUrl]: "https://devpipe.com/dist/devpipe-vault",
  [SETTING.sshKeyIds]: "",
  [SETTING.sshSources]: "",
}

export const getSetting = async (db: Connection, key: string): Promise<string> => {
  const row = (await db.one(from("settings").where(q => q("key").equals(key)))) as any
  return row?.value ?? DEFAULTS[key] ?? ""
}

export const allSettings = async (db: Connection): Promise<Record<string, string>> => {
  const rows = (await db.all(from("settings").select("key", "value"))) as any[]
  const out = { ...DEFAULTS }
  for (const r of rows) out[r.key] = r.value
  return out
}

export const setSetting = async (db: Connection, key: string, value: string): Promise<void> => {
  const existing = (await db.one(from("settings").where(q => q("key").equals(key)))) as any
  if (existing) {
    await db.execute(
      from("settings")
        .where(q => q("key").equals(key))
        .update({ value, updated_at: new Date() }),
    )
  } else {
    await db.execute(from("settings").insert({ key, value }))
  }
}

// ---- credentials ----------------------------------------------------------

/**
 * The instance's own secrets, encrypted at rest.
 *
 * These were plaintext, and of everything in this database they are the worst
 * things to leave that way. The DigitalOcean token creates and destroys every
 * droplet on the account, detaches volumes, and spends money with no ceiling.
 * Agent logins have been sealed since they shipped precisely because they "can
 * spend their money" — the same sentence is true of this one, about *your*
 * money, and it was the one left readable by anyone with a `psql` session or a
 * copy of last night's backup.
 * Backups are rsynced off the database host, so that is more than one place.
 *
 * Bound to the row they belong to. Without the AAD, a sealed value could be
 * moved from one credential row into `digitalocean_token` and the instance
 * would decrypt it happily and hand it to the provider client — encryption
 * stops a value being *read*, and only binding stops it being *moved*.
 *
 * Plaintext rows still open. An instance that upgrades into this has values
 * written before it existed, and refusing to read them would take box
 * provisioning down on deploy; they are sealed in place the first time they are
 * read. Where there is no `DEVPIPE_SECRET_KEY` at all, storage stays plaintext
 * rather than refusing — unlike an agent login, the provider token is what the
 * product needs to function, and a control plane that cannot provision is not a
 * safer control plane. `credentialsSealed` is how a screen can say which it is
 * rather than implying the stronger one.
 */
const SEALED_PREFIX = "v1."

const contextFor = (key: string) => `credential:${key}`

/** Whether this instance is encrypting its own secrets at rest. */
export const credentialsSealed = (): boolean => secretsAvailable()

export const CREDENTIAL = {
  digitalOceanToken: "digitalocean_token",
  runpodToken: "runpod_token",
} as const

export const getCredential = async (db: Connection, key: string): Promise<string | null> => {
  const row = (await db.one(from("credentials").where(q => q("key").equals(key)))) as any
  const stored = row?.value ?? null
  if (stored === null) return null

  if (stored.startsWith(SEALED_PREFIX)) {
    const opened = await open(stored, contextFor(key)).catch(() => null)
    if (opened === null) {
      // A key that has been rotated, or a value moved between rows. Reported
      // rather than swallowed: every symptom downstream is "DigitalOcean
      // rejected the API token", which sends somebody to the provider console
      // to check a token that is fine.
      console.error(`[devpipe] ${key} could not be decrypted — has DEVPIPE_SECRET_KEY changed?`)
    }
    return opened
  }

  // Written before this instance sealed anything. Sealed in place on the way
  // past, so upgrading needs no migration and no manual step — and so the
  // plaintext stops existing at the first read rather than at the next write,
  // which for a provider token could be never.
  if (secretsAvailable()) {
    void seal(stored, contextFor(key))
      .then(sealed =>
        db.execute(
          from("credentials")
            .where(q => q("key").equals(key))
            .update({ value: sealed, updated_at: new Date() }),
        ),
      )
      .catch(err => console.error(`[devpipe] could not seal ${key}:`, err))
  }
  return stored
}

export const setCredential = async (db: Connection, key: string, value: string): Promise<void> => {
  const stored = secretsAvailable() ? await seal(value, contextFor(key)) : value
  const existing = (await db.one(from("credentials").where(q => q("key").equals(key)))) as any
  if (existing) {
    await db.execute(
      from("credentials")
        .where(q => q("key").equals(key))
        .update({ value: stored, updated_at: new Date() }),
    )
  } else {
    await db.execute(from("credentials").insert({ key, value: stored }))
  }
}

export const clearCredential = async (db: Connection, key: string): Promise<void> => {
  await db.execute(
    from("credentials")
      .where(q => q("key").equals(key))
      .del(),
  )
}

/** Enough to tell two tokens apart, not enough to use one. */
export const credentialHint = (value: string | null): string | null => (value ? `…${value.slice(-4)}` : null)
