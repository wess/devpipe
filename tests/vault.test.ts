import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { boxFor, rotateVaultToken } from "../src/vault/box.ts"
import { ownsScope, putEntry, readEntry, resolve, validName, visibleTo } from "../src/vault/index.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The vault, and the two rules it exists to enforce: the narrowest scope wins,
 * and nothing crosses between users.
 */

beforeAll(() => {
  process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
})

let mine = 0
let theirs = 0
let workspaceId = 0
let boxId = 0

const newUser = async (email: string, username: string) => {
  const rows = (await db.execute(
    from("users").insert({ email, username, password: "x" }).returning("id"),
  )) as any[]
  return rows[0].id as number
}

beforeEach(async () => {
  await truncateAll()
  mine = await newUser("a@b.co", "alfa")
  theirs = await newUser("c@d.co", "bravo")

  const ws = (await db.execute(
    from("workspaces")
      .insert({ user_id: mine, name: "main", region: "nyc3", size_gb: 10, volume_id: "vol-1", volume_name: "dp-1-main" })
      .returning("id"),
  )) as any[]
  workspaceId = ws[0].id

  const boxes = (await db.execute(
    from("boxes")
      .insert({
        user_id: mine,
        name: "dev",
        hostname: "dev.devpipe.com",
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: "ready",
        agent_token: "tok",
        manifest: "{}",
        workspace_id: workspaceId,
      })
      .returning("id"),
  )) as any[]
  boxId = boxes[0].id
})

describe("names", () => {
  test("are shell- and env-safe", () => {
    expect(validName("OPENAI_API_KEY")).toBe(true)
    expect(validName("_private")).toBe(true)
    expect(validName("a1")).toBe(true)
    // Anything that would need quoting, or could be read as something else.
    expect(validName("1leading")).toBe(false)
    expect(validName("has-dash")).toBe(false)
    expect(validName("has space")).toBe(false)
    expect(validName("has$dollar")).toBe(false)
    expect(validName("")).toBe(false)
    expect(validName("x".repeat(65))).toBe(false)
  })
})

describe("storing and reading", () => {
  test("round-trips a value", async () => {
    await putEntry(db, mine, "global", 0, "REGION", "value", "nyc3")
    expect(await readEntry(db, mine, "global", 0, "REGION")).toEqual({ kind: "value", value: "nyc3" })
  })

  test("writing the same name in the same scope replaces it", async () => {
    await putEntry(db, mine, "global", 0, "TOKEN", "secret", "first")
    await putEntry(db, mine, "global", 0, "TOKEN", "secret", "second")
    expect((await readEntry(db, mine, "global", 0, "TOKEN"))?.value).toBe("second")
    const rows = (await db.all(from("vault_entries").where(q => q("user_id").equals(mine)))) as any[]
    expect(rows).toHaveLength(1)
  })

  test("one user cannot read another's entry", async () => {
    await putEntry(db, mine, "global", 0, "PRIVATE", "secret", "mine-only")
    expect(await readEntry(db, theirs, "global", 0, "PRIVATE")).toBeNull()
  })

  test("a row moved into another user's scope does not decrypt", async () => {
    // The database-level version of the binding test: rewrite the owner column
    // the way an attacker with write access would.
    await putEntry(db, mine, "global", 0, "MOVED", "secret", "not-yours")
    await db.execute(
      from("vault_entries")
        .where(q => q("user_id").equals(mine))
        .where(q => q("name").equals("MOVED"))
        .update({ user_id: theirs }),
    )
    expect(await readEntry(db, theirs, "global", 0, "MOVED")).toBeNull()
  })
})

