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
} as const

const DEFAULTS: Record<string, string> = {
  [SETTING.signupsOpen]: "0",
  [SETTING.domain]: "devpipe.com",
  [SETTING.defaultRegion]: "nyc3",
  [SETTING.defaultSize]: "s-1vcpu-512mb-10gb",
  [SETTING.boxLimitPerUser]: "3",
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
