import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { securityHeaders } from "../security/headers.ts"
import { prepareIndexHtml } from "./html.ts"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)
// Only reaches the policy, which needs the wildcard the boxes live under so a
// terminal can open a socket to one.
const BOX_DOMAIN = process.env.BOX_DOMAIN ?? "devpipe.com"
// Loopback in production: Caddy is the only thing that should reach this, and
// a request that arrives without passing through it carries whatever
// x-forwarded-for it felt like sending.
const HOST = process.env.WEB_HOST ?? "0.0.0.0"

const HERE = dirname(new URL(import.meta.url).pathname)

// Every path is overridable, because in production this runs as a compiled
// binary: `import.meta.url` then points inside the embedded filesystem, where
// there is no source tree to bundle and no assets to find.
const DIST = process.env.WEB_DIST ?? resolve(HERE, "dist")
const SITE = process.env.SITE_DIR ?? resolve(HERE, "../../site")
const WASM = process.env.WASM_PATH ?? resolve(HERE, "../../core/target/wasm32-unknown-unknown/release/devpipecore.wasm")

// Bundle only when the source is actually on disk.
//
// The obvious condition is `NODE_ENV !== "production"`, and it does not work:
// Bun inlines `process.env.NODE_ENV` at *compile* time, so a binary built
// without it set carries `isDev = true` forever and tries to bundle itself
// from an embedded filesystem that has no source in it. Testing for the file
// is a runtime check that cannot be folded away, and it is the true condition
// anyway — without the entrypoint there is nothing to build.
const canBuild = existsSync(join(HERE, "index.html"))
if (canBuild) {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true })
  const out = await Bun.build({
    entrypoints: [join(HERE, "index.html")],
    outdir: DIST,
    target: "browser",
    minify: false,
    sourcemap: "inline",
  })
  if (!out.success) {
    for (const log of out.logs) console.error(log)
    throw new Error("web bundle failed")
  }
}

const indexHtml = prepareIndexHtml(await Bun.file(join(DIST, "index.html")).text())

const wasmBytes = existsSync(WASM) ? await Bun.file(WASM).arrayBuffer() : null
if (!wasmBytes) {
  console.warn("[devpipe] no vt.wasm — run: cd core && cargo build --release --target wasm32-unknown-unknown")
}
// Content-derived, so a rebuilt emulator is a different tag and a browser
// holding the old one is told to take the new one.
const wasmEtag = wasmBytes ? `"${Bun.hash(new Uint8Array(wasmBytes)).toString(16)}"` : '""'

/** Static pages that sit next to the lander in `site/`. */
const PAGES = new Set([
  "/terms.html",
  "/privacy.html",
  "/aup.html",
  "/asylum.html",
  "/asylum-docs.html",
  "/asylum-class.html",
])

/**
 * Stylesheets served from `site/`, allow-listed the same way the pages are.
 *
 * Separate from `PAGES` because that branch hard-codes `text/html`, and a
 * stylesheet answered as HTML is not applied by any browser — it fails as a
 * blank page rather than as an error anyone would think to look for.
 */
const STYLES = new Set(["/asylum.css"])

/**
 * The lander's behaviour, in a file rather than a `<script>` block.
 *
 * It is external for one reason: an inline script forces `'unsafe-inline'` into
 * `script-src`, and that single token is what turns any injection anywhere on
 * the origin into a readable session token. See `security/headers.ts`.
 */
const LANDER_SCRIPT = "/lander.js"

// Caddy sets these too. Sending them here as well is not redundant: it is what
// makes a local `bun run dev` behave like production, so a change that violates
// the policy fails on the machine that wrote it rather than after a deploy —
// and it means an instance put behind anything other than that Caddyfile is
// still covered.
const BASE_HEADERS = securityHeaders(BOX_DOMAIN)

const security = (headers: Record<string, string> = {}) => ({ ...BASE_HEADERS, ...headers })

// Everything the bundler emits except the entry document carries a content hash
// in its name, so the name changes whenever the bytes do.
const isHashedAsset = (path: string) => path !== "/index.html" && /-[a-z0-9]{8,}\.[a-z]+$/.test(path)

const IMMUTABLE = "public, max-age=31536000, immutable"

// Documents, and anything else whose name does not change when its bytes do.
// Still cached, just never used without asking first — which is what keeps a
// deploy from being invisible to whoever was already here.
const NO_CACHE = "no-cache"

/**
 * Refuses a path that is trying to climb out of the directory it will be joined
 * to.
 *
 * Nothing reaches this today. `url.pathname` comes from the WHATWG parser,
 * which resolves dot segments in both spellings — `%2e%2e` decodes and
 * normalises exactly like `..` — and clamps at the root, so
 * `/fonts/%2e%2e/%2e%2e/etc/passwd` arrives as `/etc/passwd` and the join stays
 * under the directory either way. Verified, not assumed.
 *
 * It stays because every static branch below joins a request path to a root,
 * and that safety is a property of where the path comes from rather than of the
 * code doing the joining. One refactor that reads a path from somewhere else —
 * a header, a query parameter, a router that hands back the raw target — and it
 * is gone silently.
 */
