import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { previewHost, previewRoutes } from "../src/previews/index.ts"
import { setSetting, SETTING } from "../src/settings/index.ts"
import { shareRoutes, shareSocket } from "../src/shares/index.ts"
import { sign, unsign } from "../src/util/signed.ts"
import { sha256Hex } from "../src/util/token.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * Showing somebody something on your box without giving them your box.
 *
 * Two features, one file, because they are the same claim made twice: a URL
 * that reaches a port, and a URL that reaches a terminal, neither of which may
 * ever carry the box's own credential. Most of what is worth testing here is
 * refusal.
 */

const APP = "https://app.test"
const DOMAIN = "devpipe.test"

const realFetch = globalThis.fetch
let fetchApp: (req: Request) => Promise<Response>
let host: ReturnType<typeof previewHost>
let socket: ReturnType<typeof shareSocket>

let userId = 0
let otherId = 0
let boxId = 0
let token = ""

/** What the box would have answered, so the proxy has something to reach. */
const stubBox = (reply: (url: string, init: any) => Response) => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    if (url.startsWith("https://box.")) return reply(url, init)
    return realFetch(input, init)
  }) as any
}

const account = async (email: string, username: string) => {
  const rows = (await db.execute(
    from("users").insert({ email, username, password: "x" }).returning("id"),
  )) as any[]
  return rows[0].id as number
}

const session = async (id: number) => {
  const raw = `tok-${id}-${Math.random().toString(36).slice(2)}`
  await db.execute(
    from("sessions").insert({
      user_id: id,
      token_hash: sha256Hex(raw),
      expires_at: new Date(Date.now() + 3_600_000),
    }),
  )
  return raw
}

const call = async (method: string, path: string, body?: unknown, bearer?: string) => {
  const res = await fetchApp(
    new Request(`http://test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

/** A request as it arrives on a preview's own hostname. */
const onPreview = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { host: new URL(url).host, ...(init.headers ?? {}) } })

beforeEach(async () => {
  await truncateAll()
  globalThis.fetch = realFetch
  await setSetting(db, SETTING.domain, DOMAIN)

  userId = await account("a@b.co", "alfa")
  otherId = await account("c@d.co", "bravo")
  token = await session(userId)

  const boxes = (await db.execute(
    from("boxes")
      .insert({
        user_id: userId,
        name: "one",
        hostname: `box.${DOMAIN}`,
        region: "nyc3",
        size: "s-1vcpu-1gb",
        status: "ready",
        agent_token: "box-secret",
        manifest: "{}",
      })
      .returning("id"),
  )) as any[]
  boxId = boxes[0].id

  fetchApp = router(...previewRoutes(db), ...shareRoutes(db, APP)) as any
  host = previewHost(db, APP)
  socket = shareSocket(db)
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("previewing a port", () => {
  test("a preview gets a hostname of its own under the box domain", async () => {
    const { status, data } = await call("POST", `/boxes/${boxId}/previews`, { port: 5173 }, token)
    expect(status).toBe(201)
    // A single label, because that is what the existing wildcard record covers.
    // Anything deeper needs a wildcard certificate, which needs DNS-01.
    expect(data.url).toMatch(new RegExp(`^https://p-[a-z0-9]+\\.${DOMAIN}$`))
    expect(data.audience).toBe("private")
  })

  test("asking twice for the same port does not make a second hostname", async () => {
    const first = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const again = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    expect(again.status).toBe(200)
    expect(again.data.url).toBe(first.data.url)
  })

  test("the daemon's own port is not previewable", async () => {
    // It would put a box's control surface on a public hostname with nothing
    // but a guessable bearer behind it.
    const { status } = await call("POST", `/boxes/${boxId}/previews`, { port: 7788 }, token)
    expect(status).toBe(400)
  })

  test("not somebody else's box", async () => {
    const theirs = await session(otherId)
    const { status } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, theirs)
    expect(status).toBe(404)
  })
})