describe("scope resolution", () => {
  test("box shadows workspace shadows global", async () => {
    await putEntry(db, mine, "global", 0, "ENDPOINT", "value", "global")
    expect((await resolve(db, mine, "ENDPOINT", boxId, workspaceId))?.scope).toBe("global")

    await putEntry(db, mine, "workspace", workspaceId, "ENDPOINT", "value", "workspace")
    expect((await resolve(db, mine, "ENDPOINT", boxId, workspaceId))?.value).toBe("workspace")

    await putEntry(db, mine, "box", boxId, "ENDPOINT", "value", "box")
    const hit = await resolve(db, mine, "ENDPOINT", boxId, workspaceId)
    expect(hit).toEqual({ scope: "box", kind: "value", value: "box" })
  })

  test("a box without a workspace still resolves the global entry", async () => {
    await putEntry(db, mine, "global", 0, "ONLY_GLOBAL", "value", "g")
    await putEntry(db, mine, "workspace", workspaceId, "ONLY_GLOBAL", "value", "w")
    // Passing null skips the workspace tier rather than failing.
    expect((await resolve(db, mine, "ONLY_GLOBAL", boxId, null))?.value).toBe("g")
  })

  test("another box's entry is not visible to this one", async () => {
    await putEntry(db, mine, "box", boxId + 999, "OTHER", "value", "not-here")
    expect(await resolve(db, mine, "OTHER", boxId, workspaceId)).toBeNull()
  })

  test("an unknown name resolves to nothing", async () => {
    expect(await resolve(db, mine, "ABSENT", boxId, workspaceId)).toBeNull()
  })
})

describe("what a box may enumerate", () => {
  test("names and kinds, shadowed, and never a value", async () => {
    await putEntry(db, mine, "global", 0, "SHARED", "value", "plaintext-global")
    await putEntry(db, mine, "box", boxId, "SHARED", "secret", "plaintext-box")
    await putEntry(db, mine, "global", 0, "ALONE", "secret", "plaintext-alone")

    const seen = await visibleTo(db, mine, boxId, workspaceId)
    expect(seen).toEqual([
      { name: "ALONE", kind: "secret", scope: "global" },
      // The box entry shadows the global one, kind included.
      { name: "SHARED", kind: "secret", scope: "box" },
    ])
    // The listing carries no plaintext at all — an agent may know a credential
    // exists without ever being able to hold it.
    expect(JSON.stringify(seen)).not.toContain("plaintext")
  })

  test("another user's entries are never listed", async () => {
    await putEntry(db, theirs, "global", 0, "NOTYOURS", "secret", "nope")
    expect(await visibleTo(db, mine, boxId, workspaceId)).toEqual([])
  })
})

describe("scope ownership", () => {
  test("global is only ever scope 0", async () => {
    expect(await ownsScope(db, mine, "global", 0)).toBe(true)
    expect(await ownsScope(db, mine, "global", 5)).toBe(false)
  })

  test("your own workspace and box are yours", async () => {
    expect(await ownsScope(db, mine, "workspace", workspaceId)).toBe(true)
    expect(await ownsScope(db, mine, "box", boxId)).toBe(true)
  })

  test("someone else's are not", async () => {
    // The scope id is an integer from the request; without this check, writing
    // into another account's workspace is a matter of guessing a number.
    expect(await ownsScope(db, theirs, "workspace", workspaceId)).toBe(false)
    expect(await ownsScope(db, theirs, "box", boxId)).toBe(false)
  })

  test("a deleted workspace is not a place to keep anything", async () => {
    await db.execute(
      from("workspaces")
        .where(q => q("id").equals(workspaceId))
        .update({ deleted_at: new Date() }),
    )
    expect(await ownsScope(db, mine, "workspace", workspaceId)).toBe(false)
  })

  test("a destroyed box is not either", async () => {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ destroyed_at: new Date() }),
    )
    expect(await ownsScope(db, mine, "box", boxId)).toBe(false)
  })

  test("nonsense scope ids are refused", async () => {
    expect(await ownsScope(db, mine, "box", 0)).toBe(false)
    expect(await ownsScope(db, mine, "box", -1)).toBe(false)
    expect(await ownsScope(db, mine, "workspace", 1.5)).toBe(false)
  })
})

