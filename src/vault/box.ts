import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { audit } from "../util/audit.ts"
import { digestsMatch, randomToken, sha256Hex } from "../util/token.ts"
import { type Kind, putEntry, readEntry, resolve, validName, visibleTo } from "./index.ts"

/**
 * The vault as a box sees it.
 *
 * Everything here is written on the assumption that whatever calls it is
 * hostile. A box runs code nobody reviewed — that is the point of a box — so an
 * agent on it can read any credential the box can read and can call anything
 * the box can call. That is not a hole to close; it is the shape of the problem.
 *
 * So the credential is not made safe by being hidden. It is made safe by being
 * narrow:
 *
 * - It authorises the vault and nothing else. It is not `agent_token`, which
 *   gates attaching to the terminal.
 * - It resolves one box's own scope chain and no other's.
 * - It reads **values** freely and **secrets** never — unless the owner has
 *   explicitly granted that box that entry.
 * - It dies when the box does.
 *
 * The worst case is therefore "an attacker spends the credentials you chose to
 * grant, while the box lives", rather than "an attacker has your vault".
 */

/** Mint a box's vault credential, returning the token and the hash to store. */
export const mintBoxToken = (): { token: string; hash: string } => {
  const token = randomToken()
  return { token, hash: sha256Hex(token) }
}

/**
 * Give a box a new vault credential and return it, invalidating the old one.
 *
 * Called on both create and wake. Waking rotates rather than restores because
 * only the hash was ever stored — which turns an implementation constraint into
 * the behaviour you would want anyway: a token lifted from a sleeping box's
 * disk image is dead by the time that box is running again.
 */
export const rotateVaultToken = async (db: Connection, boxId: number): Promise<string> => {
  const { token, hash } = mintBoxToken()
  await db.execute(
    from("boxes")
      .where(q => q("id").equals(boxId))
      .update({ vault_token_hash: hash }),
  )
  return token
}

/**
 * The box a bearer token belongs to, or null.
 *
 * Compared as digests: a token is looked up by its hash, and the comparison is
 * constant-time so a wrong guess leaks no timing about how much of it was right.
 * A destroyed box authenticates as nothing, which is what makes revocation
 * simply destroying the box.
 */
export const boxFor = async (db: Connection, presented: string): Promise<any | null> => {
  if (!presented) return null
  const hash = sha256Hex(presented)
  const row = (await db.one(
    from("boxes")
      .where(q => q("vault_token_hash").equals(hash))
      .where(q => q("destroyed_at").isNull()),
  )) as any
  if (!row) return null
  // Belt and braces: the lookup already matched, but comparing explicitly means
  // a future change to the query cannot quietly turn this into a prefix match.
  return digestsMatch(row.vault_token_hash, hash) ? row : null
}

/** Whether this box has been granted the entry backing `name` at `scope`. */
const granted = async (
  db: Connection,
  userId: number,
  boxId: number,
  scope: string,
  scopeId: number,
  name: string,
): Promise<boolean> => {
  const entry = (await db.one(
    from("vault_entries")
      .where(q => q("user_id").equals(userId))
      .where(q => q("scope").equals(scope))
      .where(q => q("scope_id").equals(scopeId))
      .where(q => q("name").equals(name)),
  )) as any
  if (!entry) return false
  const grant = (await db.one(
    from("vault_grants")
      .where(q => q("box_id").equals(boxId))
      .where(q => q("entry_id").equals(entry.id)),
  )) as any
  return Boolean(grant)
}

export const boxVaultRoutes = (db: Connection) => {
  /**
   * Resolve the caller to a box, or refuse.
   *
   * Not the shared `requireAuth`: that resolves a *person* from a session, and
   * a box is not a person. Conflating them would give a box whatever the owner
   * can do, which is the entire thing this file exists to avoid.
   */
  const asBox = (handler: (c: any, box: any) => Promise<any>) => async (c: any) => {
    const header = c.headers.get("authorization") ?? ""
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    const box = await boxFor(db, presented)
    if (!box) return json(c, 403, { error: "no" })
    return handler(c, box)
  }

  const body = pipeline(parseJson)

  return [
    // Every name this box may use, with kinds, and never a value. An agent may
    // learn that a credential exists without being able to hold it.
    get(
      "/box/vault",
      asBox(async (c, box) => {
        const names = await visibleTo(db, box.user_id, box.id, box.workspace_id ?? null)
        const out = []
        for (const item of names) {
          const readable =
            item.kind === "value" ||
            (await granted(
              db,
              box.user_id,
              box.id,
              item.scope,
              item.scope === "box" ? box.id : item.scope === "workspace" ? box.workspace_id : 0,
              item.name,
            ))
          out.push({ ...item, readable })
        }
        return json(c, 200, out)
      }),
    ),

    // One resolved entry. A value comes back; a secret comes back only if this
    // box was granted it, and the refusal does not say whether it exists.
    get(
      "/box/vault/:name",
      asBox(async (c, box) => {
        const name = String(c.params.name ?? "")
        if (!validName(name)) return json(c, 404, { error: "No such entry." })
        const hit = await resolve(db, box.user_id, name, box.id, box.workspace_id ?? null)
        if (!hit) return json(c, 404, { error: "No such entry." })
        if (hit.kind === "secret") {
          const scopeId = hit.scope === "box" ? box.id : hit.scope === "workspace" ? box.workspace_id : 0
          if (!(await granted(db, box.user_id, box.id, hit.scope, scopeId, name))) {
            await audit(db, box.user_id, "vault.box.refused", `${name} on ${box.hostname}`)
            return json(c, 403, {
              error: "That is a secret, and this box has not been granted it.",
            })
          }
          // Every secret a box reads is on the record. A credential read from a
          // machine running unreviewed code is exactly the event worth being
          // able to reconstruct afterwards.
          await audit(db, box.user_id, "vault.box.secret", `${name} on ${box.hostname}`)
        }
        return json(c, 200, { name, kind: hit.kind, scope: hit.scope, value: hit.value })
      }),
    ),

    // A box may write, but only into its own scope, and only values. Letting a
    // box create a *secret* would let an agent launder an exfiltrated
    // credential into the owner's vault, where it looks like the owner put it
    // there.
    post(
      "/box/vault/:name",
      body(
        asBox(async (c, box) => {
          const name = String(c.params.name ?? "")
          if (!validName(name)) return json(c, 422, { error: "Invalid name." })
          const b = c.body as { value?: string }
          const value = String(b.value ?? "")
          if (!value) return json(c, 422, { error: "A vault entry needs a value." })
          if (value.length > 64 * 1024) return json(c, 413, { error: "That value is too large." })

          const existing = await readEntry(db, box.user_id, "box", box.id, name)
          if (existing && existing.kind === ("secret" as Kind)) {
            return json(c, 403, { error: "That name holds a secret and cannot be written from a box." })
          }
          await putEntry(db, box.user_id, "box", box.id, name, "value", value)
          await audit(db, box.user_id, "vault.box.put", `${name} on ${box.hostname}`)
          return json(c, 200, { ok: true })
        }),
      ),
    ),
  ]
}
