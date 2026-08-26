/**
 * The browser's half of a session, in a cookie it cannot read.
 *
 * The token used to live in `localStorage`, which meant one injected script on
 * this origin was account takeover — and the only thing standing in the way was
 * a `Content-Security-Policy` with no `'unsafe-inline'`. That policy is good and
 * it is still there; it was also the *entire* defence, and a single relaxation
 * of it by somebody adding an inline `<script>` would have quietly turned every
 * XSS into a full compromise. A credential JavaScript cannot read fails safe
 * instead.
 *
 * The CLI keeps sending `Authorization: Bearer` and holds its token in the
 * system keychain, where no web page can reach it.
 *
 * **`SameSite` is not the CSRF defence here, and cannot be.** Boxes and previews
 * live at `*.devpipe.com`, which is the same *site* as the app — so a preview
 * serving somebody's half-written application could POST to the API and a
 * `Lax` or even `Strict` cookie would ride along. Origin checking is what
 * actually separates them, because those pages have a different *origin* even
 * though they share a site. `SameSite=Lax` stays on as a second line against
 * genuinely cross-site pages.
 */

export const SESSION_COOKIE = "dp_session"

/** Thirty days, matching the row's own expiry. */
const MAX_AGE = 30 * 86_400

/**
 * Where the app is served from, for deciding what an acceptable `Origin` is.
 *
 * Set once at startup rather than read from the environment here: the default
 * lives in `server.ts` beside every other piece of configuration, and a second
 * copy of it in this file is a second thing to get wrong.
 */
let appOrigin = ""

export const setAppOrigin = (url: string) => {
  try {
    appOrigin = new URL(url).origin
  } catch {
    appOrigin = ""
  }
}

export const currentAppOrigin = () => appOrigin

/** Cookies are only `Secure` where the app is actually served over TLS. */
const secure = () => appOrigin.startsWith("https://")

export const sessionCookie = (token: string): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    // No `Domain`. Host-only, so it is never sent to a box, to a preview, or to
    // anything else under the wildcard — which is most of what makes those
    // hostnames safe to point at somebody else's code.
    secure() ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ")

export const clearedCookie = (): string =>
  [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", secure() ? "Secure" : ""]
    .filter(Boolean)
    .join("; ")

export const cookieValue = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

/**
 * Whether a cookie-authenticated request came from the app itself.
 *
 * A browser sends `Origin` on every request that can change something, and on
 * every cross-origin fetch. What it does *not* send it on is a plain top-level
 * navigation — which is why a missing Origin is accepted on a read and refused
 * on anything else.
 */
export const originIsOurs = (method: string, origin: string | null): boolean => {
  if (origin && origin !== appOrigin) return false
  if (origin === appOrigin) return true
  return method === "GET" || method === "HEAD"
}
