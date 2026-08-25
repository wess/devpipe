import { describe, expect, test } from "bun:test"
import { CATALOG, fits, memoryFor, SIZES } from "../src/boxes/catalog.ts"
import { ADMIN_TABS, HOME_PATH, href as routeHref, WORKSPACE_PATH } from "../src/web/routes.ts"
import { db, truncateAll } from "./setup.ts"

/**
 * The static pages under `site/` are a hand-written copy of things that live in
 * the code. Nothing links the two, so the way they go wrong is quietly:
 * somebody renames a view and the lander's link becomes a page that loads the
 * workspace when it meant to load something else. These tests are the link.
 */

/**
 * The legal drafts. These carry the noindex rule below, because a draft that
 * says it binds nobody must not be what a search engine quotes back at us.
 */
const LEGAL = ["terms.html", "privacy.html", "aup.html"]

/**
 * Asylum's pages. Product documentation rather than drafts — they are meant to
 * be found, so they are link-checked but deliberately not held to `noindex`.
 */
const ASYLUM = ["asylum.html", "asylum-docs.html", "asylum-class.html"]

/**
 * How to run one yourself. Product documentation like Asylum's, and the page
 * every other one now points at — a licence that invites people to self-host
 * with no page saying what that takes is an invitation to open an issue
 * instead.
 */
const SELF_HOST = ["self-host.html"]

/** Every page the link checker knows about. */
const PAGES = ["index.html", ...LEGAL, ...ASYLUM, ...SELF_HOST]

/**
 * Paths the web tier answers with the app shell rather than with a file in
 * `site/`. Built from the router rather than written out, so a view that gets
 * renamed turns the lander's link into a failure here instead of into a page
 * that loads the workspace when it meant to load something else.
 */
const APP_PATHS = new Set<string>([
  HOME_PATH,
  WORKSPACE_PATH,
  routeHref({ view: "spend", tab: "overview" }),
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
        // Stylesheets are `href` too. They are assets, not pages, and the web
        // tier serves them from its own allow-list.
        if (/\.(css|js|svg|png|ico|woff2?)$/.test(link)) continue
        const [page, fragment] = link.slice(1).split("#")
        expect(bodies.has(page), `${name} links to missing page ${link}`).toBe(true)
        if (fragment) expect(ids.get(page)?.has(fragment), `${name} links to missing anchor ${link}`).toBe(true)
      }
    }
  })

  test("the drafts are still marked noindex", async () => {
    // Removing this is a launch step. A draft that says it binds nobody must
    // not be the thing a search engine quotes back at us.
    for (const name of LEGAL) {
      expect(await read(name), `${name} is indexable`).toContain('name="robots" content="noindex"')
    }
  })

  test("the lander links to the legal pages and to Asylum", async () => {
    // Not to every Asylum page: the lander carries the entry point, and the
    // section navigates itself from there. Orphans are caught below instead.
    const lander = await read("index.html")
    for (const name of [...LEGAL, "asylum.html"]) {
      expect(lander, `the lander does not link to ${name}`).toContain(`href="/${name}"`)
    }
  })

  test("no Asylum page is an orphan", async () => {
    // Each one must be reachable from another, or it exists only for whoever
    // already knows the URL — which is the same as not existing.
    const bodies = new Map(await Promise.all(PAGES.map(async n => [n, await read(n)] as const)))
    for (const name of ASYLUM) {
      const linkers = [...bodies].filter(([from, body]) => from !== name && body.includes(`href="/${name}"`))
      expect(linkers.length, `nothing links to ${name}`).toBeGreaterThan(0)
    }
  })

  test("the lander offers a way into the app", async () => {
    // The only door. `/` is the lander, so without a link here the app is
    // reachable only by knowing the path to type — which was the state of
    // things, and reads as "the product does not exist yet".
    //
    // It goes to the home path rather than to the terminals. Signing in should
    // land on the work — the runs — and a terminal is one pane of one box.
    expect(await read("index.html")).toContain(`href="${HOME_PATH}"`)
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
