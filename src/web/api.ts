const BASE = "/api"

export type Role = "owner" | "admin" | "user"

export type User = {
  id: number
  email: string
  username: string
  name: string
  role: Role
  /** `role === "owner"`, kept because most screens are asking exactly that. */
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
  workspace_id: number | null
  created_at: string
  ready_at: string | null
}

/**
 * Storage that outlives the box.
 *
 * `attached_to` is the box currently holding it, and null means free. Block
 * storage mounts to one machine at a time, so this is a lock rather than a
 * status — a workspace with a holder cannot be given to a second box.
 */
export type Workspace = {
  id: number
  name: string
  region: string
  size_gb: number
  created_at: string
  attached_to: number | null
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

/**
 * A GPU size, as the provider offers it today.
 *
 * Separate from `sizes` rather than mixed in, because everything about it is
 * different: the price that matters is per hour rather than per month, and it
 * exists in one or two datacentres rather than everywhere. Empty when the
 * instance has GPU switched off, and admin-only even when it is not.
 */
export type GpuSize = {
  slug: string
  label: string
  memory_mb: number
  vcpus: number
  disk_gb: number
  vram_gb: number
  count: number
  vendor: "nvidia" | "amd"
  cents_per_hour: number
  regions: string[]
}

export type Catalog = {
  tools: Tool[]
  sizes: { slug: string; label: string; memoryMb: number; monthly: number }[]
  gpu_sizes: GpuSize[]
  regions: { slug: string; label: string }[]
  defaults: string[]
  provider: "digitalocean" | "docker"
}

/**
 * There is no token here, and that is the point.
 *
 * The session used to be a string in `localStorage`, which made one injected
 * script on this origin an account takeover — with the CSP the only thing
 * standing in the way. It is an `HttpOnly` cookie now: the browser sends it and
 * no script can read it, so an injection can act as you *while the page is
 * open* rather than walk away with the account.
 *
 * What stays in `localStorage` is the user record, and it is a hint rather than
 * a credential: it decides whether to render the app or the sign-in form on the
 * first paint, before `me()` has answered. Anything it claims is re-checked by
 * the server on the next request, and a 401 clears it.
 */
let user: User | null = (() => {
  const raw = localStorage.getItem("devpipe_user")
  return raw ? JSON.parse(raw) : null
})()

export const currentUser = () => user
export const isSignedIn = () => Boolean(user)

export const setSession = (u: User | null) => {
  user = u
  if (u) localStorage.setItem("devpipe_user", JSON.stringify(u))
  else localStorage.removeItem("devpipe_user")
  // Left over from when the token lived here. Removed on every path through
  // this function so an upgrade clears it rather than leaving a live session
  // token in storage for the rest of its thirty days.
  localStorage.removeItem("devpipe_token")
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
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    // Same origin, so the cookie rides along by default — said out loud because
    // this is now the only credential the app has, and a future change to a
    // different origin would otherwise fail as a mysterious 401.
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    // A dead session should return the user to sign-in rather than showing an
    // error they can do nothing about.
    if (res.status === 401) setSession(null)
    throw new ApiError((data as any)?.error ?? `Request failed (${res.status})`, res.status)
  }
  return data as T
}

export const authState = () =>
  call<{ needs_owner: boolean; invite_required: boolean; setup_token_required: boolean }>("GET", "/auth/state")

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
  setup_token?: string
}) => {
  // The token in the body is for iOS and dpctl, which keep theirs in a
  // keychain. This client is handed a cookie it cannot read, and deliberately
  // does nothing with the string.
  const out = await call<{ token: string; user: User }>("POST", "/auth/register", input)
  setSession(out.user)
  return out.user
}

export const login = async (email: string, password: string) => {
  const out = await call<{ token: string; user: User }>("POST", "/auth/login", { email, password })
  setSession(out.user)
  return out.user
}

