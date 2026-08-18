import { useCallback, useEffect, useState } from "react"

/**
 * Where you are, in the address bar rather than only in memory.
 *
 * The app used to hold the current view in `useState` alone. Everything worked
 * until you did what people do with a web page: press Back and leave the app
 * entirely, reload the admin screen and land on the terminals, or try to send
 * somebody a link to the thing you were looking at. Stripe already forced half
 * of this — it sends the browser back to `/billing` — so the choice was one
 * path that mattered and three that lied, or all four telling the truth.
 *
 * `history` directly, no router dependency. There are four views and one nested
 * tab set; a library for that is more surface than the problem has.
 */

export type View = "workspace" | "runs" | "billing" | "settings" | "vault" | "admin" | "preview" | "watch"

export const ADMIN_TABS = [
  "overview",
  "users",
  "boxes",
  "waitlist",
  "marketing",
  "invites",
  "billing",
  "settings",
  "audit",
] as const

export type AdminTab = (typeof ADMIN_TABS)[number]

/**
 * `slug` is the identifier in the path, for the two views that arrive with one
 * rather than being navigated to: a preview bouncing a browser back here to be
 * admitted, and a shared terminal being opened by somebody who may have no
 * account at all.
 */
export type Route = { view: View; tab: AdminTab; slug?: string }

const DEFAULT_TAB: AdminTab = "overview"

/**
 * The workspace does not get `/` — that belongs to the lander, which the web
 * tier serves from `site/`. Someone arriving at devpipe.com is more likely to
 * be finding out what this is than to be signing in.
 */
export const WORKSPACE_PATH = "/terminals"

/**
 * Where signing in lands, and what an unrecognised path becomes.
 *
 * This used to be the terminals, which made a terminal the product rather than
 * one way of looking at a box. The work is a run — an agent's attempt at a
 * task, on its own branch — and the terminals are a drawer inside the machine
 * that happens to be running it.
 */
export const HOME_PATH = "/runs"

export const parse = (pathname: string): Route => {
  const [head, next] = pathname.split("/").filter(Boolean)
  if (head === "runs") return { view: "runs", tab: DEFAULT_TAB }
  if (head === "preview" && next) return { view: "preview", tab: DEFAULT_TAB, slug: next }
  if (head === "watch" && next) return { view: "watch", tab: DEFAULT_TAB, slug: next }
  // Named rather than left to the fall-through. The default view is the runs
  // now, so without this line the terminals are unreachable by URL.
  if (head === "terminals") return { view: "workspace", tab: DEFAULT_TAB }
  if (head === "billing") return { view: "billing", tab: DEFAULT_TAB }
  if (head === "settings") return { view: "settings", tab: DEFAULT_TAB }
  if (head === "vault") return { view: "vault", tab: DEFAULT_TAB }
  if (head === "admin") {
    return { view: "admin", tab: ADMIN_TABS.find(t => t === next) ?? DEFAULT_TAB }
  }
  // Anything unrecognised is the runs rather than a 404. The server answers
  // every unmatched path with the app shell, so a mistyped URL has already
  // been decided to be the app by the time it gets here — and the app opens
  // on the work, not on a shell prompt.
  return { view: "runs", tab: DEFAULT_TAB }
}

export const href = (route: Route): string => {
  if (route.view === "admin") return `/admin/${route.tab}`
  if (route.view === "preview") return `/preview/${route.slug ?? ""}`
  if (route.view === "watch") return `/watch/${route.slug ?? ""}`
  if (route.view === "workspace") return WORKSPACE_PATH
  return `/${route.view}`
}

export type Navigate = (next: Route, opts?: { replace?: boolean }) => void

/**
 * The current route, and a way to change it.
 *
 * `popstate` is the whole reason this is a hook: without it Back changes the
 * URL and leaves the rendered view behind, which is worse than not having
 * routing at all.
 */
export const useRoute = (): [Route, Navigate] => {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = useCallback<Navigate>((next, opts) => {
    const path = href(next)
    if (path !== window.location.pathname) {
      // The query string is dropped deliberately. The two that exist —
      // `?checkout=` and `?token=` — are single-use instructions their screens
      // consume on arrival, and carrying either through a navigation means
      // re-running it on the next visit to that view.
      if (opts?.replace) window.history.replaceState({}, "", path)
      else window.history.pushState({}, "", path)
    }
    setRoute(next)
  }, [])

  return [route, go]
}
