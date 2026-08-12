import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { currentUser, requireAuth } from "../auth/guard.ts"
import { rateLimit, signedInUser } from "../security/ratelimit.ts"
import { audit } from "../util/audit.ts"
import { open, seal, secretsAvailable } from "../util/secretbox.ts"

/**
 * The vault: what a person keeps, and what their boxes are allowed to do with it.
 *
 * Two kinds, and the asymmetry between them is the design rather than a
 * convenience:
 *
 * - A **value** is configuration. A box reads it, an agent reads it, and losing
 *   it is embarrassing rather than expensive.
 * - A **secret** is a credential, and **a box can never read one.** It can list
 *   the names it may use and spend them through the control plane, which
 *   attaches the credential upstream and hands back only the response.
 *
 * That rule exists because a box runs code nobody has reviewed — that is what a
 * box is *for*. Anything readable there is readable by a prompt-injected agent,
 * so "can the box read my API key" has to answer no, and the spending proxy is
 * what makes that answer affordable instead of merely principled.
 *
 * Scope resolves narrow-to-wide: a `box` entry shadows a `workspace` entry of
 * the same name, which shadows a `global` one. Same shape as a shell's
 * environment, for the same reason — the specific thing should win.
 */

export type Scope = "global" | "workspace" | "box"
export type Kind = "value" | "secret"

const SCOPES: readonly Scope[] = ["global", "workspace", "box"]
const KINDS: readonly Kind[] = ["value", "secret"]

/** Narrow to wide. Resolution walks this in order and takes the first hit. */
const PRECEDENCE: readonly Scope[] = ["box", "workspace", "global"]

const MAX_NAME = 64
const MAX_VALUE = 64 * 1024

/**
 * Names are restricted so a vault entry can be handed to a shell or an
 * environment block without quoting games. It also keeps them predictable to
 * type from an agent, which is most of what they are for.
 */
export const validName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)

/**
 * The context a row's ciphertext is bound to.
 *
 * Encryption stops a value being read out of a backup. It does not stop a
 * sealed value being *moved* — without this, copying somebody else's ciphertext
 * into your own row would decrypt for you, because the bytes are still valid
 * under the same key. Every field that decides *whose* and *where* is in here,
 * so a moved row fails its authentication tag instead.
 *
 * The `v1` prefix is not decoration: this string can never change shape for
 * existing rows without making them unreadable, so a future change gets a new
 * version and a migration rather than an edit.
 */
export const contextOf = (userId: number, scope: Scope, scopeId: number, name: string): string =>
  `vault:v1:${userId}:${scope}:${scopeId}:${name}`

/** What a listing may say. Never the value — not even for a `value` entry. */
const publicEntry = (row: any) => ({
  scope: row.scope as Scope,
  scope_id: row.scope_id as number,
  name: row.name as string,
  kind: row.kind as Kind,
  updated_at: row.updated_at,
  last_used_at: row.last_used_at,
})

/**
 * Confirm the scope target is real and belongs to `userId`.
 *
 * Without this, `scope_id` is an unchecked integer from the request and writing
 * into someone else's workspace is a matter of guessing a number.
 */
export const ownsScope = async (
  db: Connection,
  userId: number,
  scope: Scope,
  scopeId: number,
): Promise<boolean> => {
  if (scope === "global") return scopeId === 0
  if (!Number.isInteger(scopeId) || scopeId <= 0) return false
  const table = scope === "workspace" ? "workspaces" : "boxes"
  const row = (await db.one(
    from(table)
      .where(q => q("id").equals(scopeId))
      .where(q => q("user_id").equals(userId)),
  )) as any
  if (!row) return false
  // A destroyed box or a deleted workspace is not a place to keep anything.
  return scope === "workspace" ? row.deleted_at === null : row.destroyed_at === null
}

