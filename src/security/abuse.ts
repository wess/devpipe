import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { audit } from "../util/audit.ts"

/**
 * Whose problem a customer's box is.
 *
 * The provider account is in the instance owner's name. When a box scans, spams
 * or mines, the complaint arrives at that account and the provider's remedy is
 * to lock all of it — every other customer's box included. So an abuse response
 * has to be something the control plane can do on its own, in seconds, without
 * anyone reading a ticket.
 *
 * What that leaves us:
 *
 * - **Evidence.** `audit` says who did what, `sessions.ip` says from where, and
 *   `box_events` holds what the box printed while it was built. An abuse report
 *   names an address and a time, and those three are what turn that into an
 *   account. None of them are cleaned up automatically for this reason.
 * - **Stopping it.** `suspendUser` below. Sessions end and boxes are condemned;
 *   the box keeps running until something destroys it, which is deliberate —
 *   see the note there.
 * - **Slowing the next one.** Signups are invite-only by default and rate
 *   limited, and `isDisposableEmail` refuses the throwaway addresses that make
 *   re-registering free. That is friction, not a wall: it is worth about one
 *   round of automated signups, and nothing at all against somebody determined.
 *
 * What we deliberately do not do: inspect what runs on a box. Terminals are the
 * product, the daemon holds the pty and the control plane never sees the bytes.
 * Enforcement here is about accounts, not content.
 */

/**
 * Status a condemned box carries until something destroys it. Not
 * `destroyed_at` — see `suspendUser`.
 */
export const CONDEMNED = "pending_destroy"

export type Suspension = {
  ok: boolean
  /** Sessions ended. */
  sessions: number
  /** Live boxes marked for destruction. */
  boxes: number
  error?: string
}

const count = async (db: Connection, query: unknown): Promise<number> =>
  Number(((await db.one(query as any)) as any)?.n ?? 0)

/**
 * Locks an account out and condemns everything it is running.
 *
 * Boxes are marked rather than destroyed. Destroying means one provider call
 * per box, each of which can fail or hang, and a loop that dies halfway leaves
 * the account locked with machines still up and nothing recording which ones.
 * Marking is a single local write that cannot half-happen; the destroy is left
 * to whatever already knows how to talk to the provider. `destroyed_at` stays
 * null so the box is still real to it.
 *
 * Refuses to touch the owner: their account is the only one that can undo any
 * of this.
 *
 * `actorId` is whoever asked for it, or null when nothing did — an automatic
 * response to a provider complaint has no actor.
 */
export const suspendUser = async (
  db: Connection,
  userId: number,
  reason: string,
  actorId: number | null = null,
): Promise<Suspension> => {
  const user = (await db.one(from("users").where(q => q("id").equals(userId)))) as any
  if (!user) return { ok: false, sessions: 0, boxes: 0, error: "No such user." }
  if (user.is_owner) {
    return { ok: false, sessions: 0, boxes: 0, error: "The instance owner cannot be suspended." }
  }

  await db.execute(
    from("users")
      .where(q => q("id").equals(userId))
      .update({ suspended_at: new Date() }),
  )

  // Counted before the delete: a delete reports nothing useful on either
  // driver, and the number is what tells an operator whether this account was
  // one browser or a fleet.
  const sessions = await count(
    db,
    from("sessions")
      .where(q => q("user_id").equals(userId))
      .select("COUNT(*) AS n"),
  )
  await db.execute(
    from("sessions")
      .where(q => q("user_id").equals(userId))
      .del(),
  )

  const boxes = await count(
    db,
    from("boxes")
      .where(q => q("user_id").equals(userId))
      .where(q => q("destroyed_at").isNull())
      .select("COUNT(*) AS n"),
  )
  await db.execute(
    from("boxes")
      .where(q => q("user_id").equals(userId))
      .where(q => q("destroyed_at").isNull())
      .update({ status: CONDEMNED, status_detail: reason.slice(0, 200) }),
  )

  // `user_id` on an audit row is the actor everywhere else it is written, so
  // the subject goes in the detail rather than the column. Recording the
  // subject here instead would make one action name mean two different things
  // depending on which code path wrote the row.
  await audit(db, actorId, "user.suspended", `${user.email}: ${reason}`)

  return { ok: true, sessions, boxes }
}

/**
 * Throwaway providers. Short on purpose: a real list is tens of thousands of
 * domains, needs updating forever, and is wrong often enough to lock out people
 * with an ordinary address. This one covers the services that appear at the top
 * of a search for "temporary email", which is where a scripted signup gets its
 * addresses.
 */
const DISPOSABLE = new Set([
  "10minutemail.com",
  "dispostable.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "sharklasers.com",
  "spam4.me",
  "temp-mail.org",
  "tempmail.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
])

/**
 * Whether an address belongs to a throwaway provider.
 *
 * A signal for the signup gate, not grounds for anything else. Subdomains count
 * — several of these hand out `anything.mailinator.com` — and a malformed
 * address is somebody else's rejection to make.
 */
export const isDisposableEmail = (address: string): boolean => {
  const at = address.lastIndexOf("@")
  if (at < 0) return false
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
  if (!domain) return false

  for (const known of DISPOSABLE) {
    if (domain === known || domain.endsWith(`.${known}`)) return true
  }
  return false
}
