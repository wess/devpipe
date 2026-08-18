import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

/**
 * Closing the links that point at a machine which has stopped existing.
 *
 * A share names a *session id* on a box's daemon. Sleeping a box destroys the
 * droplet, and waking it builds a new one — so the daemon comes back empty and
 * `s1` is not the terminal it used to be. Left alone, the link stays live in
 * the database and opens a socket that connects to nothing, forever, with no
 * way for the guest to tell that from a slow box.
 *
 * Previews deliberately survive a sleep. A preview names a *port*, and the port
 * a dev server runs on is the same one after the machine comes back — so
 * revoking them would mean re-sending every link after every idle sweep, for a
 * URL that would have kept working.
 *
 * Both go when the box is destroyed, because then neither the session nor the
 * port is ever coming back.
 */

/** Shares only: the box will return, but its terminals will not. */
export const retireShares = async (db: Connection, boxId: number): Promise<void> => {
  await db.execute(
    from("shares")
      .where(q => q("box_id").equals(boxId))
      .where(q => q("revoked_at").isNull())
      .update({ revoked_at: new Date() }),
  )
}

/** Everything, for a box that is not coming back. */
export const retireSharing = async (db: Connection, boxId: number): Promise<void> => {
  await retireShares(db, boxId)
  await db.execute(
    from("previews")
      .where(q => q("box_id").equals(boxId))
      .where(q => q("revoked_at").isNull())
      .update({ revoked_at: new Date() }),
  )
}