/** Store an entry, replacing any of the same name in the same scope. */
export const putEntry = async (
  db: Connection,
  userId: number,
  scope: Scope,
  scopeId: number,
  name: string,
  kind: Kind,
  value: string,
): Promise<void> => {
  const sealed = await seal(value, contextOf(userId, scope, scopeId, name))
  const existing = (await db.one(
    from("vault_entries")
      .where(q => q("user_id").equals(userId))
      .where(q => q("scope").equals(scope))
      .where(q => q("scope_id").equals(scopeId))
      .where(q => q("name").equals(name)),
  )) as any
  if (existing) {
    await db.execute(
      from("vault_entries")
        .where(q => q("id").equals(existing.id))
        .update({ kind, sealed, updated_at: new Date() }),
    )
    return
  }
  await db.execute(
    from("vault_entries").insert({ user_id: userId, scope, scope_id: scopeId, name, kind, sealed }),
  )
}

/** The stored row for one exact scope, or null. */
const entryAt = async (
  db: Connection,
  userId: number,
  scope: Scope,
  scopeId: number,
  name: string,
): Promise<any> =>
  (await db.one(
    from("vault_entries")
      .where(q => q("user_id").equals(userId))
      .where(q => q("scope").equals(scope))
      .where(q => q("scope_id").equals(scopeId))
      .where(q => q("name").equals(name)),
  )) as any

/**
 * Open a stored row.
 *
 * Returns null when the value cannot be opened, which covers both a rotated key
 * and a row that has been moved between scopes — the caller cannot tell the
 * difference, and neither case should hand back a plaintext.
 */
export const readEntry = async (
  db: Connection,
  userId: number,
  scope: Scope,
  scopeId: number,
  name: string,
): Promise<{ kind: Kind; value: string } | null> => {
  const row = await entryAt(db, userId, scope, scopeId, name)
  if (!row) return null
  const value = await open(row.sealed, contextOf(userId, scope, scopeId, name))
  if (value === null) return null
  await db.execute(
    from("vault_entries")
      .where(q => q("id").equals(row.id))
      .update({ last_used_at: new Date() }),
  )
  return { kind: row.kind as Kind, value }
}

/**
 * What a box sees for `name`: the narrowest scope that defines it.
 *
 * `workspaceId` may be null — a box without a workspace simply has one fewer
 * place to look, rather than being an error.
 */
export const resolve = async (
  db: Connection,
  userId: number,
  name: string,
  boxId: number,
  workspaceId: number | null,
): Promise<{ scope: Scope; kind: Kind; value: string } | null> => {
  for (const scope of PRECEDENCE) {
    if (scope === "workspace" && !workspaceId) continue
    const scopeId = scope === "box" ? boxId : scope === "workspace" ? (workspaceId as number) : 0
    const hit = await readEntry(db, userId, scope, scopeId, name)
    if (hit) return { scope, kind: hit.kind, value: hit.value }
  }
  return null
}

/**
 * Every name visible to a box, narrow shadowing wide, with kinds but no values.
 *
 * This is what an agent is allowed to enumerate: enough to know a credential
 * exists and can be spent, never enough to hold it.
 */