describe("a box's own credential", () => {
  test("authenticates the box it was minted for", async () => {
    const token = await rotateVaultToken(db, boxId)
    const box = await boxFor(db, token)
    expect(box?.id).toBe(boxId)
  })

  test("is stored as a hash, never in the clear", async () => {
    const token = await rotateVaultToken(db, boxId)
    const row = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
    expect(row.vault_token_hash).not.toBe(token)
    expect(row.vault_token_hash).toHaveLength(64)
    // The whole row, so this fails if the token is ever added to another column.
    expect(JSON.stringify(row)).not.toContain(token)
  })

  test("rotating invalidates the previous one", async () => {
    const first = await rotateVaultToken(db, boxId)
    const second = await rotateVaultToken(db, boxId)
    expect(await boxFor(db, first)).toBeNull()
    expect((await boxFor(db, second))?.id).toBe(boxId)
  })

  test("a destroyed box authenticates as nothing", async () => {
    // Which is what makes revocation just destroying the box.
    const token = await rotateVaultToken(db, boxId)
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ destroyed_at: new Date() }),
    )
    expect(await boxFor(db, token)).toBeNull()
  })

  test("nothing authenticates as an empty or unknown token", async () => {
    expect(await boxFor(db, "")).toBeNull()
    expect(await boxFor(db, "not-a-real-token")).toBeNull()
    // A box that has never been provisioned has an empty hash column; the empty
    // string must not match it.
    const fresh = (await db.execute(
      from("boxes")
        .insert({
          user_id: mine,
          name: "unprovisioned",
          hostname: "u.devpipe.com",
          region: "nyc3",
          size: "s-1vcpu-1gb",
          status: "creating",
          agent_token: "t",
          manifest: "{}",
        })
        .returning("id"),
    )) as any[]
    expect(await boxFor(db, "")).toBeNull()
    expect(fresh[0].id).toBeGreaterThan(0)
  })
})

describe("granting a box a secret", () => {
  const grant = async (entryName: string) => {
    const entry = (await db.one(
      from("vault_entries")
        .where(q => q("user_id").equals(mine))
        .where(q => q("name").equals(entryName)),
    )) as any
    await db.execute(from("vault_grants").insert({ user_id: mine, box_id: boxId, entry_id: entry.id }))
  }

  test("a secret is not readable by a box until it is granted", async () => {
    await putEntry(db, mine, "global", 0, "APIKEY", "secret", "sk-not-real")
    const before = await visibleTo(db, mine, boxId, workspaceId)
    // The name is visible — knowing a credential exists is not the same as
    // holding it — but nothing has been granted.
    expect(before).toEqual([{ name: "APIKEY", kind: "secret", scope: "global" }])
    const grants = (await db.all(from("vault_grants").where(q => q("box_id").equals(boxId)))) as any[]
    expect(grants).toHaveLength(0)
  })

  test("a grant is keyed to the entry, not the name", async () => {
    // So granting a global APIKEY does not silently extend to a box-scoped
    // APIKEY created later — the quiet privilege creep nobody reviews.
    await putEntry(db, mine, "global", 0, "APIKEY", "secret", "global-key")
    await grant("APIKEY")

    await putEntry(db, mine, "box", boxId, "APIKEY", "secret", "box-key")
    const rows = (await db.all(
      from("vault_entries")
        .where(q => q("user_id").equals(mine))
        .where(q => q("name").equals("APIKEY")),
    )) as any[]
    expect(rows).toHaveLength(2)

    const granted = (await db.all(from("vault_grants").where(q => q("box_id").equals(boxId)))) as any[]
    expect(granted).toHaveLength(1)
    // The grant still points at the global entry, and the box-scoped one — the
    // entry that now *shadows* it — is not covered by it.
    const globalRow = rows.find(r => r.scope === "global")
    expect(granted[0].entry_id).toBe(globalRow.id)
  })

  test("deleting the entry takes its grants with it", async () => {
    await putEntry(db, mine, "global", 0, "GONE", "secret", "x")
    await grant("GONE")
    expect((await db.all(from("vault_grants").where(q => q("box_id").equals(boxId)))) as any[]).toHaveLength(1)

    await db.execute(
      from("vault_entries")
        .where(q => q("user_id").equals(mine))
        .where(q => q("name").equals("GONE"))
        .del(),
    )
    // ON DELETE CASCADE: a grant pointing at nothing would be a permission
    // nobody can see and nobody can revoke.
    expect((await db.all(from("vault_grants").where(q => q("box_id").equals(boxId)))) as any[]).toHaveLength(0)
  })

  test("destroying the box takes its grants with it too", async () => {
    await putEntry(db, mine, "global", 0, "KEY2", "secret", "x")
    await grant("KEY2")
    await db.execute(from("boxes").where(q => q("id").equals(boxId)).del())
    expect((await db.all(from("vault_grants").where(q => q("user_id").equals(mine)))) as any[]).toHaveLength(0)
  })
})
