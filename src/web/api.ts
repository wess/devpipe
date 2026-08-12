const BASE = "/api"

export type User = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
}

export type Box = {
  id: number
  name: string
  hostname: string
  region: string
  size: string
  status: string
  status_detail: string
  ip: string
  shell: string
  synapse: boolean
  tools: string[]
  created_at: string
  ready_at: string | null
}

export type TerminalSession = {
  id: string
  argv: string[]
  cols: number
  rows: number
  title: string
  alive: boolean
}

export type Tool = {
  id: string
  name: string
  summary: string
  group: "agent" | "runtime" | "tooling" | "service" | "shell"
  memoryMb: number
  defaultOn?: boolean
  requires?: string[]
  /** How the tool is started, when it is the sort of thing you start. */
  launch?: string[]
}

export type Catalog = {
  tools: Tool[]
  sizes: { slug: string; label: string; memoryMb: number; monthly: number }[]
  regions: { slug: string; label: string }[]
  defaults: string[]
}

let token: string | null = localStorage.getItem("devpipe_token")
let user: User | null = (() => {
  const raw = localStorage.getItem("devpipe_user")
  return raw ? JSON.parse(raw) : null
})()

export const currentUser = () => user
export const isSignedIn = () => Boolean(token)

export const setSession = (t: string | null, u: User | null) => {
  token = t
  user = u
  if (t) localStorage.setItem("devpipe_token", t)
  else localStorage.removeItem("devpipe_token")
  if (u) localStorage.setItem("devpipe_user", JSON.stringify(u))
  else localStorage.removeItem("devpipe_user")
}

/**
 * Replaces the cached user without touching the token.
 *
 * The cache is what renders the name in Settings and decides whether the Admin
 * tab appears, and it was only ever written at sign-in. Saving a new name
 * therefore changed the server and the form, and nothing else — the old name
 * came back on the next reload, from a copy in localStorage that nothing
 * updated.
 */
export const setUser = (u: User) => {
  user = u
  localStorage.setItem("devpipe_user", JSON.stringify(u))
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    // A dead session should return the user to sign-in rather than showing an
    // error they can do nothing about.
    if (res.status === 401) setSession(null, null)
    throw new ApiError((data as any)?.error ?? `Request failed (${res.status})`, res.status)
  }
  return data as T
}

export const authState = () => call<{ needs_owner: boolean; invite_required: boolean }>("GET", "/auth/state")

/**
 * Whether a username is free, for showing while someone types.
 *
 * Advisory only. Two people can both be told a name is free and both submit;
 * the unique constraint decides, and the loser gets a 409. This exists so that
 * almost never happens, not so it cannot.
 */
export const checkUsername = (username: string) =>
  call<{ available: boolean; status: "free" | "taken" | "unavailable"; reason: string }>(
    "GET",
    `/claims/check?username=${encodeURIComponent(username)}`,
  )

export const register = async (input: {
  email: string
  username: string
  name?: string
  password: string
  invite?: string
}) => {
  const out = await call<{ token: string; user: User }>("POST", "/auth/register", input)
  setSession(out.token, out.user)
  return out.user
}

export const login = async (email: string, password: string) => {
  const out = await call<{ token: string; user: User }>("POST", "/auth/login", { email, password })
  setSession(out.token, out.user)
  return out.user
}

export const logout = async () => {
  try {
    await call("POST", "/auth/logout")
  } finally {
    setSession(null, null)
  }
}

// Neither touches the session: a reset deliberately does not sign anyone in,
// so the user lands back on the sign-in form with the password they just chose.
export const forgotPassword = (email: string) => call<{ ok: boolean }>("POST", "/auth/forgot", { email })
export const resetPassword = (token: string, password: string) =>
  call<{ ok: boolean }>("POST", "/auth/reset", { token, password })

// Both refresh the cached copy. `me` is the app's own liveness check on every
// sign-in, which makes it the natural place to notice that the name or the
// owner flag changed somewhere else.
export const me = async () => {
  const out = await call<{ user: User }>("GET", "/auth/me")
  setUser(out.user)
  return out
}
export const updateProfile = async (name: string) => {
  const out = await call<User>("PATCH", "/me", { name })
  setUser(out)
  return out
}
export const changePassword = (current: string, next: string) =>
  call<{ ok: boolean }>("POST", "/me/password", { current, next })

export const listSessions = () =>
  call<
    {
      id: number
      user_agent: string
      ip: string
      last_seen_at: string
      created_at: string
      current: boolean
    }[]
  >("GET", "/sessions")
export const revokeSession = (id: number) => call("DELETE", `/sessions/${id}`)
export const revokeOtherSessions = () => call("DELETE", "/sessions")

export const catalog = () => call<Catalog>("GET", "/boxes/catalog")
export const listBoxes = () => call<Box[]>("GET", "/boxes")
export const createBox = (input: {
  name: string
  region: string
  size: string
  shell: string
  synapse: boolean
  tools: string[]
}) => call<{ id: number; hostname: string; status: string }>("POST", "/boxes", input)
export const destroyBox = (id: number) => call("DELETE", `/boxes/${id}`)

export const boxSessions = (id: number) => call<TerminalSession[]>("GET", `/boxes/${id}/sessions`)
export const createTerminal = (id: number, argv: string[], cols: number, rows: number) =>
  call<TerminalSession>("POST", `/boxes/${id}/sessions`, { argv, cols, rows })
export const killTerminal = (id: number, sid: string) => call("DELETE", `/boxes/${id}/sessions/${sid}`)
export const boxEvents = (id: number, after = 0) =>
  call<{
    status: string
    detail: string
    events: { id: number; phase: string; line: string; at: string }[]
  }>("GET", `/boxes/${id}/events?after=${after}`)