export const visibleTo = async (
  db: Connection,
  userId: number,
  boxId: number,
  workspaceId: number | null,
): Promise<Array<{ name: string; kind: Kind; scope: Scope }>> => {
  const rows = (await db.all(
    from("vault_entries").where(q => q("user_id").equals(userId)),
  )) as any[]
  const seen = new Map<string, { name: string; kind: Kind; scope: Scope }>()
  for (const scope of [...PRECEDENCE].reverse()) {
    for (const row of rows) {
      if (row.scope !== scope) continue
      if (scope === "box" && row.scope_id !== boxId) continue
      if (scope === "workspace" && (!workspaceId || row.scope_id !== workspaceId)) continue
      if (scope === "global" && row.scope_id !== 0) continue
      // Wide first, narrow last: the later write wins, which is the shadowing.
      seen.set(row.name, { name: row.name, kind: row.kind as Kind, scope })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export const vaultRoutes = (db: Connection) => {
  const authed = pipeline(requireAuth({ db }))
  const writing = pipeline(
    requireAuth({ db }),
    parseJson,
    rateLimit({
      db,
      key: "vault.write",
      limit: 600,
      windowSeconds: 3600,
      subject: signedInUser,
      subjectLimit: 120,
    }),
  )
  // Revealing is rate-limited harder than writing. Someone walking the vault to
  // copy it out looks exactly like ordinary use, one request at a time, and
  // this is the only thing that makes the difference visible.
  const revealing = pipeline(
    requireAuth({ db }),
    rateLimit({
      db,
      key: "vault.reveal",
      limit: 300,
      windowSeconds: 3600,
      subject: signedInUser,
      subjectLimit: 60,
    }),
  )

  const scopeFrom = (raw: unknown): Scope | null =>
    SCOPES.includes(raw as Scope) ? (raw as Scope) : null

  return [
    // Names and kinds across every scope. Deliberately never values: a listing
    // is the one call a UI makes constantly, and it must not be a way to
    // exfiltrate the vault by asking politely.
    get(
      "/vault",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("vault_entries")
            .where(q => q("user_id").equals(me.id))
            .orderBy("name", "ASC"),
        )) as any[]
        return json(c, 200, rows.map(publicEntry))
      }),
    ),

    post(
      "/vault",
      writing(async c => {
        const me = currentUser(c)
        const b = c.body as { scope?: string; scope_id?: number; name?: string; kind?: string; value?: string }
        if (!secretsAvailable()) {
          return json(c, 503, { error: "This instance has no encryption key configured." })
        }
        const scope = scopeFrom(b.scope)
        if (!scope) return json(c, 422, { error: "Scope must be global, workspace, or box." })
        const scopeId = scope === "global" ? 0 : Math.round(Number(b.scope_id) || 0)
        if (!(await ownsScope(db, me.id, scope, scopeId))) {
          // Deliberately the same answer as a malformed scope: distinguishing
          // "not yours" from "does not exist" tells a prober which ids are real.
          return json(c, 422, { error: "That scope is not available." })
        }
        const name = String(b.name ?? "").trim()
        if (!validName(name)) {
          return json(c, 422, {
            error: `Names start with a letter or underscore, then letters, digits or underscores, up to ${MAX_NAME}.`,
          })
        }
        const kind = KINDS.includes(b.kind as Kind) ? (b.kind as Kind) : null
        if (!kind) return json(c, 422, { error: "Kind must be value or secret." })
        const value = String(b.value ?? "")
        if (!value) return json(c, 422, { error: "A vault entry needs a value." })
        if (value.length > MAX_VALUE) return json(c, 413, { error: "That value is too large." })

        await putEntry(db, me.id, scope, scopeId, name, kind, value)
        // The name and scope, never the value — an audit trail that leaks what
        // it audits is worse than none, because it is trusted.
        await audit(db, me.id, "vault.put", `${kind} ${name} @ ${scope}:${scopeId}`)
        return json(c, 200, { ok: true })
      }),
    ),

    // Reading one entry back. The UI needs this to show a value for editing,
    // and it is the one call that returns plaintext, so it is audited every
    // time rather than sampled.
    get(
      "/vault/:scope/:scopeId/:name",
      revealing(async c => {
        const me = currentUser(c)
        const scope = scopeFrom(c.params.scope)
        if (!scope) return json(c, 404, { error: "No such entry." })
        const scopeId = scope === "global" ? 0 : Math.round(Number(c.params.scopeId) || 0)
        const name = String(c.params.name ?? "")
        if (!validName(name)) return json(c, 404, { error: "No such entry." })
        if (!(await ownsScope(db, me.id, scope, scopeId))) return json(c, 404, { error: "No such entry." })

        const hit = await readEntry(db, me.id, scope, scopeId, name)
        if (!hit) return json(c, 404, { error: "No such entry." })
        await audit(db, me.id, "vault.reveal", `${hit.kind} ${name} @ ${scope}:${scopeId}`)
        return json(c, 200, { scope, scope_id: scopeId, name, kind: hit.kind, value: hit.value })
      }),
    ),

    del(
      "/vault/:scope/:scopeId/:name",
      authed(async c => {
        const me = currentUser(c)
        const scope = scopeFrom(c.params.scope)
        if (!scope) return json(c, 404, { error: "No such entry." })
        const scopeId = scope === "global" ? 0 : Math.round(Number(c.params.scopeId) || 0)
        const name = String(c.params.name ?? "")
        if (!validName(name)) return json(c, 404, { error: "No such entry." })

        const row = await entryAt(db, me.id, scope, scopeId, name)
        if (!row) return json(c, 404, { error: "No such entry." })
        await db.execute(
          from("vault_entries")
            .where(q => q("id").equals(row.id))
            .del(),
        )
        await audit(db, me.id, "vault.remove", `${row.kind} ${name} @ ${scope}:${scopeId}`)
        return json(c, 200, { ok: true })
      }),
    ),

    // Which boxes may read which secrets. Listed as (box, entry) pairs rather
    // than nested under either, because the question a person actually asks is
    // "what can this box get at" as often as "who can read this key".
    get(
      "/vault/grants",
      authed(async c => {
        const me = currentUser(c)
        const rows = (await db.all(
          from("vault_grants").where(q => q("user_id").equals(me.id)),
        )) as any[]
        const out = []
        for (const row of rows) {
          const entry = (await db.one(from("vault_entries").where(q => q("id").equals(row.entry_id)))) as any
          if (!entry) continue
          out.push({
            box_id: row.box_id,
            scope: entry.scope as Scope,
            scope_id: entry.scope_id as number,
            name: entry.name as string,
            granted_at: row.created_at,
          })
        }
        return json(c, 200, out)
      }),
    ),

    post(
      "/vault/grants",
      writing(async c => {
        const me = currentUser(c)
        const b = c.body as { box_id?: number; scope?: string; scope_id?: number; name?: string }
        const boxId = Math.round(Number(b.box_id) || 0)
        if (!(await ownsScope(db, me.id, "box", boxId))) {
          return json(c, 422, { error: "That box is not available." })
        }
        const scope = SCOPES.includes(b.scope as Scope) ? (b.scope as Scope) : null
        if (!scope) return json(c, 422, { error: "Scope must be global, workspace, or box." })
        const scopeId = scope === "global" ? 0 : Math.round(Number(b.scope_id) || 0)
        const name = String(b.name ?? "")
        if (!validName(name)) return json(c, 422, { error: "Invalid name." })

        const entry = (await db.one(
          from("vault_entries")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("scope").equals(scope))
            .where(q => q("scope_id").equals(scopeId))
            .where(q => q("name").equals(name)),
        )) as any
        if (!entry) return json(c, 404, { error: "No such entry." })
        // Granting a *value* would imply it was withheld, which it never was.
        // Refusing says the model out loud rather than silently doing nothing.
        if (entry.kind !== "secret") {
          return json(c, 422, { error: "Values are already readable by your boxes; only secrets are granted." })
        }

        const existing = (await db.one(
          from("vault_grants")
            .where(q => q("box_id").equals(boxId))
            .where(q => q("entry_id").equals(entry.id)),
        )) as any
        if (!existing) {
          await db.execute(
            from("vault_grants").insert({ user_id: me.id, box_id: boxId, entry_id: entry.id }),
          )
        }
        await audit(db, me.id, "vault.grant", `${name} @ ${scope}:${scopeId} to box ${boxId}`)
        return json(c, 200, { ok: true })
      }),
    ),

    del(
      "/vault/grants/:boxId/:scope/:scopeId/:name",
      authed(async c => {
        const me = currentUser(c)
        const boxId = Math.round(Number(c.params.boxId) || 0)
        const scope = SCOPES.includes(c.params.scope as Scope) ? (c.params.scope as Scope) : null
        if (!scope) return json(c, 404, { error: "No such grant." })
        const scopeId = scope === "global" ? 0 : Math.round(Number(c.params.scopeId) || 0)
        const name = String(c.params.name ?? "")
        if (!validName(name)) return json(c, 404, { error: "No such grant." })

        const entry = (await db.one(
          from("vault_entries")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("scope").equals(scope))
            .where(q => q("scope_id").equals(scopeId))
            .where(q => q("name").equals(name)),
        )) as any
        if (!entry) return json(c, 404, { error: "No such grant." })
        await db.execute(
          from("vault_grants")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("box_id").equals(boxId))
            .where(q => q("entry_id").equals(entry.id))
            .del(),
        )
        // Takes effect on the next read: nothing can un-read a credential a box
        // already fetched, and saying otherwise would misrepresent revocation.
        await audit(db, me.id, "vault.revoke", `${name} @ ${scope}:${scopeId} from box ${boxId}`)
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
