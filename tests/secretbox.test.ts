import { beforeAll, describe, expect, test } from "bun:test"
import { open, seal, secretsAvailable } from "../src/util/secretbox.ts"

/**
 * An agent's login is the one thing here that is not this instance's secret.
 * It belongs to whoever signed in, reaches their account rather than anything
 * of ours, and can spend their money.
 */

beforeAll(() => {
  process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
})

describe("sealing a login", () => {
  test("round-trips", async () => {
    const secret = JSON.stringify({ accessToken: "sk-ant-oat-not-real", refreshToken: "also-not-real" })
    expect(await open(await seal(secret))).toBe(secret)
  })

  test("the same login twice does not produce the same row", async () => {
    // A fresh nonce per encryption. Without it, equal ciphertexts tell anyone
    // reading the table which users share a login, and repeated writes of an
    // unchanged token become a visible pattern.
    expect(await seal("same")).not.toBe(await seal("same"))
  })

  test("survives unicode and newlines, because JSON credential files have both", async () => {
    const awkward = '{"note":"café ☕\\nsecond line","t":"…"}'
    expect(await open(await seal(awkward))).toBe(awkward)
  })

  test("a tampered value does not decrypt into something else", async () => {
    // GCM authenticates. The failure that matters is not "unreadable" but
    // "readable as something the attacker chose".
    const sealed = await seal("original")
    const [v, nonce, body] = sealed.split(".")
    const flipped = `${body.slice(0, -2)}${body.slice(-2) === "AA" ? "AB" : "AA"}`
    expect(await open(`${v}.${nonce}.${flipped}`)).toBeNull()
  })

  test("a value from another key is refused, not guessed at", async () => {
    const sealed = await seal("mine")
    process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
    // Null rather than a throw: a login sealed under a rotated key is not an
    // error to propagate, it is a login that has to be done once more.
    expect(await open(sealed)).toBeNull()
    process.env.DEVPIPE_SECRET_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  })

  test("nonsense is refused rather than throwing", async () => {
    expect(await open("not-sealed-at-all")).toBeNull()
    expect(await open("")).toBeNull()
  })
})

describe("an instance with no key", () => {
  test("says so instead of storing logins in the clear", async () => {
    // The dangerous failure would be a silent fallback: an instance quietly
    // keeping agent logins as plaintext while every screen said otherwise.
    const had = process.env.DEVPIPE_SECRET_KEY
    process.env.DEVPIPE_SECRET_KEY = ""
    expect(secretsAvailable()).toBe(false)
    await expect(seal("anything")).rejects.toThrow(/DEVPIPE_SECRET_KEY/)
    process.env.DEVPIPE_SECRET_KEY = had
  })

  test("refuses a key of the wrong length rather than padding it", async () => {
    const had = process.env.DEVPIPE_SECRET_KEY
    process.env.DEVPIPE_SECRET_KEY = btoa("short")
    await expect(seal("anything")).rejects.toThrow(/32 bytes/)
    process.env.DEVPIPE_SECRET_KEY = had
  })
})

describe("binding a value to where it belongs", () => {
  // Encryption stops a value being read out of a backup. It does not stop a
  // sealed value being *moved* — and in a vault, where the row's scope decides
  // who may read it, moving a row is the whole attack.

  test("opens only with the context it was sealed under", async () => {
    const sealed = await seal("sk-live-not-real", "vault:v1:1:global:0:STRIPE")
    expect(await open(sealed, "vault:v1:1:global:0:STRIPE")).toBe("sk-live-not-real")
  })

  test("another user's row does not decrypt in your entry", async () => {
    // The row copied verbatim into user 2's vault. Same key, same bytes.
    const theirs = await seal("their-key", "vault:v1:1:global:0:OPENAI")
    expect(await open(theirs, "vault:v1:2:global:0:OPENAI")).toBeNull()
  })

  test("a row cannot be moved to a wider scope", async () => {
    // Promoting a box-scoped entry to global would hand it to every box.
    const boxed = await seal("box-only", "vault:v1:1:box:42:TOKEN")
    expect(await open(boxed, "vault:v1:1:global:0:TOKEN")).toBeNull()
    expect(await open(boxed, "vault:v1:1:box:43:TOKEN")).toBeNull()
  })

  test("a row cannot be renamed into another name's slot", async () => {
    const sealed = await seal("value-of-A", "vault:v1:1:global:0:A")
    expect(await open(sealed, "vault:v1:1:global:0:B")).toBeNull()
  })

  test("an unbound value does not open as a bound one, or the reverse", async () => {
    // The two forms are not interchangeable: agent logins seal without context
    // and must not be openable by guessing a vault context, nor vice versa.
    const unbound = await seal("plain")
    expect(await open(unbound, "vault:v1:1:global:0:X")).toBeNull()
    const bound = await seal("scoped", "vault:v1:1:global:0:X")
    expect(await open(bound)).toBeNull()
  })
})
