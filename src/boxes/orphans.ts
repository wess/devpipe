import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { getSetting, SETTING } from "../settings/index.ts"
import * as ocean from "./digitalocean.ts"

/**
 * What DigitalOcean is billing for that this database does not claim.
 *
 * Every path that creates a box also creates things beside it — a volume, a DNS
 * record, a droplet — and every one of those steps can succeed just before a
 * later one fails. When that happens the resource exists on the account with
 * nothing pointing at it: the reclaim sweep will not find it, because that reads
 * this table; the owner will not find it, because their box list is this table
 * too. It bills forever and nobody knows its name.
 *
 * Testing is where this bites hardest. A box spun up to check something, a
 * provision that half-worked, a `deploy/provision.sh` run whose delete command
 * nobody pasted — each leaves a droplet that looks exactly like a real one.
 *
 * So this reconciles in the other direction: start from what the provider has,
 * subtract what the database accounts for, and report the difference. Nothing
 * here deletes anything. `scripts/sweep.ts` does that, and only when asked.
 *
 * **Scoped to what Devpipe made.** Only droplets carrying `devpipe-box` are
 * ever considered, so the control plane, a mail server or somebody's VPN cannot
 * be swept up by a tool whose whole job is deleting things. A droplet Devpipe
 * created is always tagged; an untagged droplet is by definition not ours.
 */

export type Orphan = {
  kind: "droplet" | "volume" | "record" | "workspace"
  /**
   * Which side the stray is on.
   *
   * `provider` is a resource being billed that no row accounts for. `database`
   * is the mirror image — a row naming a resource that is not there any more,
   * which costs nothing and breaks something: a workspace whose volume is gone
   * is offered to the user, chosen, and then fails when a box tries to mount
   * it. Both are reconciliation failures and they are found the same way, but
   * only one of them is on the bill.
   */
  where: "provider" | "database"
  id: string
  name: string
  /** Dollars a month, as far as it can be known. Records are free. */
  monthly: number
  /** Why nothing claims it, in the words the report will print. */
  why: string
}

/**
 * Records that exist because somebody wrote them, not because a box was made.
 *
 * The wildcard is the one that matters most: every box and every preview is
 * reached through it, and it points at the control plane rather than at any
 * droplet, so an IP-liveness test alone would call it dead and offer to delete
 * the entire product.
 */
const PROTECTED = new Set(["*", "@", "www", "mail", "mx", "outbox", "_dmarc"])

/** A volume is billed at ten cents a gigabyte-month. */
const volumeMonthly = (sizeGb: number) => sizeGb * 0.1

export const findOrphans = async (db: Connection, token: string): Promise<Orphan[]> => {
  const found: Orphan[] = []

  // A row that is not destroyed is a row that still accounts for its droplet.
  // A *sleeping* box has no `provider_id` at all, which is correct and is why
  // this cannot work the other way round.
  const boxes = (await db.all(
    from("boxes")
      .where(q => q("destroyed_at").isNull())
      .select("provider_id", "hostname", "workspace_id"),
  )) as any[]
  const claimedDroplets = new Set(boxes.map(b => String(b.provider_id ?? "")).filter(Boolean))

  const droplets = await ocean.listDroplets(token)
  for (const d of droplets) {
    if (!d.tags.includes(ocean.BOX_TAG)) continue
    if (claimedDroplets.has(String(d.id))) continue
    found.push({
      kind: "droplet",
      where: "provider",
      id: String(d.id),
      name: d.name,
      monthly: d.monthly,
      why: "tagged as a box, but no box row points at it",
    })
  }

  // Workspaces outlive their boxes on purpose — that is the whole feature — so
  // a volume is only an orphan when the *workspace* is gone, not when the box
  // is.
  const workspaces = (await db.all(from("workspaces").select("id", "volume_id", "name"))) as any[]
  const claimedVolumes = new Set(workspaces.map(w => String(w.volume_id)).filter(Boolean))

  for (const v of await ocean.listVolumes(token)) {
    if (claimedVolumes.has(String(v.id))) continue
    // Only ours. `dp-` is the prefix every workspace volume is created with in
    // `src/boxes/index.ts`; anything else on the account belongs to something
    // that is not Devpipe.
    if (!v.name.startsWith("dp-")) continue
    found.push({
      kind: "volume",
      where: "provider",
      id: v.id,
      name: v.name,
      monthly: volumeMonthly(v.sizeGb),
      why: v.dropletIds.length
        ? `no workspace row, and still attached to droplet ${v.dropletIds[0]}`
        : "no workspace row",
    })
  }

  // A record pointing at nothing is not a cost. It is worse than one: a name
  // under our domain resolving to an address we no longer hold is a subdomain
  // somebody else can answer for.
  const domain = await getSetting(db, SETTING.domain)
  if (domain) {
    const live = new Set(droplets.map(d => d.ip).filter(Boolean))
    const hostnames = new Set(boxes.map(b => String(b.hostname ?? "")).filter(Boolean))
    for (const r of await ocean.listRecords(token, domain)) {
      // Written by hand and load-bearing: the wildcard boxes and previews live
      // under, the apex, and the names the site and mail are reached at. None
      // of these is ever created by provisioning, so none can be an orphan of
      // it — and a sweep that removed one would take the site down.
      if (PROTECTED.has(r.name)) continue
      // A live box accounts for its own record whatever it points at.
      if (hostnames.has(`${r.name}.${domain}`)) continue
      // Pointing at a droplet that exists. Not ours to judge: it resolves to
      // something real on this account.
      if (live.has(r.data)) continue
      found.push({
        kind: "record",
        where: "provider",
        id: String(r.id),
        name: `${r.name}.${domain} → ${r.data}`,
        monthly: 0,
        why: "points at an address this account no longer holds",
      })
    }
  }

  // The other direction: rows naming things the provider no longer has.
  //
  // A workspace is the one that matters. It is the promise that a box is the
  // disposable half — so a workspace row whose volume has been deleted is worse
  // than a leak. It shows up in the list when somebody makes a box, gets
  // chosen, and then fails at mount time, long after the choice was made.
  const liveVolumes = new Set((await ocean.listVolumes(token)).map(v => String(v.id)))
  for (const w of workspaces) {
    if (!w.volume_id || liveVolumes.has(String(w.volume_id))) continue
    found.push({
      kind: "workspace",
      where: "database",
      id: String(w.id),
      name: w.name,
      monthly: 0,
      why: "its volume no longer exists, so no box can ever mount it",
    })
  }

  return found
}

/** What the orphans cost per month, together. */
export const orphanSpend = (orphans: Orphan[]): number =>
  Math.round(orphans.reduce((sum, o) => sum + o.monthly, 0) * 100) / 100
