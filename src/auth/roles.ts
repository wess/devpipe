/**
 * Who may do what.
 *
 * Three roles, and the line between them is money and irreversibility:
 *
 *  - **owner** — one per instance, and the only one who can reach the provider
 *    token, the spending cap and the setup wizard. Everything behind that
 *    boundary either spends the owner's money or decides who else may. There
 *    is exactly one, enforced by a unique index rather than by agreement, so
 *    promotion is a transfer rather than an addition.
 *
 *  - **admin** — runs the instance day to day. Invites people, suspends an
 *    abuser, reads the audit log, sees every box on the instance and what it
 *    is all costing. Cannot see a credential, cannot change the spending cap,
 *    cannot promote themselves.
 *
 *  - **user** — has their own boxes and nothing else. The default, and what
 *    everybody registering into an open instance becomes.
 *
 * The middle role is the reason this exists at all. Without it, letting
 * somebody deal with a spam complaint at two in the morning meant handing them
 * the token that can destroy every box on the account.
 */

export const ROLES = ["owner", "admin", "user"] as const

export type Role = (typeof ROLES)[number]

/** Ascending authority. Only ever compared, never stored. */
const RANK: Record<Role, number> = { user: 0, admin: 1, owner: 2 }

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value)

/**
 * An unknown value is a `user`, never an admin.
 *
 * A row written by an older build, a typo in a manual UPDATE, a column read
 * from a join that did not select it — every one of those should land on the
 * role that can do the least.
 */
export const asRole = (value: unknown): Role => (isRole(value) ? value : "user")

/** Whether this role carries at least the authority of that one. */
export const atLeast = (role: Role, needed: Role): boolean => RANK[role] >= RANK[needed]

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  user: "Member",
}

export const ROLE_BLURB: Record<Role, string> = {
  owner: "Runs the instance. Holds the provider and payment credentials, and there is only ever one.",
  admin: "Looks after people and boxes — invites, suspensions, the audit log. Sees no credentials.",
  user: "Has their own boxes and nothing else.",
}
