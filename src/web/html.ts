/**
 * Fixes up the document the bundler emits, before it is ever served.
 *
 * Two corrections, both of which produce failures that look like the server is
 * broken rather than like the HTML is wrong.
 */
export const prepareIndexHtml = (html: string): string =>
  html
    // Bun emits `crossorigin` on the script and stylesheet tags. The assets are
    // same-origin, so the attribute is gratuitous — and Safari then fetches
    // them in CORS mode, finds no allow-origin header, refuses to execute the
    // module, and offers to download the bundle instead of running it.
    .replace(/ crossorigin(?=[\s>])/g, "")
    // Relative to absolute. Bun writes `./chunk-abc123.js`, which the browser
    // resolves against the *current path* — so the app shell served at
    // /admin/marketing asks for /admin/chunk-abc123.js, the catch-all answers
    // it with the app shell again, and the module never loads. The page is
    // blank, the console is silent, and nothing about it points at the URL.
    //
    // It only worked while every route was a single segment: at /spend,
    // ./chunk-abc123.js happens to resolve to the right place.
    .replace(/(\bsrc|\bhref)="\.\//g, '$1="/')
