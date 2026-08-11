import { describe, expect, test } from "bun:test"
import { planFor } from "../src/billing/plans.ts"
import { CATALOG, fits, memoryFor, SIZES } from "../src/boxes/catalog.ts"
import { ADMIN_TABS, href as routeHref, WORKSPACE_PATH } from "../src/web/routes.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The static pages under `site/` are a hand-written copy of numbers that live
 * in the catalog. Nothing links the two, so the way they go wrong is quietly:
 * somebody changes a droplet size or a tool's footprint and the published
 * price stops matching what the card is charged. These tests are the link.
 */

const PAGES = ["index.html", "terms.html", "privacy.html", "aup.html"]

/**
 * Paths the web tier answers with the app shell rather than with a file in
 * `site/`. Built from the router rather than written out, so a view that gets
 * renamed turns the lander's link into a failure here instead of into a page
 * that loads the workspace when it meant to load something else.
 */
const APP_PATHS = new Set<string>([
  WORKSPACE_PATH,
  routeHref({ view: "billing", tab: "overview" }),
  routeHref({ view: "settings", tab: "overview" }),
  ...ADMIN_TABS.map(tab => routeHref({ view: "admin", tab })),
])

const read = (name: string) => Bun.file(`${import.meta.dir}/../site/${name}`).text()

describe("the pages themselves", () => {
  test("cross-page links point at files that exist, and anchors that do", async () => {
    const bodies = new Map(await Promise.all(PAGES.map(async n => [n, await read(n)] as const)))
    const ids = new Map([...bodies].map(([n, b]) => [n, new Set([...b.matchAll(/id="([^"]+)"/g)].map(m => m[1]))]))

    for (const [name, body] of bodies) {
      for (const [, fragment] of body.matchAll(/href="#([^"]+)"/g)) {
        expect(ids.get(name)?.has(fragment), `${name} links to missing anchor #${fragment}`).toBe(true)
      }
      for (const [, link] of body.matchAll(/href="(\/[^"]*)"/g)) {
        if (link === "/" || link.startsWith("/fonts/") || APP_PATHS.has(link)) continue
        const [page, fragment] = link.slice(1).split("#")
        expect(bodies.has(page), `${name} links to missing page ${link}`).toBe(true)
        if (fragment) expect(ids.get(page)?.has(fragment), `${name} links to missing anchor ${link}`).toBe(true)
      }
    }
  })

  test("the drafts are still marked noindex", async () => {
    // Removing this is a launch step. A draft that says it binds nobody must
    // not be the thing a search engine quotes back at us.
    for (const name of PAGES.filter(n => n !== "index.html")) {
      expect(await read(name), `${name} is indexable`).toContain('name="robots" content="noindex"')
    }
  })

  test("the lander links to all of them", async () => {
    const lander = await read("index.html")
    for (const name of PAGES.filter(n => n !== "index.html")) {
      expect(lander, `the lander does not link to ${name}`).toContain(`href="/${name}"`)
    }
  })

  test("the lander offers a way into the app", async () => {
    // The only door. `/` is the lander, so without a link here the app is
    // reachable only by knowing the path to type — which was the state of
    // things, and reads as "the product does not exist yet".
    expect(await read("index.html")).toContain(`href="${WORKSPACE_PATH}"`)
  })

  test("the lander's script is external", async () => {
    // An inline <script> forces 'unsafe-inline' into script-src for the whole
    // origin, and the session token is in localStorage. The policy in
    // security/headers.ts refuses it; this is what keeps the two in step.
    const lander = await read("index.html")
    expect(lander).not.toMatch(/<script(?![^>]*\bsrc=)/)
    expect(lander).toContain('src="/lander.js"')
  })
})
