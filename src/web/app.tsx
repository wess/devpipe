import {
  Activity,
  CircleDot,
  CreditCard,
  KeyRound,
  Loader2,
  LogOut,
  Menu,
  Moon,
  Plus,
  Server,
  Settings as SettingsIcon,
  Share2,
  Shield,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { commandOf } from "../util/shell.ts"
import * as api from "./api.ts"
import { applyTheme, getTheme } from "./asylum/theme.ts"
import { Admin } from "./components/Admin.tsx"
import { BoxSetup } from "./components/BoxSetup.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary.tsx"
import { Previews } from "./components/Previews.tsx"
import { Runs } from "./components/Runs.tsx"
import { Settings } from "./components/Settings.tsx"
import { ShareTerminal } from "./components/ShareTerminal.tsx"
import { TerminalView } from "./components/TerminalView.tsx"
import { Vault } from "./components/Vault.tsx"
import { Watch } from "./components/Watch.tsx"
import { Wizard } from "./components/Wizard.tsx"
import { HOME_PATH, href, type Route, useRoute } from "./routes.ts"
import { gridFor } from "./terminal/metrics.ts"
import { loadVt } from "./terminal/vt.ts"

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

type Availability = {
  state: "checking" | "free" | "taken"
  text: string
  /** Somebody holds this name — which, before launch, might be you. */
  heldBySomeone?: boolean
} | null

const Gate: React.FC<{ notice?: string | null; onDone: () => void }> = ({ notice, onDone }) => {
  const [needsOwner, setNeedsOwner] = useState<boolean | null>(null)
  const [inviteRequired, setInviteRequired] = useState(false)
  const [invite, setInvite] = useState("")
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login")
  const [email, setEmail] = useState("")
  const [username, setUsername] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<Availability>(null)

  useEffect(() => {
    api
      .authState()
      .then(s => {
        setNeedsOwner(s.needs_owner)
        setInviteRequired(s.invite_required)
        if (s.needs_owner) setMode("register")
      })
      .catch(() => setNeedsOwner(false))
  }, [])

  // Checked while typing rather than on submit, because finding out the name
  // is gone only after filling in a password is how people end up with their
  // second choice. Debounced: the answer only matters once someone stops.
  useEffect(() => {
    if (mode !== "register" || username.length < 3) {
      setAvailable(null)
      return
    }
    setAvailable({ state: "checking", text: "checking…" })
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .checkUsername(username)
        .then(r => {
          // A slow answer for a name already typed past is worse than none.
          if (cancelled) return
          setAvailable(
            r.available
              ? { state: "free", text: `@${username} is free` }
              : {
                  state: "taken",
                  text: r.reason || "That username is taken.",
                  heldBySomeone: r.status === "taken",
                },
          )
        })
        .catch(() => {
          if (!cancelled) setAvailable(null)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [username, mode])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === "forgot") {
        await api.forgotPassword(email)
        // The same line whether or not that address has an account. The
        // endpoint is careful not to say, and the UI must not undo that.
        setSent("If that address has an account, a reset link is on its way. The link expires in an hour.")
        setBusy(false)
        return
      }
      if (mode === "register") await api.register({ email, username, name, password, invite })
      else await api.login(email, password)
      onDone()
    } catch (err: any) {
      setError(String(err.message))
      setBusy(false)
    }
  }

  const swap = (to: "login" | "register" | "forgot") => {
    setMode(to)
    setError(null)
    setSent(null)
  }

  // Until `/auth/state` answers there is no way to know whether this instance
  // wants an owner or a sign-in, and the two forms are different enough that
  // guessing shows the wrong one and then swaps it out from under whoever
  // started typing.
  if (needsOwner === null) {
    return (
      <div className="gate">
        <Loader2 className="spin" size={20} />
      </div>
    )
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="brand">
          <TerminalIcon size={18} />
          <span>Devpipe</span>
        </div>

        {needsOwner && (
          <p className="note warn">This instance has no owner yet. The first account created becomes the owner.</p>
        )}
        {notice && <p className="note ok">{notice}</p>}
        {sent && <p className="note ok">{sent}</p>}
        {error && <p className="note bad">{error}</p>}

        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
        </label>

        {mode === "register" && (
          <>
            <label className="field">
              <span>Username</span>
              <input
                value={username}
                onChange={e => setUsername(e.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-describedby="username-availability"
              />
              <small id="username-availability" className={`availability ${available?.state ?? ""}`} role="status">
                {available?.text ?? " "}
              </small>
              {/* A name someone claimed before launch is theirs, but the check
                  cannot know that without being told who is asking — and an
                  endpoint that answers "did this address claim this name" is an
                  enumeration tool. So it says taken, and this says what to do
                  about it, phrased as a condition because it is one. Reserved
                  names never had a claim to honour, so they get no hint. */}
              {available?.heldBySomeone && (
                <small className="muted">
                  If you claimed it before launch, sign up with the email you used and it is still yours.
                </small>
              )}
              <small className="muted">Your boxes live at username-xxxxx.devpipe.com</small>
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={e => setName(e.target.value)} />
            </label>
            {inviteRequired && (
              <label className="field">
                <span>Invite code</span>
                <input
                  value={invite}
                  onChange={e => setInvite(e.target.value.trim())}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
                <small className="muted">Signups are invite-only right now.</small>
              </label>
            )}
          </>
        )}

        {mode !== "forgot" && (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
            />
            {mode === "register" && <small className="muted">At least 12 characters.</small>}
          </label>
        )}

        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "register" ? "Create account" : mode === "forgot" ? "Send a reset link" : "Sign in"}
        </button>

        {mode === "login" && (
          <button type="button" className="quiet-link" onClick={() => swap("forgot")}>
            Forgot your password?
          </button>
        )}

        {mode === "forgot" ? (
          <button type="button" className="linkish" onClick={() => swap("login")}>
            Back to sign in
          </button>
        ) : (
          !needsOwner && (
            <button type="button" className="linkish" onClick={() => swap(mode === "login" ? "register" : "login")}>
              {mode === "login" ? "Create an account" : "I already have an account"}
            </button>
          )
        )}
      </form>
    </div>
  )
}

/**
 * The screen the emailed link lands on.
 *
 * A reset ends every session, this one included, so it deliberately does not
 * sign anyone in — the user goes back to the gate with the password they just
 * chose.
 */
const Reset: React.FC<{ token: string; onDone: (notice: string) => void }> = ({ token, onDone }) => {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.resetPassword(token, password)
      api.setSession(null, null)
      // A reset link left in history is a link somebody else can find. It goes
      // to the app rather than to "/", which is the lander — a reload here
      // should land on the sign-in form the user is about to need, not on the
      // page that sells them the product they just fixed.
      history.replaceState({}, "", HOME_PATH)
      onDone("Password changed. Sign in with the new one.")
    } catch (err: any) {
      // These messages are already written for a person to read, and a short
      // password leaves the link usable — so the token stays in the URL.
      setError(String(err.message))
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="brand">
          <TerminalIcon size={18} />
          <span>Devpipe</span>
        </div>
        {error && <p className="note bad">{error}</p>}
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <small className="muted">At least 12 characters.</small>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Set password"}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workspace: a column of terminals on the left, the terminal on the right.
// The same shape as the iPad app, deliberately.
// ---------------------------------------------------------------------------

const Workspace: React.FC<{ vtReady: boolean }> = ({ vtReady }) => {
  const [boxes, setBoxes] = useState<api.Box[]>([])
  const [activeBox, setActiveBox] = useState<number | null>(null)
  const [sessions, setSessions] = useState<api.TerminalSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null)
  const [status, setStatus] = useState("")
  const [wizard, setWizard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [destroying, setDestroying] = useState<api.Box | null>(null)
  /** The terminal a share link is being made for. */
  const [sharing, setSharing] = useState<string | null>(null)
  /** The box about to be put down. */
  const [sleeping, setSleeping] = useState<api.Box | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The box a terminal will be drawn into, measured before one exists: the
  // empty state it replaces occupies exactly the same space.
  const paneRef = useRef<HTMLDivElement>(null)
  // Read from a resize callback that must not change identity — see
  // TerminalView, which holds its callbacks in refs so a new function does not
  // reconnect the socket.
  // Only ever true on a narrow viewport, where the sidebar is a drawer. Above
  // the breakpoint the CSS ignores it entirely, so there is no second layout
  // mode to keep in sync — the same markup, positioned differently.
  const [drawer, setDrawer] = useState(false)
  const activeSessionRef = useRef<string | null>(null)
  activeSessionRef.current = activeSession

  // The agents actually on this box, with the argv each is launched by. The
  // catalogue comes from the API rather than a copy here, so web and iOS
  // cannot drift on what a tool is called or how it starts.
  const [catalog, setCatalog] = useState<api.Catalog | null>(null)
  useEffect(() => {
    api
      .catalog()
      .then(setCatalog)
      .catch(() => {})
  }, [])

  const refreshBoxes = useCallback(async () => {
    try {
      const list = await api.listBoxes()
      setBoxes(list)
      setActiveBox(prev => prev ?? list.find(b => b.status === "ready")?.id ?? list[0]?.id ?? null)
    } catch (e: any) {
      setError(String(e.message))
    }
  }, [])

  useEffect(() => {
    void refreshBoxes()
    // A box being built changes state without the user doing anything, so the
    // sidebar has to find out on its own or it looks stuck.
    pollRef.current = setInterval(() => void refreshBoxes(), 8000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refreshBoxes])

  const box = boxes.find(b => b.id === activeBox) ?? null

  // Agents present on this box, in catalogue order, each with the argv it is
  // started by. `launch` carries the flag that lets an agent act without
  // stopping to ask — a prompt raised while nobody is attached waits forever,
  // and these boxes are dedicated to the agent anyway.
  const agents = (catalog?.tools ?? [])
    .filter(t => t.group === "agent" && t.launch && box?.tools.includes(t.id))
    .map(t => ({
      id: t.id,
      name: t.name,
      short: t.launch?.[0] ?? t.id,
      launch: [...(t.launch ?? [])],
    }))
  const boxId = box?.id
  const boxReady = box?.status === "ready"

  useEffect(() => {
    setConn(null)
    setSessions([])
    setActiveSession(null)
    if (boxId === undefined || !boxReady) return
    let cancelled = false
    ;(async () => {
      try {
        const [c, list] = await Promise.all([api.connection(boxId), api.boxSessions(boxId)])
        if (cancelled) return
        setConn(c)
        setSessions(list)
        setActiveSession(list[0]?.id ?? null)
      } catch (e: any) {
        if (!cancelled) setError(String(e.message))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [boxId, boxReady])

  const newTerminal = async (argv: string[]) => {
    if (!box) return
    try {
      // The pty is created at the size it will be displayed at.
      //
      // It used to be created at a fixed 100×30 and resized once the client
      // attached. By then the program had already drawn its first screen —
      // banners, box drawing, column layout — for a terminal a third the width
      // of the real one, and that output is in the scrollback for good. The
      // resize only ever fixed the *next* screen.
      const pane = paneRef.current?.getBoundingClientRect()
      const { cols, rows } = pane ? gridFor(pane.width, pane.height) : { cols: 100, rows: 30 }
      const created = await api.createTerminal(box.id, argv, cols, rows)
      const list = await api.boxSessions(box.id)
      setSessions(list)
      setActiveSession(created.id)
    } catch (e: any) {
      setError(String(e.message))
    }
  }

  // The daemon reports the size a session was created with, and the list is
  // read once at creation. Without this the sidebar keeps showing that first
  // number for the life of the session, however much the window has changed.
  const onTerminalResize = useCallback((cols: number, rows: number) => {
    setSessions(list => list.map(s => (s.id === activeSessionRef.current ? { ...s, cols, rows } : s)))
  }, [])

  const closeTerminal = async (sid: string) => {
    if (!box) return
    await api.killTerminal(box.id, sid).catch(() => {})
    const list = await api.boxSessions(box.id).catch(() => [])
    setSessions(list)
    if (activeSession === sid) setActiveSession(list[0]?.id ?? null)
  }

  /**
   * Building the machine back for a box that was reclaimed while idle.
   *
   * Leaves it selected rather than jumping away: the setup screen it lands on
   * is the same one a new box shows, and watching it come back is the point.
   */
  const wake = async (target: api.Box) => {
    setBusy(true)
    setError(null)
    try {
      await api.wakeBox(target.id)
      await refreshBoxes()
    } catch (e: any) {
      setError(String(e.message))
    }
    setBusy(false)
  }

  const sleepBox = async (target: api.Box) => {
    setBusy(true)
    setError(null)
    try {
      await api.sleepBox(target.id)
      setSleeping(null)
      await refreshBoxes()
    } catch (e: any) {
      setError(String(e.message))
    }
    setBusy(false)
  }

  const destroyBox = async (target: api.Box) => {
    setBusy(true)
    try {
      await api.destroyBox(target.id)
      setDestroying(null)
      // Off the destroyed box before the list refreshes, or the pane spends a
      // poll interval attached to a machine that is being torn down.
      setActiveBox(prev => (prev === target.id ? null : prev))
      await refreshBoxes()
    } catch (e: any) {
      setError(String(e.message))
    }
    setBusy(false)
  }

  return (
    <div className="workspace">
      {/*
        Off-canvas below 760px, in the flow above it. The scrim is what makes
        the drawer dismissable without a second gesture to learn, and it only
        exists while the drawer is open so it cannot swallow taps meant for the
        terminal.
      */}
      {drawer && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close the sidebar"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className={drawer ? "sidebar open" : "sidebar"}>
        <div className="sidebar-section">
          <div className="sidebar-head">
            <span>Boxes</span>
            <button type="button" className="icon" onClick={() => setWizard(true)} title="New box">
              <Plus size={15} />
            </button>
          </div>
          {boxes.length === 0 && <p className="muted small pad">No boxes yet.</p>}
          {boxes.map(b => (
            <div key={b.id} className={`row ${activeBox === b.id ? "on" : ""}`}>
              <button
                type="button"
                className="row-main"
                onClick={() => {
                  setActiveBox(b.id)
                  setDrawer(false)
                }}
              >
                {b.status === "asleep" ? (
                  <Moon size={13} className="dim" />
                ) : (
                  <Server size={13} className={b.status === "ready" ? "ok" : "pending"} />
                )}
                <span className="row-body">
                  <strong>{b.name}</strong>
                  <span className="muted small">{b.status === "ready" ? b.hostname : b.status}</span>
                </span>
              </button>
              {/* A box bills by the hour from the moment it exists, and until
                  now the only way to stop one was the DigitalOcean console —
                  which destroys the droplet without telling Devpipe, leaving a
                  row that still claims to be ready and a subscription still
                  held against it. */}
              {/* Beside destroy, and deliberately first: it is the reversible
                  one, and until now the only way to stop paying for a machine
                  before its idle window ran out was the one that is not. */}
              {b.status === "ready" && b.workspace_id !== null && (
                <button
                  type="button"
                  className="icon dim"
                  title={`Put ${b.name} to sleep`}
                  aria-label={`Put ${b.name} to sleep`}
                  onClick={() => setSleeping(b)}
                >
                  <Moon size={13} />
                </button>
              )}
              <button
                type="button"
                className="icon dim"
                title={`Destroy ${b.name}`}
                aria-label={`Destroy ${b.name}`}
                onClick={() => setDestroying(b)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-section grow">
          <div className="sidebar-head">
            <span>Terminals</span>
          </div>
          {!box && <p className="muted small pad">Pick a box.</p>}
          {box && box.status !== "ready" && (
            <p className="muted small pad">
              <Loader2 className="spin" size={12} /> {box.status_detail || "Setting up…"}
            </p>
          )}
          {box?.status === "ready" && sessions.length === 0 && <p className="muted small pad">No terminals open.</p>}
          {sessions.map(s => (
            <div key={s.id} className={`row ${activeSession === s.id ? "on" : ""}`}>
              <button
                type="button"
                className="row-main"
                onClick={() => {
                  setActiveSession(s.id)
                  setDrawer(false)
                }}
              >
                <CircleDot size={12} className={s.alive ? "ok" : "pending"} />
                <span className="row-body">
                  <strong>{s.title || commandOf(s.argv) || s.id}</strong>
                  <span className="muted small">
                    {s.id} · {s.cols}×{s.rows}
                  </span>
                </span>
              </button>
              <button type="button" className="icon dim" title="Close" onClick={() => closeTerminal(s.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>

        {box?.status === "ready" && <Previews boxId={box.id} ready={true} />}

        {box?.status === "ready" && (
          <div className="sidebar-foot">
            <button type="button" className="linkish" onClick={() => newTerminal([])}>
              + shell
            </button>
            <button type="button" className="linkish" onClick={() => newTerminal(["claude"])}>
              + claude
            </button>
          </div>
        )}
      </aside>

      <main className="stage">
        <div className="stage-bar">
          {/* Only rendered at all below the breakpoint, where the sidebar is a
              drawer over the terminal rather than beside it. */}
          <button
            type="button"
            className="icon drawer-toggle"
            aria-label="Boxes and terminals"
            onClick={() => setDrawer(d => !d)}
          >
            <Menu size={16} />
          </button>
          <span className="muted small">{box ? `${box.name} · ${box.hostname}` : "No box selected"}</span>
          <span className="grow" />
          {/* On the terminal rather than on the box: what you hand somebody is
              one session, not the machine it happens to be running on. */}
          {box?.status === "ready" && activeSession && (
            <button
              type="button"
              className="icon dim"
              title="Share this terminal"
              aria-label="Share this terminal"
              onClick={() => setSharing(activeSession)}
            >
              <Share2 size={15} />
            </button>
          )}
          <span className="muted small">{status}</span>
        </div>

        {/* Dismissible because it is set from a poll. A refresh that fails
            once leaves a banner that never clears, and the next thing the user
            does is reload a page that was working. */}
        {error && (
          <p className="note bad inline">
            <span className="grow">{error}</span>
            <button type="button" className="icon dim" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={13} />
            </button>
          </p>
        )}

        {/* Every state of the pane shares this box, which is what makes it
            safe to measure before a terminal is in it: the empty state a new
            session is started from is exactly the space that session will
            occupy. */}
        <div className="pane" ref={paneRef}>
          {conn && activeSession && !vtReady ? (
            // The emulator has to be in memory before a Terminal exists. This
            // used to be unguarded: `ready` was set and never read, so the view
            // mounted straight into `new Terminal()` and threw "loadVt() must
            // finish before a Terminal is created".
            //
            // It survived only because vt.wasm was served immutable and came
            // back from cache with no round trip, so the race almost always
            // won. Making the emulator revalidate — which it had to, or a new
            // build never reached anyone — widened the window and it started
            // losing every time: blank terminals on load, and a pane that
            // stayed frozen while input still reached the box.
            <div className="empty">
              <Loader2 className="spin" size={20} />
            </div>
          ) : conn && activeSession ? (
            <TerminalView
              url={conn.url}
              token={conn.token}
              sessionId={activeSession}
              onStatus={setStatus}
              onResize={onTerminalResize}
            />
          ) : box && box.status === "asleep" ? (
            // Reclaimed while idle. This screen exists so that reads as a thing
            // the product did on purpose rather than a box that went missing —
            // and the first thing it says is that the files are still there.
            <div className="empty">
              <Moon size={28} />
              <p>{box.name} is asleep.</p>
              <p className="muted small">
                It was not being used, so the machine was given back and stopped costing anything. Everything in your
                workspace is exactly where you left it.
              </p>
              <button type="button" disabled={busy} onClick={() => void wake(box)}>
                {busy ? "Waking…" : "Wake it up"}
              </button>
            </div>
          ) : box && box.status !== "ready" ? (
            // A box that is still building gets the whole pane. It is the only
            // thing happening, and it is the thing the user is waiting on.
            <BoxSetup boxId={box.id} status={box.status} />
          ) : (
            <div className="empty">
              {box?.status === "ready" ? (
                <>
                  <TerminalIcon size={28} />
                  <p>Open a terminal to get started.</p>
                  <button type="button" onClick={() => newTerminal(agents[0]?.launch ?? [])}>
                    {agents[0] ? `Start ${agents[0].name}` : "Open a shell"}
                  </button>
                </>
              ) : (
                <>
                  <Server size={28} />
                  <p>You do not have a box yet.</p>
                  <button type="button" onClick={() => setWizard(true)}>
                    Set one up
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {wizard && (
        <Wizard
          onClose={() => setWizard(false)}
          onCreated={id => {
            setWizard(false)
            setActiveBox(id)
            void refreshBoxes()
          }}
        />
      )}

      {sleeping && (
        <SleepBox
          box={sleeping}
          terminals={sleeping.id === activeBox ? sessions.length : 0}
          busy={busy}
          onCancel={() => setSleeping(null)}
          onConfirm={sleepBox}
        />
      )}

      {destroying && (
        <DestroyBox box={destroying} busy={busy} onCancel={() => setDestroying(null)} onConfirm={destroyBox} />
      )}

      {sharing && box && (
        <ShareTerminal
          boxId={box.id}
          sessionId={sharing}
          title={
            sessions.find(s => s.id === sharing)?.title ||
            commandOf(sessions.find(s => s.id === sharing)?.argv ?? []) ||
            sharing
          }
          onClose={() => setSharing(null)}
        />
      )}
    </div>
  )
}

/**
 * Confirming that a box should be put down.
 *
 * Lighter than the destroy dialog on purpose — no name to type — because this
 * is the reversible one and a confirmation heavy enough to be annoying pushes
 * people towards the button that is not. What it does say is the part that is
 * not obvious: the machine goes, the files stay, and coming back takes a few
 * minutes rather than being instant.
 */
const SleepBox: React.FC<{
  box: api.Box
  terminals: number
  busy: boolean
  onCancel: () => void
  onConfirm: (box: api.Box) => void
}> = ({ box, terminals, busy, onCancel, onConfirm }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Cancel" onClick={onCancel} />
      <dialog className="modal narrow" open aria-label={`Put ${box.name} to sleep`}>
        <header>
          <div>
            <h2>Put {box.name} to sleep</h2>
            <p className="muted">{box.hostname}</p>
          </div>
          <button type="button" className="icon" onClick={onCancel} aria-label="Cancel">
            <X size={18} />
          </button>
        </header>

        <div className="wizard-body">
          <p className="note">
            The machine is given back and stops being charged for by the hour. Your files stay on the workspace, and
            waking brings the box back with the same name and the same tools. It takes about three minutes.
          </p>
          {/* The part people actually lose. An agent working through a task is
              a process on that machine, and the machine is what goes. */}
          {terminals > 0 && (
            <p className="note warn">
              {terminals} terminal{terminals === 1 ? "" : "s"} {terminals === 1 ? "is" : "are"} open on it. Anything
              running in {terminals === 1 ? "it" : "them"} — an agent mid-task included — ends here.
            </p>
          )}
          <p className="muted small">
            Links you have made to its terminals stop working, because the sessions they point at will not survive the
            machine. Published ports keep working once it is back.
          </p>
        </div>

        <footer>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <span className="grow" />
          <button type="button" disabled={busy} onClick={() => onConfirm(box)}>
            {busy ? "Sleeping…" : "Put it to sleep"}
          </button>
        </footer>
      </dialog>
    </div>
  )
}

/**
 * Confirming the destruction of a box.
 *
 * The name has to be typed back. That is heavier than a yes/no, deliberately:
 * the machine and everything on it goes, the sessions running on it go with it,
 * and none of it is recoverable — there are no snapshots. The wizard stores the
 * tool selection so an identical box can be rebuilt, which is what makes this
 * survivable, but the files somebody was working on are not part of that.
 */
const DestroyBox: React.FC<{
  box: api.Box
  busy: boolean
  onCancel: () => void
  onConfirm: (box: api.Box) => void
}> = ({ box, busy, onCancel, onConfirm }) => {
  const [typed, setTyped] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Cancel" onClick={onCancel} />
      <dialog className="modal narrow" open aria-label={`Destroy ${box.name}`}>
        <header>
          <div>
            <h2>Destroy {box.name}</h2>
            <p className="muted">{box.hostname}</p>
          </div>
          <button type="button" className="icon" onClick={onCancel} aria-label="Cancel">
            <X size={18} />
          </button>
        </header>

        <div className="wizard-body">
          <p className="note warn">
            The machine is deleted along with everything on it, and every terminal running on it ends. This cannot be
            undone.
          </p>
          {/* The whole promise of a workspace is that this sentence stops being
              true of the work. Saying so here is the moment it matters. */}
          {box.workspace_id !== null && (
            <p className="note">
              Your workspace is detached, not deleted — anything under it survives this and can be mounted on the next
              box.
            </p>
          )}
          <p className="muted small">
            Any subscription covering it is freed for the next box — destroying does not cancel it. That happens in the
            billing portal.
          </p>
          <label className="field">
            <span>
              Type <strong>{box.name}</strong> to confirm
            </span>
            <input value={typed} onChange={e => setTyped(e.target.value)} autoCapitalize="none" spellCheck={false} />
          </label>
        </div>

        <footer>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <span className="grow" />
          <button type="button" className="danger" disabled={busy || typed !== box.name} onClick={() => onConfirm(box)}>
            {busy ? "Destroying…" : "Destroy this box"}
          </button>
        </footer>
      </dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

const away = async (get: () => Promise<{ url: string }>, fail: (message: string) => void) => {
  try {
    location.href = (await get()).url
  } catch (err: any) {
    fail(String(err.message))
  }
}

const Billing: React.FC = () => {
  const [data, setData] = useState<api.BillingStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [settling, setSettling] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.billingStatus())
    } catch (e: any) {
      setError(String(e.message))
    }
  }, [])

  useEffect(() => {
    const outcome = new URLSearchParams(location.search).get("checkout")
    if (!outcome) {
      void load()
      return
    }
    // Back to /billing, not to "/" — that is the lander, and rewriting the URL
    // to it meant a reload after paying left the customer looking at the
    // marketing page. Dropping the parameter is the point: it is a one-time
    // instruction, and keeping it would re-run the settle loop on every visit.
    history.replaceState({}, "", "/billing")
    if (outcome !== "done") {
      setNotice("Checkout cancelled. Nothing was charged.")
      void load()
      return
    }

    // Stripe sends the browser back and posts the webhook that records the
    // subscription independently, and the browser usually wins the race. So
    // this waits for the row rather than telling somebody who has just paid
    // that they have no subscription.
    let cancelled = false
    setSettling(true)
    void (async () => {
      const first = await api.billingStatus().catch(() => null)
      if (first && !cancelled) setData(first)
      const before = first?.subscriptions.length ?? 0
      for (let i = 0; i < 8 && !cancelled; i++) {
        await new Promise(r => setTimeout(r, 1500))
        const next = await api.billingStatus().catch(() => null)
        if (!next || cancelled) continue
        setData(next)
        if (next.subscriptions.length > before) break
      }
      if (cancelled) return
      setSettling(false)
      setNotice("Payment received.")
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  if (!data)
    return (
      <div className="page">{error ? <p className="note bad">{error}</p> : <Loader2 className="spin" size={16} />}</div>
    )

  return (
    <div className="page">
      <h1>Billing</h1>
      {settling && <p className="note ok">Payment received. Setting up your subscription.</p>}
      {notice && !settling && <p className="note ok">{notice}</p>}
      {error && <p className="note bad">{error}</p>}

      {!data.configured ? (
        <p className="note warn">This instance is not selling boxes. Nothing here is charged for.</p>
      ) : (
        <>
          <section className="card">
            <h2>Your subscriptions</h2>
            {data.subscriptions.length === 0 ? (
              <p className="muted small">Nothing yet. One subscription covers one box of the size it was bought at.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Covering</th>
                    <th>Renews</th>
                  </tr>
                </thead>
                <tbody>
                  {data.subscriptions.map(s => (
                    <tr key={s.id}>
                      <td>{s.label}</td>
                      <td>
                        <span className={`pill ${s.status === "active" ? "ok" : ""}`}>{s.status}</span>
                        {s.cancel_at_period_end && <span className="pill bad">ending</span>}
                      </td>
                      <td className="muted small">{s.box_id ? `box ${s.box_id}` : "nothing yet"}</td>
                      <td className="muted small">{s.current_period_end ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="note">
              Destroying a box frees its subscription for the next one. It does not cancel it — cancelling happens in
              the billing portal, and they are two separate actions.
            </p>
            <button type="button" className="ghost" onClick={() => void away(api.billingPortal, setError)}>
              Manage billing
            </button>
          </section>

          <section className="card">
            <h2>Sizes</h2>
            <div className="plan-grid">
              {data.plans.map(p => {
                const spare = data.can_create.includes(p.size)
                return (
                  <div key={p.size} className={`plan ${spare ? "on" : ""}`}>
                    <strong>{p.label}</strong>
                    <div className="price">
                      ${p.monthly}
                      <span>/month</span>
                    </div>
                    <span className="muted small">{spare ? "Covered — you can create this size now" : ""}</span>
                    <button type="button" onClick={() => void away(() => api.billingCheckout(p.size), setError)}>
                      Subscribe
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The half-second between clicking a private preview and seeing it.
 *
 * A preview is a separate origin, which is the point — it serves somebody's
 * half-written application and must not be able to touch this one. That also
 * means it cannot read the session this app holds, so this screen is the
 * handover: ask the API where the preview lives, hand that origin a cookie
 * using the session, and go.
 *
 * `to` comes back from the preview itself and is checked before it is used.
 * Anything not starting with a single slash is dropped — a redirect target
 * taken from a URL is an open redirect unless somebody says otherwise.
 */
const PreviewGate: React.FC<{ slug: string }> = ({ slug }) => {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const asked = new URLSearchParams(location.search).get("to") ?? "/"
    const to = asked.startsWith("/") && !asked.startsWith("//") ? asked : "/"
    ;(async () => {
      try {
        const { url } = await api.previewOrigin(slug)
        await api.grantPreview(url)
        if (!cancelled) location.replace(`${url}${to}`)
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message ?? err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">
          <TerminalIcon size={18} />
          <span>Devpipe</span>
        </div>
        {error ? (
          <>
            <p className="note bad">{error}</p>
            <button type="button" onClick={() => leave(HOME_PATH)}>
              Back to your runs
            </button>
          </>
        ) : (
          <p className="muted">
            <Loader2 className="spin" size={14} /> Opening that preview…
          </p>
        )}
      </div>
    </div>
  )
}

/** A plain navigation, for the one screen that has no router around it. */
const leave = (path: string) => {
  location.href = path
}

const App: React.FC = () => {
  const [signedIn, setSignedIn] = useState(api.isSignedIn())
  const [route, go] = useRoute()
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(location.search).get("token"))
  const [notice, setNotice] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  /** Why the emulator did not load, when it did not. Terminals need it; nothing else does. */
  const [vtError, setVtError] = useState<string | null>(null)
  // Read after `me()` has had a chance to refresh it, so a name changed on
  // another device — or an owner flag granted since sign-in — is reflected
  // rather than frozen at whatever the last sign-in wrote.
  const [user, setUser] = useState(api.currentUser)

  useEffect(() => {
    // The emulator has to be in memory before a terminal can be constructed;
    // loading it up front keeps every terminal from paying for it.
    //
    // The failure is kept rather than swallowed. Carrying on as if the load
    // had worked meant the next thing to happen was a Terminal constructor
    // throwing "loadVt() must finish before a Terminal is created" — which is
    // true, and says nothing about *why*, and sent me looking at the render
    // path when the real answer was a cached emulator that no longer had the
    // exports this build needs. The rest of the app still works without it;
    // only terminals do not.
    // Not on a shared terminal: that screen loads the emulator itself, and
    // both doing it means the same 350KB fetched twice on the one view that is
    // most often opened on somebody's phone.
    if (route.view === "watch") return
    loadVt()
      .then(() => setReady(true))
      .catch(err => {
        console.error("[devpipe] the terminal emulator did not load:", err)
        setVtError(String(err?.message ?? err))
        setReady(true)
      })
  }, [route.view])

  useEffect(() => {
    if (!signedIn) return
    api
      .me()
      .then(out => setUser(out.user))
      .catch(() => setSignedIn(false))
  }, [signedIn])

  // An unrecognised path renders the workspace, so the address bar has to be
  // told — otherwise /wat stays in it, gets bookmarked, and is a link that only
  // works by accident. Skipped while a reset token is present: that flow owns
  // the URL until it is done with it.
  useEffect(() => {
    if (resetToken) return
    const canonical = href(route)
    if (location.pathname !== canonical) history.replaceState({}, "", canonical)
  }, [route, resetToken])

  // Ahead of everything, session check included: a shared terminal is opened
  // by somebody who does not have an account here and is not about to make one
  // to look at a link they were sent.
  if (route.view === "watch" && route.slug) return <Watch token={route.slug} />

  // Ahead of the session check: a reset link is most often clicked by someone
  // who is signed in somewhere else, and the reset ends that session anyway.
  if (resetToken) {
    return (
      <Reset
        token={resetToken}
        onDone={message => {
          setResetToken(null)
          setSignedIn(false)
          setNotice(message)
        }}
      />
    )
  }
  if (!signedIn) return <Gate notice={notice} onDone={() => setSignedIn(true)} />
  if (route.view === "preview" && route.slug) return <PreviewGate slug={route.slug} />
  if (!ready) {
    return (
      <div className="gate">
        <Loader2 className="spin" size={20} />
      </div>
    )
  }

  const to = (view: Route["view"]) => () => go({ view, tab: route.tab })

  return (
    <div className="app">
      <nav className="topbar">
        <button type="button" className="brand" onClick={to("runs")}>
          <Activity size={16} />
          <span>Devpipe</span>
        </button>
        <span className="grow" />
        {/* The order is the argument. Runs is the app; the machine — its
            terminals, its ports, its build log — is where you go when a run
            needs a person, which is why it reads as a place rather than as
            the way back. */}
        <button type="button" className={`ghost small ${route.view === "runs" ? "on" : ""}`} onClick={to("runs")}>
          <Activity size={14} /> Runs
        </button>
        <button
          type="button"
          className={`ghost small ${route.view === "workspace" ? "on" : ""}`}
          onClick={to("workspace")}
        >
          <TerminalIcon size={14} /> Machine
        </button>
        {user?.is_owner && (
          <button type="button" className={`ghost small ${route.view === "admin" ? "on" : ""}`} onClick={to("admin")}>
            <Shield size={14} /> Admin
          </button>
        )}
        <button type="button" className={`ghost small ${route.view === "vault" ? "on" : ""}`} onClick={to("vault")}>
          <KeyRound size={14} /> Vault
        </button>
        <button type="button" className={`ghost small ${route.view === "billing" ? "on" : ""}`} onClick={to("billing")}>
          <CreditCard size={14} /> Billing
        </button>
        <button
          type="button"
          className={`ghost small ${route.view === "settings" ? "on" : ""}`}
          onClick={to("settings")}
        >
          <SettingsIcon size={14} /> Settings
        </button>
        <button
          type="button"
          className="ghost small"
          aria-label="Sign out"
          onClick={async () => {
            await api.logout()
            setUser(null)
            setSignedIn(false)
            // Back to the home path so the next sign-in does not land on the
            // admin screen the previous account was looking at.
            go({ view: "runs", tab: "overview" }, { replace: true })
          }}
        >
          <LogOut size={14} />
        </button>
      </nav>

      {/* Said once, at the top, rather than left for a Terminal constructor to
          discover. The usual cause is a cached emulator older than this build,
          and "reload" is genuinely the fix — so it says so instead of showing
          a stack trace about a constructor. */}
      {vtError && (
        <p className="note bad inline">
          <span className="grow">
            The terminal emulator did not load, so terminals cannot open. A reload usually fixes it. ({vtError})
          </span>
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      )}
      {route.view === "runs" && <Runs onBack={() => go({ view: "workspace", tab: "overview" })} />}
      {route.view === "workspace" && <Workspace vtReady={ready} />}
      {route.view === "billing" && <Billing />}
      {route.view === "vault" && <Vault />}
      {route.view === "settings" && <Settings onSaved={setUser} />}
      {route.view === "admin" && <Admin tab={route.tab} onTab={tab => go({ view: "admin", tab })} />}
    </div>
  )
}

// Before the first paint, so the runs view never renders light on a dark
// machine and then corrects itself a frame later.
applyTheme(getTheme())

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  )
