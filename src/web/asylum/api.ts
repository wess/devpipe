/**
 * The Asylum companion API, as the browser sees it.
 *
 * Every shape here is transcribed from `crates/companion/src/router.rs` in the
 * Asylum repo rather than invented. That file is the contract: it already
 * serves projects, tasks, runs, an append-only event log and a notification
 * inbox over the same SQLite store the desktop app uses, with bearer auth and a
 * CSRF header on mutations. Nothing new had to be designed for this client —
 * the protocol was already written, for a phone.
 *
 * Requests go to `/api/boxes/:id/companion/*`, never to the companion
 * directly. Three reasons, all load-bearing:
 *
 *   1. `connect-src 'self'` (see `security/headers.ts`). A browser on
 *      devpipe.com may open sockets to `*.devpipe.com` and to itself, and to
 *      nothing else. A fetch straight at a box's companion port is refused by
 *      the policy before it is ever sent.
 *   2. The companion's bearer token is a box credential. Putting it in the
 *      bundle would publish it; the control plane holds it and the browser
 *      never sees one.
 *   3. Which box is a question only the control plane can answer, and the
 *      account session the client already carries is what makes it answerable.
 */

/**
 * Which box these calls are about.
 *
 * Module state rather than an argument on every call, because every screen
 * that reads this API is looking at one box at a time and threading the id
 * through six functions would put the same value in every call site. Set it
 * once when the selection changes.
 */
let target = 0

export const usingBox = (id: number) => {
  target = id
}

const BASE = () => `/api/boxes/${target}/companion/api`

/** A repository Asylum is watching. `pinned` sorts it to the top, nothing more. */
export type Project = {
  id: number
  name: string
  pinned: boolean
}

/**
 * A unit of intent — what someone asked for, not what any one agent did about
 * it. Runs hang off this, which is the whole reason the product is not a list
 * of terminals: one task, many attempts.
 */
export type Task = {
  id: number
  title: string
  status: string
}

/**
 * One agent's attempt at a task, in its own worktree on its own branch.
 *
 * `status` is the lifecycle (queued, running, done, failed). `activity` is the
 * *semantic* state the agent reports through the control surface — "waiting on
 * review", "running checks" — and it is the field this whole UI exists to show.
 * A spinner cannot distinguish an agent that is thinking from one that has been
 * blocked on a question for twenty minutes; this can.
 */
export type Run = {
  id: number
  agent: string
  branch: string
  status: string
  activity: string | null
}

/**
 * A line in the append-only log, which is how the client follows a fleet
 * without polling five tables.
 *
 * Cursor-paginated on purpose: `since` is the last id seen, so a reconnect
 * after a dropped network resumes rather than replaying from the beginning or
 * silently skipping whatever landed while it was away.
 */
export type Event = {
  id: number
  kind: string
  task: number | null
  run: number | null
  at: number
}

export type Notification = {
  id: number
  kind: string
  title: string
  body: string
  read: boolean
}

export class CompanionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

/**
 * Whether the companion is reachable at all.
 *
 * Distinct from "there is nothing to show". A box with no projects and a box
 * that is not answering look identical in a list, and only one of them is worth
 * telling somebody about.
 */
export let reachable: boolean | null = null

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  if (target === 0) throw new CompanionError("No box selected.", 0)
  let res: Response
  try {
    res = await fetch(`${BASE()}${path}`, {
      method,
      headers: {
        // No `x-asylum-companion` here any more. The companion's CSRF header
        // is attached by the control plane, which is the only thing that talks
        // to a companion — sending it from the browser would suggest this
        // request reaches one, and it does not.
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    reachable = false
    throw new CompanionError("No answer from the box.", 0)
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    // 502 is the proxy saying the companion is not there. Anything else came
    // from the companion itself, which means it is up and declined.
    reachable = res.status !== 502
    throw new CompanionError((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status)
  }
  reachable = true
  return data as T
}

export const health = () => call<{ ok: boolean }>("GET", "/health")

export const projects = () => call<Project[]>("GET", "/projects")

export const tasks = (project: number) => call<Task[]>("GET", `/projects/${project}/tasks`)

export const runs = (task: number) => call<Run[]>("GET", `/tasks/${task}/runs`)

export const notifications = () => call<{ unread: number; items: Notification[] }>("GET", "/notifications")

/**
 * Everything that has happened since `cursor`.
 *
 * The returned cursor is what to pass next time — including when `items` is
 * empty, because the companion answers with the cursor it was given and losing
 * it means starting over.
 */
export const events = (cursor: number, limit = 200) =>
  call<{ cursor: number; items: Event[] }>("GET", `/events?since=${cursor}&limit=${limit}`)

/**
 * Say something to a task's runs.
 *
 * Queued rather than delivered: the companion writes it to the store and the
 * thing draining that queue hands it to a live run. So a follow-up sent to an
 * agent that is mid-thought is not lost, and one sent to a task with nothing
 * running waits for the next attempt instead of erroring.
 */
export const followUp = (task: number, message: string) =>
  call<{ ok: boolean; task: number }>("POST", `/tasks/${task}/followup`, { message })