export const connection = (id: number) => call<{ url: string; token: string }>("GET", `/boxes/${id}/connection`)

export type Plan = { size: string; label: string; price_cents: number; monthly: number }

export type Subscription = {
  id: number
  status: string
  size: string
  label: string
  box_id: number | null
  current_period_end: string | null
  cancel_at_period_end: boolean
}

export type BillingStatus = {
  configured: boolean
  margin_pct: number
  currency: string
  plans: Plan[]
  subscriptions: Subscription[]
  /** Size slugs this user can create a box at right now. */
  can_create: string[]
  /** While nothing is charged, the largest size a guest may take. Null once billing exists. */
  free_max_size?: string | null
}

export const billingStatus = () => call<BillingStatus>("GET", "/billing/status")
export const billingCheckout = (size: string) =>
  call<{ url: string; size: string; price_cents: number }>("POST", "/billing/checkout", { size })
export const billingPortal = () => call<{ url: string }>("GET", "/billing/portal")

export const adminOverview = () =>
  call<{
    users: number
    boxes: number
    waitlist: number
    suspended: number
    monthly_spend: number
    provider_configured: boolean
    provider_error: string | null
  }>("GET", "/admin/overview")
export const adminUsers = () =>
  call<(User & { suspended_at: string | null; created_at: string; boxes: number })[]>("GET", "/admin/users")
export const adminSuspend = (id: number, suspended: boolean) =>
  call<{ ok: boolean; sessions?: number; boxes?: number }>("PATCH", `/admin/users/${id}`, { suspended })
export const adminSettings = () =>
  call<{ settings: Record<string, string>; provider: { digitalocean: string | null } }>("GET", "/admin/settings")
export const adminSaveSettings = (values: Record<string, string>) =>
  call<Record<string, string>>("PATCH", "/admin/settings", values)
export const adminSaveProvider = (t: string) =>
  call<{ ok: boolean; account: { email: string } }>("POST", "/admin/provider/digitalocean", {
    token: t,
  })
export const adminClearProvider = () => call("DELETE", "/admin/provider/digitalocean")
export const adminDroplets = () => call<{ configured: boolean; droplets: any[] }>("GET", "/admin/droplets")
export const adminAudit = () =>
  call<{ id: number; action: string; detail: string; created_at: string; email: string }[]>("GET", "/admin/audit")
export const adminInvites = () =>
  call<{ id: number; code: string; note: string; used_at: string | null; created_at: string }[]>(
    "GET",
    "/admin/invites",
  )
export const adminCreateInvite = (note: string) =>
  call<{ code: string; note: string }>("POST", "/admin/invites", { note })
export const adminRevokeInvite = (id: number) => call("DELETE", `/admin/invites/${id}`)

export const adminWaitlist = () => call<{ id: number; email: string; created_at: string }[]>("GET", "/admin/waitlist")

export const adminBilling = () =>
  call<{
    configured: boolean
    margin_pct: number
    currency: string
    secret_key: string | null
    webhook_secret: string | null
    livemode: boolean | null
    plans: { size: string; label: string; cost_cents: number; price_cents: number }[]
  }>("GET", "/billing/config")
export const adminSaveBilling = (values: { margin_pct?: number; secret_key?: string; webhook_secret?: string }) =>
  call<{ ok: boolean; changed: string[] }>("PUT", "/billing/config", values)

/**
 * The claims list as a file.
 *
 * Not `call`, because the response is a CSV rather than JSON — but the same
 * bearer, which is the entire point: the route is owner-only, and the link this
 * replaced sent no credential at all.
 */
export const claimsCsv = async (): Promise<Blob> => {
  const res = await fetch(`${BASE}/admin/claims.csv`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    if (res.status === 401) setSession(null, null)
    const data = await res.json().catch(() => null)
    throw new ApiError((data as any)?.error ?? `Export failed (${res.status})`, res.status)
  }
  return res.blob()
}

export const adminClaims = () =>
  call<{ id: number; username: string; email: string; redeemed_at: string | null; created_at: string }[]>(
    "GET",
    "/admin/claims",
  )

export type Broadcast = {
  id: number
  subject: string
  audience: string
  sent_count: number
  failed_count: number
  sent_at: string | null
  created_at: string
}
export const adminBroadcasts = () =>
  call<{ broadcasts: Broadcast[]; counts: Record<string, number> }>("GET", "/admin/broadcasts")
export const adminCreateBroadcast = (subject: string, body: string, audience: string) =>
  call<{ id: number }>("POST", "/admin/broadcasts", { subject, body, audience })
export const adminPreviewBroadcast = (id: number) =>
  call<{ ok: boolean; to: string }>("POST", `/admin/broadcasts/${id}/preview`)
/**
 * Sends, or resumes sending.
 *
 * `done` is false when there are addresses left — the request works to a time
 * budget so it cannot be cut off mid-list, and the broadcast stays a draft
 * until nobody is left to reach. Calling this again picks up where it stopped
 * and never re-mails anyone already delivered to.
 */
export const adminSendBroadcast = (id: number, confirm: string) =>
  call<{ sent: number; failed: number; remaining: number; done: boolean; skipped: number; out_of_time: boolean }>(
    "POST",
    `/admin/broadcasts/${id}/send`,
    { confirm },
  )
export const adminDeleteBroadcast = (id: number) => call("DELETE", `/admin/broadcasts/${id}`)

export const joinWaitlist = (email: string) => call("POST", "/waitlist", { email })