describe("guessing", () => {
  test("a preview hostname is a credential, and is sized like one", async () => {
    // For a `link` preview the hostname is the whole thing standing between a
    // stranger and somebody's staging site. Ten characters of this alphabet is
    // about 47 bits; twenty-two is about 104.
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const label = new URL(data.url).host.split(".")[0] as string
    expect(label.length).toBeGreaterThanOrEqual(24)
    expect(label).toMatch(/^p-[bcdfghjkmnpqrstvwxz23456789]{22}$/)
  })

  test("a search through the preview namespace is counted, and a real one is not", async () => {
    // Only misses. A preview serves a website and one page load is thirty
    // requests — metering those would break the feature to defend nothing,
    // because somebody with a working link already has what the limit protects.
    const seek = (n: number) =>
      onPreview(`https://p-doesnotexist${n}.${DOMAIN}/`, { headers: { "x-forwarded-for": "198.51.100.7" } })

    let refused = 0
    for (let n = 0; n < 70; n++) {
      const res = await host.handle(seek(n))
      if (res?.status === 429) refused++
    }
    expect(refused).toBeGreaterThan(0)

    // A live preview from the same address still answers, because nothing
    // counted its requests in the first place.
    stubBox(() => new Response("ok", { status: 200 }))
    const mine = await call("POST", `/boxes/${boxId}/previews`, { port: 3000, audience: "link" }, token)
    const res = await host.handle(
      onPreview(`${mine.data.url}/`, { headers: { "x-forwarded-for": "198.51.100.7" } }),
    )
    expect(res?.status).toBe(200)
  })

  test("a search through the share tokens is counted", async () => {
    let refused = 0
    for (let n = 0; n < 40; n++) {
      const { status } = await call("GET", `/shares/guess-${n}`)
      if (status === 429) refused++
    }
    expect(refused).toBeGreaterThan(0)
  })
})

describe("what Caddy is told to issue a certificate for", () => {
  test("yes for a live preview, no for anything else", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const name = new URL(data.url).host

    expect((await call("GET", `/previews/allow?domain=${name}`)).status).toBe(200)
    expect((await call("GET", `/previews/allow?domain=nope.${DOMAIN}`)).status).toBe(404)
    // The one that matters: without it, anybody pointing a name at this address
    // makes the instance fetch a certificate on their behalf.
    expect((await call("GET", "/previews/allow?domain=evil.example.com")).status).toBe(404)
  })

  test("no once it is revoked", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const name = new URL(data.url).host
    await call("DELETE", `/previews/${data.id}`, undefined, token)
    expect((await call("GET", `/previews/allow?domain=${name}`)).status).toBe(404)
  })
})

describe("who may open a preview", () => {
  test("a private one sends a browser to the app to be admitted", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const res = await host.handle(onPreview(`${data.url}/some/page?x=1`))
    expect(res?.status).toBe(302)
    // Carrying where it was going, so being admitted lands on the page asked
    // for rather than on the dev server's root.
    expect(res?.headers.get("location")).toBe(
      `${APP}/preview/${new URL(data.url).host.split(".")[0]}?to=${encodeURIComponent("/some/page?x=1")}`,
    )
  })

  test("a link one does not, because the link is the credential", async () => {
    stubBox(() => new Response("<h1>hello</h1>", { status: 200, headers: { "content-type": "text/html" } }))
    const { data } = await call(
      "POST",
      `/boxes/${boxId}/previews`,
      { port: 3000, audience: "link" },
      token,
    )
    const res = await host.handle(onPreview(`${data.url}/`))
    expect(res?.status).toBe(200)
    expect(await res?.text()).toContain("hello")
  })

  test("a granted cookie opens the private one, and only that one", async () => {
    const mine = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const other = await call("POST", `/boxes/${boxId}/previews`, { port: 4000 }, token)
    const slug = new URL(mine.data.url).host.split(".")[0] as string

    // The app's own session is a cookie it cannot read, so what it passes to
    // another origin is a code that means one preview for one minute.
    const asked = await call("GET", `/previews/${slug}/origin`, undefined, token)
    expect(asked.status).toBe(200)
    const granted = await host.handle(
      onPreview(`${mine.data.url}/__dp/grant`, {
        method: "POST",
        headers: { origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ code: asked.data.code }),
      }),
    )
    expect(granted?.status).toBe(200)
    const cookie = granted?.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    // Host-only. A Domain attribute would send this to the app, to every box,
    // and to every other preview on the instance.
    expect(cookie.toLowerCase()).not.toContain("domain=")

    const value = cookie.split(";")[0] ?? ""
    stubBox(() => new Response("ok", { status: 200 }))
    const opened = await host.handle(onPreview(`${mine.data.url}/`, { headers: { cookie: value } }))
    expect(opened?.status).toBe(200)

    // The same cookie is not a key to the account's other ports.
    const refused = await host.handle(onPreview(`${other.data.url}/`, { headers: { cookie: value } }))
    expect(refused?.status).toBe(302)
  })

  test("no code for somebody else's preview", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const slug = new URL(data.url).host.split(".")[0] as string
    const theirs = await session(otherId)
    // 404 rather than 403: telling a stranger the slug is real is telling them
    // what to keep.
    expect((await call("GET", `/previews/${slug}/origin`, undefined, theirs)).status).toBe(404)
  })

  test("a code for one preview does not open another", async () => {
    const mine = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const other = await call("POST", `/boxes/${boxId}/previews`, { port: 4000 }, token)
    const slug = new URL(mine.data.url).host.split(".")[0] as string
    const asked = await call("GET", `/previews/${slug}/origin`, undefined, token)

    const res = await host.handle(
      onPreview(`${other.data.url}/__dp/grant`, {
        method: "POST",
        headers: { origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ code: asked.data.code }),
      }),
    )
    expect(res?.status).toBe(403)
  })

  test("a made-up code opens nothing", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const res = await host.handle(
      onPreview(`${data.url}/__dp/grant`, {
        method: "POST",
        headers: { origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ code: "not.a.signature" }),
      }),
    )
    expect(res?.status).toBe(403)
  })

  test("the grant is refused from anywhere but the app", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/previews`, { port: 3000 }, token)
    const slug = new URL(data.url).host.split(".")[0] as string
    const asked = await call("GET", `/previews/${slug}/origin`, undefined, token)
    const res = await host.handle(
      onPreview(`${data.url}/__dp/grant`, {
        method: "POST",
        headers: { origin: "https://evil.example.com", "content-type": "application/json" },
        body: JSON.stringify({ code: asked.data.code }),
      }),
    )
    expect(res?.status).toBe(403)
  })

  test("a hostname that is not a preview is not this handler's business", async () => {
    expect(await host.handle(onPreview(`https://app.${DOMAIN}/`))).toBeNull()
    expect(await host.handle(onPreview("https://example.com/"))).toBeNull()
  })
})

