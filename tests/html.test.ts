import { describe, expect, test } from "bun:test"
import { prepareIndexHtml } from "../src/web/html.ts"

/**
 * The app shell is served for every unmatched path, so the URLs inside it have
 * to resolve from any depth. They did not, and the failure was silent: a blank
 * page, an empty console, and a 200 on every request.
 */
describe("the app shell", () => {
  const built = `<!doctype html><html><head>` +
    `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>">` +
    `<link rel="stylesheet" crossorigin href="./chunk-4swh933s.css">` +
    `<script type="module" crossorigin src="./chunk-edmre37y.js"></script>` +
    `</head><body><div id="root"></div></body></html>`

  test("asset URLs do not depend on how deep the route is", () => {
    const html = prepareIndexHtml(built)
    expect(html).toContain('href="/chunk-4swh933s.css"')
    expect(html).toContain('src="/chunk-edmre37y.js"')
    expect(html).not.toContain('="./')

    // The reason it matters, stated as the thing that used to happen: at
    // /admin/marketing a relative URL asks for /admin/chunk-….js, which the
    // catch-all answers with this same document.
    for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      expect(url.startsWith("/") || url.startsWith("data:"), `${url} is resolved against the current path`).toBe(true)
    }
  })

  test("crossorigin is stripped", () => {
    // Safari fetches a crossorigin module in CORS mode, finds no allow-origin
    // header on a same-origin asset, and offers to download the bundle rather
    // than run it.
    expect(prepareIndexHtml(built)).not.toContain("crossorigin")
  })

  test("the data: favicon is left alone", () => {
    expect(prepareIndexHtml(built)).toContain("href=\"data:image/svg+xml,")
  })

  test("running it twice changes nothing further", () => {
    const once = prepareIndexHtml(built)
    expect(prepareIndexHtml(once)).toBe(once)
  })
})
