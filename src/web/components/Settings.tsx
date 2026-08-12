import { HardDrive, Loader2, Monitor } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"

/** The signed-in user's own account: profile, password, and signed-in devices. */
export const Settings: React.FC<{ onSaved?: (user: api.User) => void }> = ({ onSaved }) => {
  const user = api.currentUser()
  const [name, setName] = useState(user?.name ?? "")
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.listSessions>>>([])
  const [workspaces, setWorkspaces] = useState<api.Workspace[]>([])
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [typed, setTyped] = useState("")
  const [loading, setLoading] = useState(true)

  const refreshWorkspaces = useCallback(
    () =>
      api
        .listWorkspaces()
        .then(setWorkspaces)
        .catch(() => {}),
    [],
  )

  const refresh = useCallback(
    () =>
      api
        .listSessions()
        .then(setSessions)
        .catch(() => {})
        .finally(() => setLoading(false)),
    [],
  )

  useEffect(() => {
    void refresh()
    void refreshWorkspaces()
  }, [refresh, refreshWorkspaces])

  /**
   * Deleting a workspace, which is the only way to stop paying for one.
   *
   * The name is typed back, as it is for destroying a box: this is the storage
   * that was kept precisely so a box could be destroyed without losing it, and
   * it is the last copy. The server refuses while a box holds it, and says
   * which one.
   */
  const removeWorkspace = async (w: api.Workspace) => {
    try {
      await api.deleteWorkspace(w.id)
      setNote({ kind: "ok", text: `Deleted ${w.name}.` })
      setConfirming(null)
      setTyped("")
      void refreshWorkspaces()
    } catch (err: any) {
      setNote({ kind: "bad", text: String(err.message) })
    }
  }

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      // Handed back up so the shell re-renders from the saved user rather than
      // from the copy it read when it mounted.
      onSaved?.(await api.updateProfile(name))
      setNote({ kind: "ok", text: "Saved." })
    } catch (err: any) {
      setNote({ kind: "bad", text: String(err.message) })
    }
  }

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.changePassword(current, next)
      setCurrent("")
      setNext("")
      setNote({ kind: "ok", text: "Password changed. Other devices were signed out." })
      void refresh()
    } catch (err: any) {
      setNote({ kind: "bad", text: String(err.message) })
    }
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      {note && <p className={`note ${note.kind === "bad" ? "bad" : "ok"}`}>{note.text}</p>}

      <section className="card">
        <h2>Profile</h2>
        <form onSubmit={saveProfile}>
          <label className="field">
            <span>Email</span>
            <input value={user?.email ?? ""} disabled />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={user?.username ?? ""} disabled />
            <small className="muted">Boxes are named from this, so it does not change.</small>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} />
          </label>
          <button type="submit">Save</button>
        </form>
      </section>

      <section className="card">
        <h2>Password</h2>
        <form onSubmit={savePassword}>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={next}
              onChange={e => setNext(e.target.value)}
              autoComplete="new-password"
              required
            />
            <small className="muted">At least 12 characters. Changing it signs out every other device.</small>
          </label>
          <button type="submit">Change password</button>
        </form>
      </section>

      <section className="card">
        <h2>Workspaces</h2>
        <p className="muted small">
          Storage that outlives a box. A workspace is charged from the moment it exists, whether or not a box is using
          it — deleting it here is the only thing that stops that.
        </p>
        {workspaces.length === 0 ? (
          <p className="muted small">
            None yet. Add one while setting up a box, and the work on it survives destroying that box.
          </p>
        ) : (
          <table>
            <tbody>
              {workspaces.map(w => (
                <tr key={w.id}>
                  <td>
                    <HardDrive size={13} />
                  </td>
                  <td>
                    <div>{w.name}</div>
                    <div className="muted small">
                      {w.size_gb} GB · {w.region} ·{" "}
                      {w.attached_to !== null ? "in use by a box" : "not attached to anything"}
                    </div>
                  </td>
                  <td className="right">
                    {confirming === w.id ? (
                      <span className="confirm-inline">
                        <input
                          value={typed}
                          onChange={e => setTyped(e.target.value)}
                          placeholder={w.name}
                          aria-label={`Type ${w.name} to confirm`}
                          autoCapitalize="none"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="danger small"
                          disabled={typed.trim() !== w.name}
                          onClick={() => void removeWorkspace(w)}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => {
                            setConfirming(null)
                            setTyped("")
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => {
                          setConfirming(w.id)
                          setTyped("")
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Signed in devices</h2>
        {loading && <Loader2 className="spin" size={14} />}
        <table>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id}>
                <td>
                  <Monitor size={13} />
                </td>
                <td>
                  <div>{s.user_agent?.slice(0, 60) || "Unknown device"}</div>
                  <div className="muted small">
                    {s.ip || "no address"} · last seen {when(s.last_seen_at)}
                  </div>
                </td>
                <td className="right">
                  {s.current ? (
                    <span className="muted small">This device</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={async () => {
                        await api.revokeSession(s.id)
                        void refresh()
                      }}
                    >
                      Sign out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length > 1 && (
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await api.revokeOtherSessions()
              void refresh()
            }}
          >
            Sign out everywhere else
          </button>
        )}
      </section>
    </div>
  )
}