const climbs = (path: string) => path.includes("..") || /%2e/i.test(path) || path.includes("\0")

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    if (climbs(path)) {
      return new Response("Not found", { status: 404, headers: security({ "content-type": "text/plain" }) })
    }

    // The API is a separate process; the browser only ever talks to this one.
    if (path.startsWith("/api/")) {
      const target = new URL(path + url.search, API)
      try {
        return await fetch(new Request(target, req))
      } catch {
        // An API that is restarting, or has died, otherwise surfaces as the
        // runtime's own error page — HTML, with a stack in it, where the client
        // expects JSON. It parses as nothing and shows as "Request failed".
        return new Response(JSON.stringify({ error: "The API is not answering. Try again in a moment." }), {
          status: 502,
          headers: security({ "content-type": "application/json" }),
        })
      }
    }

    // The emulator itself.
    //
    // Revalidated, *not* immutable. This was served with a year of immutable
    // caching on the strength of "the bundle hash changes with it" — which is
    // true of the bundle and irrelevant here, because this URL carries no hash
    // of its own. A browser that had fetched it once would never ask again, so
    // shipping a new emulator left every returning visitor running the old one
    // until they cleared their cache.
    //
    // That failure is worse than it sounds: the loader checks for the exports
    // it needs, a stale module fails that check, and every terminal on the page
    // then refuses to open. The ETag makes the common case a 304 and a few
    // bytes rather than 350KB.
    if (path === "/vt.wasm") {
      if (!wasmBytes) return new Response("vt.wasm not built", { status: 503 })
      if (req.headers.get("if-none-match") === wasmEtag) {
        return new Response(null, { status: 304, headers: security({ etag: wasmEtag, "cache-control": NO_CACHE }) })
      }
      return new Response(wasmBytes, {
        headers: security({
          "content-type": "application/wasm",
          "cache-control": NO_CACHE,
          etag: wasmEtag,
        }),
      })
    }

    // The lander's script. Its name carries no hash, so it is revalidated
    // rather than cached: a deploy changes the file in place and a stale copy
    // would be a lander whose form posts to an endpoint that has moved.
    if (path === LANDER_SCRIPT) {
      const script = Bun.file(join(SITE, "lander.js"))
      if (await script.exists()) {
        return new Response(script, {
          headers: security({ "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }),
        })
      }
    }

    // The marketing page keeps the root. Someone arriving at devpipe.com is
    // more likely to be finding out what this is than to be signing in.
    if (path === "/" || path === "/index.html") {
      const lander = Bun.file(join(SITE, "index.html"))
      if (await lander.exists()) {
        return new Response(lander, { headers: security({ "content-type": "text/html", "cache-control": NO_CACHE }) })
      }
    }
    // The lander's siblings. They have to be named: everything unmatched below
    // is the app, so without this the terms page answers 200 with the app shell
    // — a wrong page rather than a missing one, which nobody reports as a bug.
    if (PAGES.has(path)) {
      const page = Bun.file(join(SITE, path))
      if (await page.exists()) {
        return new Response(page, {
          headers: security({ "content-type": "text/html; charset=utf-8", "cache-control": NO_CACHE }),
        })
      }
    }
    if (STYLES.has(path)) {
      const sheet = Bun.file(join(SITE, path))
      if (await sheet.exists()) {
        return new Response(sheet, {
          headers: security({ "content-type": "text/css; charset=utf-8", "cache-control": NO_CACHE }),
        })
      }
    }
    if (path.startsWith("/fonts/")) {
      const font = Bun.file(join(SITE, path))
      if (await font.exists()) {
        return new Response(font, { headers: security({ "cache-control": IMMUTABLE }) })
      }
    }

    // Built assets. The hashed ones are immutable by construction — a changed
    // bundle is a different filename — so a returning visitor re-fetches the
    // document and nothing else.
    const asset = Bun.file(join(DIST, path))
    if (path !== "/" && (await asset.exists())) {
      return new Response(asset, {
        headers: security(isHashedAsset(path) ? { "cache-control": IMMUTABLE } : {}),
      })
    }

    // Anything that looks like a file is a file, and a missing one is a 404.
    //
    // App routes are clean paths, so this cannot catch one. Falling through
    // instead means a missing asset is answered with the app shell — 200, and
    // `text/html` where a module was expected. That is how a wrong asset URL
    // presents as a blank page with an empty console rather than as a failed
    // request, and it is what a mistyped bundle name did until the paths in the
    // document were made absolute. On a top-level Safari navigation a .html
    // bookmark for a withdrawn page did the same thing.
    if (/\.[a-z0-9]{2,5}$/i.test(path)) {
      return new Response("Not found", { status: 404, headers: security({ "content-type": "text/plain" }) })
    }

    // Everything else is the app. No route allowlist: the app has several
    // views and a stale list here shows up as a 404 body, which on a top-level
    // Safari navigation manifests as a download prompt rather than an error.
    return new Response(indexHtml, {
      headers: security({ "content-type": "text/html; charset=utf-8", "cache-control": NO_CACHE }),
    })
  },
})

console.log(`[devpipe] web on :${server.port} (api ${API})`)