export const logout = async () => {
  try {
    await call("POST", "/auth/logout")
  } finally {
    setSession(null)
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
/**
 * A port on a box, reachable in a browser without being on the internet.
 *
 * `url` is a hostname of its own rather than a path on this one: a dev server's
 * own absolute paths — `/assets/…`, `/@vite/client` — have to resolve, and they
 * cannot under a prefix.
 */
export type Preview = {
  id: number
  box_id: number
  port: number
  label: string
  audience: "private" | "link"
  url: string
  expires_at: string | null
}

export const listPreviews = (boxId: number) => call<Preview[]>("GET", `/boxes/${boxId}/previews`)

export const createPreview = (
  boxId: number,
  input: { port: number; label?: string; audience?: "private" | "link"; hours?: number },
) => call<Preview>("POST", `/boxes/${boxId}/previews`, input)

export const revokePreview = (id: number) => call<{ ok: true }>("DELETE", `/previews/${id}`)

/** Where a preview lives, so the app never turns a slug in a URL into a host. */
/**
 * Where a preview lives, and a one-minute capability to get into it.
 *
 * Both in one answer because they are one question. The app's own session is a
 * cookie it cannot read, so there is nothing to send to another origin — what
 * it can pass along is this code, which means "admit a browser to preview 41"
 * and nothing else, for sixty seconds.
 */
export const previewOrigin = (slug: string) => call<{ url: string; code: string }>("GET", `/previews/${slug}/origin`)

/**
 * Hands the preview's own origin the code, and takes back a cookie for it.
 *
 * Cross-origin and deliberately not through `call`: it goes to the preview
 * hostname rather than to the API, and it is the one request here that needs
 * `credentials: "include"` — the whole point is the `Set-Cookie` that comes
 * back, on a host this page is not.
 */
export const grantPreview = async (origin: string, code: string): Promise<void> => {
  const res = await fetch(`${origin}/__dp/grant`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new ApiError((data as any)?.error ?? `That preview did not open (${res.status})`, res.status)
  }
}

/**
 * A terminal somebody else can open.
 *
 * `url` comes back exactly once, on the response that creates it: the row holds
 * a hash of the token, so there is nothing to show a second time. That is the
 * point — a link this API cannot re-read is a link that cannot leak from it.
 */
export type Share = {
  id: number
  box_id: number
  session_id: string
  mode: "watch" | "control"
  label: string
  expires_at: string | null
  visits: number
  url: string | null
}

export const listShares = (boxId: number) => call<Share[]>("GET", `/boxes/${boxId}/shares`)

export const createShare = (
  boxId: number,
  input: { session_id: string; mode?: "watch" | "control"; label?: string; hours?: number },
) => call<Share>("POST", `/boxes/${boxId}/shares`, input)

export const revokeShare = (id: number) => call<{ ok: true }>("DELETE", `/shares/${id}`)

/** What a guest is about to open. No session needed — the token is the one. */
export const describeShare = (token: string) =>
  call<{ mode: "watch" | "control"; label: string; expires_at: string | null }>(
    "GET",
    `/shares/${encodeURIComponent(token)}`,
  )

/** Where a guest's terminal socket goes. Never to the box. */
export const shareSocketUrl = (token: string) =>
  `${location.origin.replace(/^http/, "ws")}/api/shares/${encodeURIComponent(token)}/socket`

export const listBoxes = () => call<Box[]>("GET", "/boxes")

/**
 * Give the machine back and keep everything else.
 *
 * The idle sweep has always done this; this is the same thing asked for. Only
 * a box with a workspace can be put down — one without it holds the only copy
 * of its files, and the server refuses rather than losing them.
 */
export const sleepBox = (id: number) => call<{ id: number; status: string }>("POST", `/boxes/${id}/sleep`)
export const createBox = (input: {
  name: string
  region: string
  size: string
  shell: string
  synapse: boolean
  tools: string[]
  workspace_id?: number | null
}) => call<{ id: number; hostname: string; status: string }>("POST", "/boxes", input)
export const destroyBox = (id: number) => call("DELETE", `/boxes/${id}`)
export const wakeBox = (id: number) =>
  call<{ id: number; hostname: string; status: string }>("POST", `/boxes/${id}/wake`)

export const listWorkspaces = () => call<Workspace[]>("GET", "/workspaces")
export const createWorkspace = (input: { name: string; region: string; size_gb: number }) =>
  call<Workspace>("POST", "/workspaces", input)
export const deleteWorkspace = (id: number) => call("DELETE", `/workspaces/${id}`)

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

/**
 * Where the box is, and a short-lived token that admits a socket to a terminal
 * on it — scoped to attaching, good for `expiresIn` seconds. Deliberately not
 * the box's bearer, which reads and writes every file on it. Call it again for
 * every connection attempt rather than holding the answer.
 */
export const connection = (id: number) =>
  call<{ url: string; token: string; expiresIn: number }>("GET", `/boxes/${id}/connection`)

/** What this account's machines have cost the instance this month. */
export type SpendEntry = {
  id: number
  cents: number
  kind: "box" | "workspace"
  note: string
  created_at: string
}

export type MySpend = {
  spent_cents: number
  run_rate_cents_per_hour: number
  period_start: string
  /** The instance's monthly ceiling, or 0 for none. */
  cap_cents: number
  instance_spent_cents: number
  entries: SpendEntry[]
}

export const mySpend = () => call<MySpend>("GET", "/spend/mine")

/** What the instance as a whole is spending, and the ceiling on it. */
export type Cap = {
  cap_cents: number
  spent_cents: number
  run_rate_cents_per_hour: number
  used: number
  warn_at_pct: number
  warning: boolean
  over: boolean
  reached_at: string | null
  period_start: string
}

export const spendCap = () => call<Cap>("GET", "/admin/spend")

// ---- first launch ---------------------------------------------------------

export type SetupStep = {
  id: "owner" | "secret" | "provider" | "domain" | "keys" | "cap"
  title: string
  done: boolean
  required: boolean
  detail: string
}

export type SetupState = {
  claimed: boolean
  /** Every required step is done — the instance can build a box. */
  usable: boolean
  /** …and somebody has read the last screen. */
  complete: boolean
  acknowledged: boolean
  steps: SetupStep[]
  account: { email: string; dropletLimit: number } | null
  provider_error: string | null
  domain: string
  domain_on_account: boolean
  ssh_key_count: number
  spend_cap_cents: number
  sealed: boolean
}

export const setupState = () => call<SetupState>("GET", "/setup/state")
export const setupSecret = () => call<{ key: string; sealed: boolean; path: string }>("GET", "/setup/secret")
export const setupProvider = (token: string) =>
  call<{ ok: boolean; account: { email: string; dropletLimit: number }; domains: string[] }>(
    "POST",
    "/setup/provider",
    { token },
  )
export const setupDomain = (domain: string) =>
  call<{ ok: boolean; domain: string }>("POST", "/setup/domain", { domain })
export const setupSshKeys = () =>
  call<{ keys: { id: number; name: string }[]; chosen: string[] }>("GET", "/setup/ssh-keys")
export const saveSetupSshKeys = (ids: number[]) => call<{ ok: boolean }>("POST", "/setup/ssh-keys", { ids })
export const setupCap = (cents: number) => call<{ ok: boolean }>("POST", "/setup/cap", { cents })
export const setupFinish = () => call<{ ok: boolean }>("POST", "/setup/finish", {})

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
export const adminSetRole = (id: number, role: Role) =>
  call<{ ok: boolean; role: Role; transferred: boolean }>("PATCH", `/admin/users/${id}/role`, { role })
export const adminSettings = () =>
  call<{
    settings: Record<string, string>
    /** False for an admin: settings are the owner's to change. */
    can_edit: boolean
    provider: { digitalocean: string | null }
    /** Whether this instance encrypts its own credentials at rest. */
    secrets_sealed: boolean
  }>("GET", "/admin/settings")
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

/**
 * The claims list as a file.
 *
 * Not `call`, because the response is a CSV rather than JSON — but the same
 * session, which is the entire point: the route is owner-only, and the link
 * this replaced sent no credential at all.
 */
export const claimsCsv = async (): Promise<Blob> => {
  const res = await fetch(`${BASE}/admin/claims.csv`, { credentials: "same-origin" })
  if (!res.ok) {
    if (res.status === 401) setSession(null)
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

export type VaultScope = "global" | "workspace" | "box"
export type VaultKind = "value" | "secret"

export type VaultEntry = {
  scope: VaultScope
  scope_id: number
  name: string
  kind: VaultKind
  updated_at: string
  last_used_at: string | null
}

export const listVault = () => call<VaultEntry[]>("GET", "/vault")
export const putVaultEntry = (input: {
  scope: VaultScope
  scope_id: number
  name: string
  kind: VaultKind
  value: string
}) => call<{ ok: true }>("POST", "/vault", input)
/**
 * The one call that returns plaintext. Audited server-side every time and rate
 * limited harder than writing, so the UI asks for it on demand rather than
 * pre-loading values it might not need.
 */
export const revealVaultEntry = (scope: VaultScope, scopeId: number, name: string) =>
  call<{ name: string; kind: VaultKind; value: string }>("GET", `/vault/${scope}/${scopeId}/${name}`)
export const deleteVaultEntry = (scope: VaultScope, scopeId: number, name: string) =>
  call("DELETE", `/vault/${scope}/${scopeId}/${name}`)

export type VaultGrant = {
  box_id: number
  scope: VaultScope
  scope_id: number
  name: string
  granted_at: string
}

export const listVaultGrants = () => call<VaultGrant[]>("GET", "/vault/grants")
export const grantVaultEntry = (input: { box_id: number; scope: VaultScope; scope_id: number; name: string }) =>
  call<{ ok: true }>("POST", "/vault/grants", input)
export const revokeVaultEntry = (boxId: number, scope: VaultScope, scopeId: number, name: string) =>
  call("DELETE", `/vault/grants/${boxId}/${scope}/${scopeId}/${name}`)
