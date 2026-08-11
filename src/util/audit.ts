import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

/**
 * Records something worth being able to answer for later.
 *
 * Provisioning spends money and destroying a box loses somebody's work, so
 * both need a trail. Never throws: an audit write failing is not a reason to
 * fail the action the user asked for, and swallowing it here keeps every call
 * site from having to decide that separately.
 */
export const audit = async (db: Connection, userId: number | null, action: string, detail = ""): Promise<void> => {
  try {
    await db.execute(from("audit").insert({ user_id: userId, action, detail: detail.slice(0, 500) }))
  } catch (err) {
    console.error("audit write failed", action, err)
  }
}
