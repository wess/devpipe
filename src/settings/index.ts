import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

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
  sshKeyIds: "boxes_ssh_key_ids",
  billingMarginPct: "billing_margin_pct",
  /** Gigabytes a box may send in an hour before it is worth a look. */
  egressLimitGb: "boxes_egress_limit_gb",
  /**
   * Largest size a box may be while nothing is being charged for it.
   *
   * An instance with no Stripe key gives boxes away, which is right for a beta
   * and unbounded by default: every invited person could take the box limit in
   * the largest size, on the owner's provider account, and nothing in the
   * product would mention it until the invoice.
   */
  freeMaxSize: "boxes_free_max_size",
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
   * Idle hours for a box nobody is paying for. Falls back to `idleHours`.
   *
   * Separate because the right answer differs. Somebody paying for a box wants
   * it there when they come back; somebody trying the product out for twenty
   * minutes costs the owner money for every hour it lingers afterwards.
   */
  freeIdleHours: "boxes_free_idle_hours",
  /**
   * Gigabytes of workspace given to a free box that asked for none. 0 disables.
   *
   * Not generosity — reclaim only ever touches boxes carrying a workspace,
   * because a box without one holds the only copy of what is on it. A free box
   * with no workspace can therefore never be reclaimed, which is exactly
   * backwards: the boxes nobody pays for are the ones that most need to sleep.
   */
  freeWorkspaceGb: "boxes_free_workspace_gb",
  /**
   * Days a free box may stay asleep before it and its workspace are deleted.
   * 0 disables, which is the default: this throws away somebody's files.
   */
  dormantDays: "boxes_dormant_days",
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
  // The cheapest size. Deliberately the floor rather than the ceiling: an
  // instance giving boxes away should have to raise this on purpose.
  [SETTING.freeMaxSize]: "s-1vcpu-1gb",
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
  [SETTING.daemonUrl]: "https://devpipe.com/dist/devpiped",
  [SETTING.sshKeyIds]: "",
  // A percentage on top of what the provider charges. 100 means the customer
  // pays double cost, which is what covers the control plane, support and the
  // boxes nobody remembered to destroy.
  [SETTING.billingMarginPct]: "100",
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

export const CREDENTIAL = {
  digitalOceanToken: "digitalocean_token",
  stripeSecretKey: "stripe_secret_key",
  // Separate from the secret key on purpose: the key can create charges, the
  // signing secret can only prove an event came from Stripe. Rotating one
  // should not force rotating the other.
  stripeWebhookSecret: "stripe_webhook_secret",
} as const

export const getCredential = async (db: Connection, key: string): Promise<string | null> => {
  const row = (await db.one(from("credentials").where(q => q("key").equals(key)))) as any
  return row?.value ?? null
}

export const setCredential = async (db: Connection, key: string, value: string): Promise<void> => {
  const existing = (await db.one(from("credentials").where(q => q("key").equals(key)))) as any
  if (existing) {
    await db.execute(
      from("credentials")
        .where(q => q("key").equals(key))
        .update({ value, updated_at: new Date() }),
    )
  } else {
    await db.execute(from("credentials").insert({ key, value }))
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
