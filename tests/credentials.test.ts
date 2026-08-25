import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import {
  CREDENTIAL,
  credentialsSealed,
  getCredential,
  setCredential,
} from "../src/settings/index.ts"
import { shortId } from "../src/util/token.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The instance's own secrets, at rest.
 *
 * These were plaintext, and of everything in this database they are the worst
 * things to leave that way: the DigitalOcean token creates and destroys every
 * droplet on the account and spends money with no ceiling, and backups of this
 * table are rsynced off the database host. Agent logins have been encrypted
 * since they shipped because they "can spend their money" — the same sentence
 * is true of these, about ours.
 */

const had = process.env.DEVPIPE_SECRET_KEY

beforeEach(async () => {
  await truncateAll()
  process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))
})

afterAll(() => {
  if (had === undefined) delete process.env.DEVPIPE_SECRET_KEY
  else process.env.DEVPIPE_SECRET_KEY = had
})

const stored = async (key: string) =>
  ((await db.one(from("credentials").where(q => q("key").equals(key)))) as any)?.value ?? null

describe("credentials at rest", () => {
  test("what the database holds is not the token", async () => {
    await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_realtokenvalue")
    const raw = await stored(CREDENTIAL.digitalOceanToken)
    expect(raw).not.toContain("dop_v1_realtokenvalue")
    expect(raw.startsWith("v1.")).toBe(true)
    // And it still comes back, or this is encryption of something unusable.
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBe("dop_v1_realtokenvalue")
    expect(credentialsSealed()).toBe(true)
  })

  test("a sealed value cannot be moved into another row", async () => {
    // Encryption stops a value being read. Only binding stops it being *moved*
    // — without it, any sealed value in this table could be copied into the
    // provider row and the instance would decrypt it happily and hand it to
    // DigitalOcean.
    const OTHER = "some_other_credential"
    await setCredential(db, OTHER, "not-the-provider-token")
    const sealed = await stored(OTHER)
    await db.execute(
      from("credentials")
        .where(q => q("key").equals(CREDENTIAL.digitalOceanToken))
        .del(),
    )
    await db.execute(from("credentials").insert({ key: CREDENTIAL.digitalOceanToken, value: sealed }))

    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBeNull()
    expect(await getCredential(db, OTHER)).toBe("not-the-provider-token")
  })

  test("a value written before this existed still opens, and stops being plaintext", async () => {
    // Upgrading must not take provisioning down, so a plaintext row is read as
    // one — and sealed on the way past, so it stops being plaintext at the
    // first read rather than at the next write, which for a provider token
    // could be never.
    await db.execute(
      from("credentials").insert({ key: CREDENTIAL.digitalOceanToken, value: "dop_v1_fromtheoldworld" }),
    )
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBe("dop_v1_fromtheoldworld")

    // The re-seal is fired without being awaited, so give it the turn it needs.
    await new Promise(resolve => setTimeout(resolve, 50))
    const raw = await stored(CREDENTIAL.digitalOceanToken)
    expect(raw.startsWith("v1.")).toBe(true)
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBe("dop_v1_fromtheoldworld")
  })

  test("a wrong key reads as nothing rather than as garbage", async () => {
    await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_realtokenvalue")
    process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBeNull()
  })

  test("without a key it stays readable, and says so", async () => {
    // Unlike an agent login, the provider token is what the product needs to
    // function: a control plane that refuses to store one cannot provision, and
    // that is not a safer control plane. What matters is that nothing claims
    // otherwise.
    process.env.DEVPIPE_SECRET_KEY = ""
    expect(credentialsSealed()).toBe(false)
    await setCredential(db, CREDENTIAL.digitalOceanToken, "dop_v1_plain")
    expect(await stored(CREDENTIAL.digitalOceanToken)).toBe("dop_v1_plain")
    expect(await getCredential(db, CREDENTIAL.digitalOceanToken)).toBe("dop_v1_plain")
  })
})

describe("the identifiers that are also credentials", () => {
  test("a slug is drawn without favouring the first half of the alphabet", () => {
    // `byte % 27` is not uniform — 256 is not a multiple of 27, so the first
    // thirteen letters used to come up about 11% more often. For a hostname
    // that is a curiosity; a preview's slug is the whole credential for a
    // shared link, and a generator that is not uniform has fewer bits than its
    // length suggests.
    const alphabet = "bcdfghjkmnpqrstvwxz23456789"
    const counts = new Map<string, number>()
    for (const ch of shortId(200_000)) counts.set(ch, (counts.get(ch) ?? 0) + 1)

    expect(counts.size).toBe(alphabet.length)
    const head = alphabet
      .slice(0, 13)
      .split("")
      .reduce((n, c) => n + (counts.get(c) ?? 0), 0)
    const tail = alphabet
      .slice(13)
      .split("")
      .reduce((n, c) => n + (counts.get(c) ?? 0), 0)
    // Per-character, so the uneven split of 13 and 14 does not itself skew it.
    const ratio = head / 13 / (tail / 14)
    expect(ratio).toBeLessThan(1.02)
    expect(ratio).toBeGreaterThan(0.98)
  })

  test("only the alphabet, and exactly the length asked for", () => {
    // No vowels, so a hostname cannot accidentally spell anything, and no 0/O
    // or 1/l for anyone reading one aloud.
    const drawn = shortId(64)
    expect(drawn).toHaveLength(64)
    expect(drawn).toMatch(/^[bcdfghjkmnpqrstvwxz23456789]+$/)
  })
})
