/**
 * One set of response headers, used by both processes.
 *
 * The API imports this and so does the web tier, which is the point: the
 * document that actually runs the app is served by `web/serve.ts`, and a policy
 * that only ever reached API responses would be protecting JSON that no browser
 * executes. Caddy sets the same headers in front of both, so there are three
 * places this could drift — hence one function.
 *
 * The web client connects a websocket straight to the user's own box, so
 * `connect-src` has to allow the wildcard the boxes live under. Everything else
 * stays same-origin.
 *
 * A map rather than a pipe: not every route is built from a pipeline — the
 * Stripe webhook is a bare handler, because a signature is its authentication —
 * so the only place that covers all of them is the response on the way out.
 */
export const securityHeaders = (boxDomain: string): Record<string, string> => ({
  "content-security-policy": [
    "default-src 'self'",
    // No 'unsafe-inline'. The session token lives in localStorage, so an
    // injected script is account takeover rather than defacement, and this is
    // the directive standing between the two. Nothing inline is left: the app
    // bundle is a module file and the lander's script is `site/lander.js` for
    // this reason. 'wasm-unsafe-eval' is for the terminal emulator, and is
    // narrower than the 'unsafe-eval' instantiating WebAssembly would
    // otherwise require.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Stays, and is a real concession. The lander and its siblings carry their
    // CSS in a <style> block, and React writes `style` attributes for anything
    // it computes at runtime. Injected CSS can restyle a page; it cannot read a
    // token, which is the difference that makes this survivable and script-src
    // not.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // `data:` is the favicon, which is an inline SVG.
    "img-src 'self' data: blob:",
    `connect-src 'self' wss://*.${boxDomain} https://*.${boxDomain}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Both fall back to default-src, so neither is load-bearing. They are
    // written out because a later default-src that has to be loosened for some
    // unrelated reason should not quietly re-permit plugins and iframes.
    "object-src 'none'",
    "frame-src 'none'",
  ].join("; "),
  // frame-ancestors already covers this everywhere it is honoured. Kept for
  // the browsers that read one and not the other.
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // Nothing here asks for hardware, and a page that never wants the camera
  // should say so rather than leaving it to a prompt somebody might accept.
  "permissions-policy": [
    "accelerometer=()",
    "camera=()",
    "display-capture=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=()",
    "payment=()",
    "usb=()",
  ].join(", "),
  // Terminal output can print a link, and a click opens it. `noopener` is
  // passed at the call site; this is the same guarantee applied to windows
  // opened by anything that forgets, and it severs the reverse handle a
  // cross-origin page would otherwise hold on the tab running the terminal.
  "cross-origin-opener-policy": "same-origin",
})