describe("what the box is asked", () => {
  test("the box's credential goes to the box and nowhere else", async () => {
    let seen: any = null
    let target = ""
    stubBox((url, init) => {
      target = url
      seen = init
      return new Response("ok", { status: 200 })
    })
    const { data } = await call(
      "POST",
      `/boxes/${boxId}/previews`,
      { port: 5173, audience: "link" },
      token,
    )
    await host.handle(
      onPreview(`${data.url}/assets/app.js?v=2`, { headers: { cookie: "dp_preview=forged; theirs=1" } }),
    )

    expect(target).toBe(`https://box.${DOMAIN}/v1/proxy/5173/assets/app.js?v=2`)
    expect(seen.headers.get("authorization")).toBe("Bearer box-secret")
    // Ours is stripped and theirs is not: the previewed application gets its
    // own cookies back and none of this origin's.
    expect(seen.headers.get("cookie")).toBe("theirs=1")
  })

  test("a box running a daemon from before previews says which fix applies", async () => {
    // Its router has no /v1/proxy, so it 404s everything — which is exactly
    // what a dev server with no such route does, and sends somebody to debug
    // their own application instead of waking the box.
    stubBox(() => new Response(null, { status: 404 }))
    const { data } = await call(
      "POST",
      `/boxes/${boxId}/previews`,
      { port: 3000, audience: "link" },
      token,
    )
    const res = await host.handle(onPreview(`${data.url}/`))
    expect(res?.status).toBe(502)
    expect(await res?.text()).toContain("wake it")
  })

  test("a dev server's own 404 is passed through as one", async () => {
    stubBox(() => new Response("Cannot GET /nope", { status: 404, headers: { "x-devpipe-proxy": "1" } }))
    const { data } = await call(
      "POST",
      `/boxes/${boxId}/previews`,
      { port: 3000, audience: "link" },
      token,
    )
    const res = await host.handle(onPreview(`${data.url}/nope`))
    expect(res?.status).toBe(404)
    expect(await res?.text()).toContain("Cannot GET")
    // The marker is ours and stops here.
    expect(res?.headers.get("x-devpipe-proxy")).toBeNull()
  })

  test("a sleeping box says so instead of failing", async () => {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ status: "asleep" }),
    )
    const { data } = await call(
      "POST",
      `/boxes/${boxId}/previews`,
      { port: 3000, audience: "link" },
      token,
    )
    const res = await host.handle(onPreview(`${data.url}/`))
    expect(res?.status).toBe(503)
    expect(await res?.text()).toContain("asleep")
  })
})

