import {
  Bell,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  CirclePause,
  GitBranch,
  Loader2,
  Moon,
  Pin,
  Send,
  Sun,
} from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import * as api from "../api.ts"
import * as companion from "../asylum/api.ts"
import { setTheme, type Theme } from "../asylum/theme.ts"

/**
 * Cloud Asylum: a box's work, as runs rather than as terminals.
 *
 * The hierarchy is Asylum's own and it is the point of the screen — a project
 * holds tasks, a task holds *runs*, and a run is one agent's attempt in its own
 * worktree on its own branch. A terminal is a pane you open on a run when you
 * want one, which is why there is not one on this screen.
 *
 * Everything is read from the companion API that Asylum already serves. No
 * shape here was designed; see `asylum/api.ts`.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type Tone = "ok" | "warn" | "bad" | "idle" | "live"

/**
 * What a status word means, in colour.
 *
 * Deliberately a lookup over a lowercased string rather than an exhaustive
 * union. Asylum's `RunStatus` gains variants faster than this client will be
 * rebuilt, and an unknown status should render as a neutral pill with its own
 * name in it — not crash, and not silently claim to be "done".
 */
const TONES: Record<string, Tone> = {
  done: "ok",
  merged: "ok",
  passed: "ok",
  running: "live",
  working: "live",
  queued: "idle",
  pending: "idle",
  idle: "idle",
  blocked: "warn",
  waiting: "warn",
  review: "warn",
  failed: "bad",
  error: "bad",
  cancelled: "bad",
}

const toneOf = (status: string): Tone => TONES[status.toLowerCase()] ?? "idle"

const ICONS: Record<Tone, React.ReactNode> = {
  ok: <CircleCheck size={12} />,
  live: <Loader2 size={12} className="az-spin" />,
  warn: <CirclePause size={12} />,
  bad: <CircleAlert size={12} />,
  idle: null,
}