describe("sharing a terminal", () => {
  test("watching is what you get unless you ask for more", async () => {
    const { status, data } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1" }, token)
    expect(status).toBe(201)
    expect(data.mode).toBe("watch")
    expect(data.url).toContain(`${APP}/watch/`)
  })

  test("the link is shown once and never stored", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1" }, token)
    const listed = await call("GET", `/boxes/${boxId}/shares`, undefined, token)
    expect(listed.data[0].url).toBeNull()

    // And what is stored is a hash of it, not it.
    const row = (await db.one(from("shares").where(q => q("id").equals(data.id)))) as any
    const secret = String(data.url).split("/watch/")[1]
    expect(row.token_hash).toBe(sha256Hex(secret as string))
  })

  test("a guest is told what they are opening and nothing else", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1" }, token)
    const secret = String(data.url).split("/watch/")[1]
    const { status, data: seen } = await call("GET", `/shares/${secret}`)
    expect(status).toBe(200)
    expect(seen.mode).toBe("watch")
    // Not whose box it is, not where it is, not what is running in it.
    expect(seen.hostname).toBeUndefined()
    expect(seen.session_id).toBeUndefined()
  })

  test("a revoked link is closed", async () => {
    const { data } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1" }, token)
    const secret = String(data.url).split("/watch/")[1]
    await call("DELETE", `/shares/${data.id}`, undefined, token)
    expect((await call("GET", `/shares/${secret}`)).status).toBe(404)
  })

  test("not somebody else's box", async () => {
    const theirs = await session(otherId)
    const { status } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1" }, theirs)
    expect(status).toBe(404)
  })
})

describe("the socket a guest gets", () => {
  const upgrade = (secret: string) =>
    new Request(`http://test/api/shares/${secret}/socket`, { headers: { upgrade: "websocket" } })

  const secretFor = async (mode?: string) => {
    const { data } = await call("POST", `/boxes/${boxId}/shares`, { session_id: "s1", mode }, token)
    return { secret: String(data.url).split("/watch/")[1] as string, id: data.id as number }
  }

  test("a watcher's socket drops everything travelling towards the box", async () => {
    const { secret } = await secretFor()
    const found = await socket(upgrade(secret))
    expect(found?.readOnly).toBe(true)
    // Terminating on the control plane is the whole point: it is the only place
    // read-only can be enforced, because the daemon has one credential and it
    // is all-powerful.
    expect(found?.url).toContain(`wss://box.${DOMAIN}/v1/sessions/s1/attach`)
  })

  test("a share made for typing is not read-only", async () => {
    const { secret } = await secretFor("control")
    expect((await socket(upgrade(secret)))?.readOnly).toBe(false)
  })

  test("a revoked share connects to nothing", async () => {
    const { secret, id } = await secretFor()
    await call("DELETE", `/shares/${id}`, undefined, token)
    expect(await socket(upgrade(secret))).toBeNull()
  })

  test("an expired share connects to nothing", async () => {
    const { secret, id } = await secretFor()
    await db.execute(
      from("shares")
        .where(q => q("id").equals(id))
        .update({ expires_at: new Date(Date.now() - 1000) }),
    )
    expect(await socket(upgrade(secret))).toBeNull()
  })

  test("a made-up token connects to nothing", async () => {
    expect(await socket(upgrade("not-a-real-token"))).toBeNull()
  })

  test("watching keeps the box from being reclaimed underneath it", async () => {
    await db.execute(
      from("boxes")
        .where(q => q("id").equals(boxId))
        .update({ last_active_at: new Date(Date.now() - 86_400_000) }),
    )
    const { secret } = await secretFor()
    await socket(upgrade(secret))
    // The update is fired without being awaited, so give it the turn it needs.
    await new Promise(resolve => setTimeout(resolve, 50))
    const box = (await db.one(from("boxes").where(q => q("id").equals(boxId)))) as any
    expect(Date.now() - new Date(box.last_active_at).getTime()).toBeLessThan(60_000)
  })
})

describe("the signature on an admitted browser", () => {
  test("survives a round trip and nothing else", () => {
    const token = sign("preview:7", 60)
    expect(unsign(token)).toBe("preview:7")
    expect(unsign(`${token}x`)).toBeNull()
    expect(unsign(token.replace("preview:7", "preview:8"))).toBeNull()
    expect(unsign("nonsense")).toBeNull()
  })

  test("an expired one is not accepted", () => {
    expect(unsign(sign("preview:7", -1))).toBeNull()
  })
})