const Pill: React.FC<{ status: string }> = ({ status }) => {
  const tone = toneOf(status)
  // "blocked" is the only state that earns motion — it is the only one that is
  // asking for a person.
  const blocked = tone === "warn" ? " blocked" : ""
  return (
    <span className={`az-pill ${tone === "live" ? "" : tone}${blocked}`}>
      {ICONS[tone]}
      {status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Something is happening, so ask often. */
const HOT = 1000
/** Nothing is, so stop asking. */
const COLD = 10_000
/** Nobody is looking. */
const HIDDEN = 30_000

/**
 * Follow the event log, and say when something moved.
 *
 * The alternative — re-fetching projects, tasks and runs on a timer — is three
 * requests per tick per open tab against a SQLite file on somebody's box, to
 * learn nothing on the overwhelming majority of ticks. The event log exists so
 * one cheap request can answer "has anything happened", and the tables are only
 * read when the answer is yes.
 *
 * The cursor is kept in a ref rather than state on purpose: advancing it must
 * not re-render, and a stale closure over it would replay the same page
 * forever.
 *
 * ## On feeling live
 *
 * The interval is not fixed, because "how stale may this be" is not one
 * question. While an agent is working, a second is the difference between
 * watching something happen and reading a report about it. While everything is
 * settled, a second is a request per second per open tab, forever, to be told
 * nothing again — on hardware somebody is paying for by the hour.
 *
 * So: fast while any run is live, slow when the fleet is quiet, slower still
 * when the tab is in the background, and an immediate catch-up the moment it
 * comes back. That last one is what makes it feel live in practice — the
 * common case is not staring at the screen, it is glancing back at it.
 *
 * This should be a push, and the shape of the endpoint says so: the companion
 * already keeps a cursor-addressed append-only log, which is exactly what
 * Server-Sent Events resume against with `Last-Event-ID`. `GET
 * /api/events/stream` would delete this whole function. Until it exists, this
 * is polling that knows what it is doing.
 */
const useEventFeed = (onChange: () => void, active: boolean, live: boolean) => {
  const cursor = useRef(0)
  const changed = useRef(onChange)
  const hot = useRef(live)
  changed.current = onChange
  hot.current = live

  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    const delay = () => {
      if (document.visibilityState === "hidden") return HIDDEN
      return hot.current ? HOT : COLD
    }

    const tick = async () => {
      try {
        const out = await companion.events(cursor.current)
        cursor.current = out.cursor
        if (out.items.length > 0) changed.current()
      } catch {
        // Transient. The banner already reports reachability; a failed poll
        // should not clear the screen someone is reading.
      }
      if (!stopped) timer = setTimeout(tick, delay())
    }

    // Coming back to the tab asks immediately rather than waiting out whatever
    // was left of a thirty-second sleep. Without this, a tab restored after a
    // minute away shows a stale fleet for as long as it takes the old timer to
    // expire, which is the exact moment the screen is being read most closely.
    const wake = () => {
      if (document.visibilityState !== "visible" || stopped) return
      clearTimeout(timer)
      tick()
    }
    document.addEventListener("visibilitychange", wake)

    tick()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
    }
  }, [active])
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** Which column has the screen on a phone, where only one fits. */
type Focus = "projects" | "tasks" | "runs"

export const Runs: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [projects, setProjects] = useState<companion.Project[]>([])
  const [project, setProject] = useState<number | null>(null)
  const [tasks, setTasks] = useState<companion.Task[]>([])
  const [task, setTask] = useState<number | null>(null)
  const [runs, setRuns] = useState<companion.Run[]>([])
  const [unread, setUnread] = useState(0)
  const [inbox, setInbox] = useState<companion.Notification[]>([])
  const [showInbox, setShowInbox] = useState(false)
  const [focus, setFocus] = useState<Focus>("projects")
  // What is on screen, not what is stored. `getTheme()` answers "system" for
  // most people, which is not a thing a two-state button can render.
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark")
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  // Which box, before anything is asked of one. The companion lives on a box
  // and the control plane will not proxy to one it has not been told about, so
  // this runs first and everything else waits on `ready`.
  const [ready, setReady] = useState(false)
  const [noBox, setNoBox] = useState(false)
  useEffect(() => {
    let stopped = false
    api
      .listBoxes()
      .then(list => {
        if (stopped) return
        // The one that can answer. A box being built has no companion on it
        // yet, and an asleep box has no droplet at all.
        const live = list.find(b => b.status === "ready")
        if (!live) {
          setNoBox(true)
          setLoading(false)
          return
        }
        companion.usingBox(live.id)
        setReady(true)
      })
      .catch(() => {
        if (!stopped) {
          setOffline(true)
          setLoading(false)
        }
      })
    return () => {
      stopped = true
    }
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const list = await companion.projects()
      setOffline(false)
      setProjects(list)
      // Pinned first, then whatever came back first. Only used to pick an
      // initial selection — the list itself keeps the server's order.
      setProject(current =>
        current !== null && list.some(p => p.id === current)
          ? current
          : ([...list].sort((a, b) => Number(b.pinned) - Number(a.pinned))[0]?.id ?? null),
      )
    } catch {
      setOffline(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTasks = useCallback(async (id: number) => {
    try {
      const list = await companion.tasks(id)
      setTasks(list)
      setTask(current => (current !== null && list.some(t => t.id === current) ? current : (list[0]?.id ?? null)))
    } catch {
      setTasks([])
    }
  }, [])

  const loadRuns = useCallback(async (id: number) => {
    try {
      setRuns(await companion.runs(id))
    } catch {
      setRuns([])
    }
  }, [])

  const loadInbox = useCallback(async () => {
    try {
      const out = await companion.notifications()
      setUnread(out.unread)
      setInbox(out.items)
    } catch {
      // Leave the last known inbox up. A count that blanks on a dropped packet
      // reads as "everything was handled", which is the opposite of true.
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    loadProjects()
    loadInbox()
  }, [ready, loadProjects, loadInbox])

  useEffect(() => {
    if (project !== null) loadTasks(project)
  }, [project, loadTasks])

  useEffect(() => {
    if (task !== null) loadRuns(task)
    else setRuns([])
  }, [task, loadRuns])

  // One poller for the whole screen. Anything that moved is a reason to refresh
  // the three lists that are actually on screen, and nothing else.
  const refresh = useCallback(() => {
    loadInbox()
    if (project !== null) loadTasks(project)
    if (task !== null) loadRuns(task)
  }, [project, task, loadInbox, loadTasks, loadRuns])

  // Anything mid-flight is worth watching closely; a settled fleet is not.
  const busy = runs.some(r => {
    const tone = toneOf(r.status)
    return tone === "live" || tone === "warn"
  })
  useEventFeed(refresh, ready && !offline, busy)

  /**
   * Flip to the opposite of what is *on screen*, not the opposite of what is
   * stored.
   *
   * These differ whenever the stored preference is "system", which is the
   * default — so the first click on a dark-by-system machine set the
   * preference to "dark" and changed nothing anybody could see. A theme
   * toggle that does nothing on its first press is worse than no toggle.
   */
  const flipTheme = () => {
    const next: Theme = dark ? "light" : "dark"
    setTheme(next)
    setDark(!dark)
  }

  const send = async () => {
    if (task === null || !message.trim() || sending) return
    setSending(true)
    try {
      await companion.followUp(task, message.trim())
      setMessage("")
      setSent("Queued. It reaches the run when the box next drains the queue.")
      setTimeout(() => setSent(null), 4000)
      loadInbox()
    } catch (err) {
      setSent(err instanceof Error ? err.message : "Could not send.")
    } finally {
      setSending(false)
    }
  }

  const currentTask = tasks.find(t => t.id === task) ?? null

  // On a phone the three columns are a back-stack. On a desktop `focused` is
  // ignored by the stylesheet and all three are up.
  const col = (which: Focus) => `az-col${focus === which ? " focused" : ""}`

  if (loading) {
    return (
      <div className="az">
        <div className="az-empty">
          <Loader2 size={20} className="az-spin" />
        </div>
      </div>
    )
  }

  // Said plainly rather than as an empty list. "No projects" on a screen for
  // somebody who has no awake box to hold one is an answer to a question they
  // did not ask.
  if (noBox) {
    return (
      <div className="az">
        <div className="az-empty">
          <strong>No box is awake</strong>
          <p>Runs live on a box. Wake one, or make one, and its work shows up here.</p>
          <button type="button" className="az-btn" onClick={onBack}>
            Go to boxes
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="az">
      {/* ---- projects + inbox ---- */}
      <div className={col("projects")}>
        <div className="az-head">
          <button type="button" className="az-btn icon" onClick={onBack} title="Back to terminals">
            <ChevronLeft size={16} />
          </button>
          <span className="az-grow">Projects</span>
          <button type="button" className="az-btn icon" onClick={flipTheme} title="Light or dark">
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>

        <button type="button" className={`az-row${showInbox ? " on" : ""}`} onClick={() => setShowInbox(v => !v)}>
          <Bell size={15} className="az-icon" />
          <span className="az-row-body">
            <span className="az-row-title">Inbox</span>
          </span>
          {unread > 0 && <span className="az-badge">{unread}</span>}
        </button>

        {showInbox && (
          <div className="az-scroll">
            {inbox.length === 0 ? (
              <div className="az-note">Nothing waiting.</div>
            ) : (
              inbox.map(n => (
                <div key={n.id} className="az-note">
                  <strong>{n.title}</strong>
                  {n.body ? ` — ${n.body}` : ""}
                </div>
              ))
            )}
          </div>
        )}

        {!showInbox && (
          <div className="az-scroll">
            {projects.length === 0 ? (
              <div className="az-note">No projects on this box yet.</div>
            ) : (
              projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`az-row${p.id === project ? " on" : ""}`}
                  onClick={() => {
                    setProject(p.id)
                    setFocus("tasks")
                  }}
                >
                  {p.pinned && <Pin size={13} className="az-icon" />}
                  <span className="az-row-body">
                    <span className="az-row-title">{p.name}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {offline && <div className="az-note bad">The box is not answering.</div>}
      </div>

      {/* ---- tasks ---- */}
      <div className={col("tasks")}>
        <div className="az-head">
          <button type="button" className="az-btn icon" onClick={() => setFocus("projects")} title="Projects">
            <ChevronLeft size={16} />
          </button>
          <span className="az-grow">Tasks</span>
        </div>
        <div className="az-scroll">
          {tasks.length === 0 ? (
            <div className="az-note">Nothing queued here.</div>
          ) : (
            tasks.map(t => (
              <button
                key={t.id}
                type="button"
                className={`az-row${t.id === task ? " on" : ""}`}
                onClick={() => {
                  setTask(t.id)
                  setFocus("runs")
                }}
              >
                <span className="az-row-body">
                  <span className="az-row-title">{t.title}</span>
                </span>
                <Pill status={t.status} />
              </button>
            ))
          )}
        </div>
      </div>

      {/* ---- the run ---- */}
      <div className={col("runs")}>
        {currentTask === null ? (
          <div className="az-empty">
            <strong>Nothing selected</strong>
            <p>Pick a task to see the agents working on it.</p>
          </div>
        ) : (
          <div className="az-detail">
            <div className="az-detail-head">
              <h2>{currentTask.title}</h2>
              <Pill status={currentTask.status} />
            </div>

            {runs.length === 0 ? (
              <div className="az-empty">
                <strong>No runs yet</strong>
                <p>Nothing has been dispatched against this task.</p>
              </div>
            ) : (
              <div className="az-runs">
                {runs.map(r => (
                  <div key={r.id} className="az-run">
                    <div className="az-run-top">
                      <span className="az-run-agent">{r.agent}</span>
                      <Pill status={r.status} />
                    </div>
                    <div className="az-run-branch">
                      <GitBranch size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                      {r.branch}
                    </div>
                    {/* The reason this screen exists. A spinner cannot tell a
                        thinking agent from one blocked on a question. */}
                    {r.activity && <div className="az-run-activity">{r.activity}</div>}
                  </div>
                ))}
              </div>
            )}

            <div className="az-composer">
              <textarea
                value={message}
                placeholder={sent ?? "Say something to this task's runs…"}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => {
                  // Enter sends, Shift+Enter breaks the line. A follow-up is a
                  // sentence, not a document.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button type="button" className="az-btn" disabled={sending || !message.trim()} onClick={send}>
                {sending ? <Loader2 size={15} className="az-spin" /> : <Send size={15} />}
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
